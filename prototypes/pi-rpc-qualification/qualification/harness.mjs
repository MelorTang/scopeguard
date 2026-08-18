import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  extensionArgs,
  loadExtensionComposition,
} from "../extension-composition.mjs";
import { startFakeProvider } from "../fake-provider.mjs";
import { RpcProcess } from "../rpc-process.mjs";
import { assertSuccess } from "./assertions.mjs";
import { EvidenceRecorder } from "./evidence.mjs";

const execFileAsync = promisify(execFile);
const SECRET = "qualification-secret-never-persist";

function cleanEnvironment(configDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    if (/^(HTTP|HTTPS|ALL)_PROXY$/i.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PI_CODING_AGENT_DIR: configDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    SCOPEGUARD_PI_FAKE_KEY: SECRET,
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export class QualificationHarness {
  constructor(root) {
    this.root = root;
    this.cliPath = path.join(
      root,
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    );
    this.packageJsonPath = path.join(
      root,
      "node_modules/@earendil-works/pi-coding-agent/package.json",
    );
    this.contractPath = path.join(root, "fixtures/expected-contract.json");
    this.manifestPath = path.join(root, "fixtures/extension-manifest.json");
    this.protocolFailureFixturePath = path.join(
      root,
      "fixtures/protocol-failure-child.mjs",
    );
    this.secret = SECRET;
    this.clients = new Set();
    this.extensionProfiles = new Map();
    this.evidence = new EvidenceRecorder();
  }

  async initialize() {
    assert.ok(existsSync(this.cliPath), `Pi CLI missing: ${this.cliPath}`);
    this.packageJson = JSON.parse(await readFile(this.packageJsonPath, "utf8"));
    this.contract = JSON.parse(await readFile(this.contractPath, "utf8"));
    assert.equal(this.packageJson.name, this.contract.package);
    assert.equal(this.packageJson.version, this.contract.version);
    assert.equal(this.packageJson.license, "MIT");

    for (const profile of ["production", "mutator-test", "unknown-tool-test"]) {
      this.extensionProfiles.set(
        profile,
        await loadExtensionComposition({
          manifestPath: this.manifestPath,
          root: this.root,
          profile,
        }),
      );
    }

    this.tempRoot = await mkdtemp(path.join(os.tmpdir(), "scopeguard-pi-rpc-"));
    this.configDir = path.join(this.tempRoot, "config");
    this.workspace = path.join(this.tempRoot, "workspace");
    this.sessions = path.join(this.tempRoot, "sessions");
    await Promise.all([
      mkdir(this.configDir),
      mkdir(this.workspace),
      mkdir(this.sessions),
    ]);

    this.provider = await startFakeProvider({ expectedKey: SECRET });
    await writeFile(
      path.join(this.configDir, "models.json"),
      `${JSON.stringify(
        {
          providers: {
            "scopeguard-fake": {
              baseUrl: `${this.provider.baseUrl}/v1`,
              api: "openai-completions",
              apiKey: "$SCOPEGUARD_PI_FAKE_KEY",
              authHeader: true,
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
              models: [
                {
                  id: "qualification-model",
                  name: "ScopeGuard Qualification Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 16_384,
                  maxTokens: 1_024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(this.configDir, "settings.json"),
      `${JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1_000 } }, null, 2)}\n`,
    );
    this.env = cleanEnvironment(this.configDir);
    this.version = (
      await execFileAsync(process.execPath, [this.cliPath, "--version"], {
        env: this.env,
      })
    ).stdout.trim();
    assert.equal(this.version, this.contract.version);
    return this;
  }

  clientArgs(
    sessionDir,
    { extra = [], extensionProfile = "production", tools } = {},
  ) {
    const extensions = this.extensionProfiles.get(extensionProfile);
    assert.ok(extensions, `extension profile not loaded: ${extensionProfile}`);
    return [
      "--provider",
      "scopeguard-fake",
      "--model",
      "qualification-model",
      "--session-dir",
      sessionDir,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      ...extensionArgs(extensions),
      "--no-approve",
      "--offline",
      "--tools",
      tools ?? "read,bash,write,edit",
      ...extra,
    ];
  }

  async startClient(
    label,
    { sessionName = label, extra, extensionProfile, tools, envOverrides } = {},
  ) {
    const sessionDir = path.join(this.sessions, sessionName);
    await mkdir(sessionDir, { recursive: true });
    const client = new RpcProcess({
      cliPath: this.cliPath,
      cwd: this.workspace,
      env: { ...this.env, ...envOverrides },
      args: this.clientArgs(sessionDir, { extra, extensionProfile, tools }),
      label,
      redactValues: [SECRET],
    });
    this.clients.add(client);
    await client.start();
    const state = assertSuccess(
      await client.send({ type: "get_state" }),
      "get_state",
    );
    assert.equal(state.model.provider, "scopeguard-fake");
    assert.equal(state.model.id, "qualification-model");
    assertSuccess(
      await client.send({ type: "set_auto_retry", enabled: false }),
      "set_auto_retry",
    );
    assertSuccess(
      await client.send({ type: "set_auto_compaction", enabled: false }),
      "set_auto_compaction",
    );
    return { client, state };
  }

  async runPrompt(client, message, timeoutMs = 20_000) {
    const mark = client.mark();
    assertSuccess(
      await client.send({ type: "prompt", message }, 10_000),
      "prompt",
    );
    await client.waitForSettled(mark, timeoutMs);
    return client.records.slice(mark);
  }

  async closeClient(client) {
    if (!this.clients.has(client)) return null;
    const exit = await client.gracefulShutdown();
    this.clients.delete(client);
    return exit;
  }

  forgetClient(client) {
    this.clients.delete(client);
  }

  record(name, classification, evidence) {
    this.evidence.record(name, classification, evidence);
  }

  async cleanupSuccess() {
    assert.equal(this.clients.size, 0, "scenario left a Pi process open");
    await this.provider.close();
    this.provider = null;
    await rm(this.tempRoot, { recursive: true, force: true });
    assert.equal(existsSync(this.tempRoot), false);
  }

  async cleanupFailure() {
    for (const client of this.clients) {
      await client.kill("SIGKILL").catch(() => {});
    }
    this.clients.clear();
    if (this.provider) await this.provider.close().catch(() => {});
    if (this.tempRoot) {
      await rm(this.tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  runtimeSummary() {
    return {
      package: `${this.packageJson.name}@${this.packageJson.version}`,
      license: this.packageJson.license,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    };
  }
}
