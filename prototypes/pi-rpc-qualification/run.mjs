import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startFakeProvider } from "./fake-provider.mjs";
import { classifyRpcRecord, RpcProcess } from "./rpc-process.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const cliPath = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const packageJsonPath = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/package.json");
const contractPath = path.join(here, "fixtures/expected-contract.json");
const SECRET = "qualification-secret-never-persist";

const results = [];
const clients = new Set();
let tempRoot;
let provider;

function record(name, classification, evidence) {
  results.push({ name, classification, evidence });
  process.stdout.write(`PASS ${name}: ${evidence}\n`);
}

function assertSuccess(response, command) {
  assert.equal(response.type, "response");
  assert.equal(response.command, command);
  assert.equal(response.success, true, response.error);
  return response.data;
}

function eventKey(record) {
  if (record.type !== "message_update") return record.type;
  return `message_update:${record.assistantMessageEvent?.type ?? "unknown"}`;
}

function assertSubsequence(actual, expected) {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) index += 1;
  }
  assert.equal(index, expected.length, `missing ordered event ${expected[index]} in ${actual.join(", ")}`);
}

async function runPrompt(client, message, timeoutMs = 20_000) {
  const mark = client.mark();
  assertSuccess(await client.send({ type: "prompt", message }, 10_000), "prompt");
  await client.waitForSettled(mark, timeoutMs);
  return client.records.slice(mark);
}

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

function clientArgs(sessionDir, extra = []) {
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
    "--no-approve",
    "--offline",
    "--tools",
    "read,bash",
    ...extra,
  ];
}

async function startClient(label, env, workspace, sessionDir, extra = []) {
  await mkdir(sessionDir, { recursive: true });
  const client = new RpcProcess({
    cliPath,
    cwd: workspace,
    env,
    args: clientArgs(sessionDir, extra),
    label,
  });
  clients.add(client);
  await client.start();
  const state = assertSuccess(await client.send({ type: "get_state" }), "get_state");
  assert.equal(state.model.provider, "scopeguard-fake");
  assert.equal(state.model.id, "qualification-model");
  assertSuccess(await client.send({ type: "set_auto_retry", enabled: false }), "set_auto_retry");
  assertSuccess(await client.send({ type: "set_auto_compaction", enabled: false }), "set_auto_compaction");
  return { client, state };
}

async function closeClient(client) {
  if (!clients.has(client)) return null;
  const exit = await client.gracefulShutdown();
  clients.delete(client);
  return exit;
}

async function filesBelow(root) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) found.push(target);
    }
  }
  await visit(root);
  return found;
}

async function main() {
  assert.ok(existsSync(cliPath), `Pi CLI missing: ${cliPath}`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  assert.equal(packageJson.name, contract.package);
  assert.equal(packageJson.version, contract.version);
  assert.equal(packageJson.license, "MIT");

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "scopeguard-pi-rpc-"));
  const configDir = path.join(tempRoot, "config");
  const workspace = path.join(tempRoot, "workspace");
  const sessions = path.join(tempRoot, "sessions");
  await Promise.all([mkdir(configDir), mkdir(workspace), mkdir(sessions)]);

  provider = await startFakeProvider({ expectedKey: SECRET });
  await writeFile(
    path.join(configDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "scopeguard-fake": {
            baseUrl: `${provider.baseUrl}/v1`,
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
    path.join(configDir, "settings.json"),
    `${JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1_000 } }, null, 2)}\n`,
  );
  const env = cleanEnvironment(configDir);

  const version = (await execFileAsync(process.execPath, [cliPath, "--version"], { env })).stdout.trim();
  assert.equal(version, contract.version);

  const ready = await startClient("ready", env, workspace, path.join(sessions, "ready"));
  const initialReadySessionId = ready.state.sessionId;
  const versionProbe = await ready.client.send({ type: "get_protocol_version" });
  assert.equal(versionProbe.success, false);
  assert.match(versionProbe.error, /Unknown command/);
  const createdSession = assertSuccess(await ready.client.send({ type: "new_session" }), "new_session");
  assert.equal(createdSession.cancelled, false);
  const createdState = assertSuccess(await ready.client.send({ type: "get_state" }), "get_state");
  assert.notEqual(createdState.sessionId, initialReadySessionId);
  const readyExit = await closeClient(ready.client);
  assert.deepEqual({ code: readyExit.code, signal: readyExit.signal }, { code: 0, signal: null });
  record(
    "process-ready-shutdown",
    "lossy",
    `CLI ${version}; readiness is get_state because RPC has no handshake/version command; stdin EOF exits 0`,
  );
  record("session-create", "exact", "new_session returned cancelled=false and get_state exposed a new sessionId");

  const terminated = await startClient("terminated", env, workspace, path.join(sessions, "terminated"));
  const terminatedExit = await terminated.client.kill("SIGTERM");
  clients.delete(terminated.client);
  assert.equal(terminatedExit.code, 143);
  assert.equal(terminatedExit.signal, null);
  record("host-termination", "lossy", "Pi handles SIGTERM as numeric exit 143 without a shutdown acknowledgement");

  const crash = await startClient("crash", env, workspace, path.join(sessions, "crash"));
  const crashExit = await crash.client.kill("SIGKILL");
  clients.delete(crash.client);
  assert.equal(crashExit.code, null);
  assert.equal(crashExit.signal, "SIGKILL");
  record("unexpected-crash", "exact", "transport distinguishes SIGKILL from normal exit and retains sanitized stderr");

  const stream = await startClient("stream", env, workspace, path.join(sessions, "stream"));
  const streamRecords = await runPrompt(stream.client, "[stream] hello\u2028world");
  const streamKeys = streamRecords.filter((item) => item.type !== "response").map(eventKey);
  assertSubsequence(streamKeys, contract.knownTextOrder);
  const streamedText = streamRecords
    .filter((item) => item.type === "message_update" && item.assistantMessageEvent?.type === "text_delta")
    .map((item) => item.assistantMessageEvent.delta)
    .join("");
  assert.equal(streamedText, "echo:[stream] hello\u2028world");
  await closeClient(stream.client);
  record("streaming-text-order", "exact", "strict LF JSONL preserved U+2028 and ordered start/delta/end/settled events");

  for (const scenario of [
    { label: "tool-success", prompt: "[tool-success]", expectedError: false },
    { label: "tool-error", prompt: "[tool-error]", expectedError: true },
  ]) {
    const started = await startClient(scenario.label, env, workspace, path.join(sessions, scenario.label));
    const providerRequestMark = provider.requests.length;
    const toolRecords = await runPrompt(started.client, scenario.prompt);
    assertSubsequence(toolRecords.map(eventKey), contract.knownToolCallOrder);
    const toolStart = toolRecords.find((item) => item.type === "tool_execution_start");
    const toolEnd = toolRecords.find((item) => item.type === "tool_execution_end");
    assert.ok(toolStart);
    assert.ok(toolEnd);
    assert.equal(toolEnd.toolCallId, toolStart.toolCallId);
    assert.equal(toolEnd.isError, scenario.expectedError);
    assert.ok(provider.requests.slice(providerRequestMark).some((request) => request.toolMessageCount > 0));
    await closeClient(started.client);
    record(
      scenario.label,
      "exact",
      `${toolStart.toolName} correlated by ${toolStart.toolCallId}; result isError=${toolEnd.isError}`,
    );
  }

  const providerError = await startClient("provider-error", env, workspace, path.join(sessions, "provider-error"));
  const errorRecords = await runPrompt(providerError.client, "[http-error]", 20_000);
  const errorMessage = errorRecords.find(
    (item) => item.type === "message_end" && item.message?.role === "assistant" && item.message?.stopReason === "error",
  );
  assert.ok(errorMessage, "provider HTTP failure did not become an assistant error message");
  assert.match(errorMessage.message.errorMessage ?? "", /503|qualification protocol failure/);
  await closeClient(providerError.client);
  record("provider-protocol-error", "exact", "accepted prompt fails through assistant error event and still reaches agent_settled");

  const persisted = await startClient("persist", env, workspace, path.join(sessions, "persist"));
  await runPrompt(persisted.client, "[persist-marker]");
  const persistedState = assertSuccess(await persisted.client.send({ type: "get_state" }), "get_state");
  assert.ok(persistedState.sessionFile);
  assert.ok(existsSync(persistedState.sessionFile));
  const sessionLocator = persistedState.sessionFile;
  const sessionId = persistedState.sessionId;
  const sessionHeader = JSON.parse((await readFile(sessionLocator, "utf8")).split("\n", 1)[0]);
  assert.equal(sessionHeader.version, 3);
  await closeClient(persisted.client);

  const resumed = await startClient(
    "resume",
    env,
    workspace,
    path.join(sessions, "persist"),
    ["--session", sessionLocator],
  );
  const resumedState = assertSuccess(await resumed.client.send({ type: "get_state" }), "get_state");
  assert.equal(resumedState.sessionId, sessionId);
  await runPrompt(resumed.client, "[resume-check]");
  const resumedText = assertSuccess(
    await resumed.client.send({ type: "get_last_assistant_text" }),
    "get_last_assistant_text",
  ).text;
  assert.equal(resumedText, "resume-ok");
  record(
    "session-resume",
    "exact",
    "opaque sessionFile/sessionId and Pi session format v3 survived process exit; prior history reached the provider",
  );

  await runPrompt(resumed.client, "[long-context] one");
  await runPrompt(resumed.client, "[long-context] two");
  const compactMark = resumed.client.mark();
  const compactResponse = await resumed.client.send(
    { type: "compact", customInstructions: "SCOPEGUARD_COMPACT_SUMMARY" },
    20_000,
  );
  const compactResult = assertSuccess(compactResponse, "compact");
  const compactRecords = resumed.client.records.slice(compactMark);
  assert.ok(compactRecords.some((item) => item.type === "compaction_start"));
  const compactionEnd = compactRecords.find((item) => item.type === "compaction_end");
  assert.ok(compactionEnd);
  assert.equal(compactionEnd.aborted, false);
  assert.match(compactResult.summary, /QUALIFICATION_COMPACTION_SUMMARY/);
  const entries = assertSuccess(await resumed.client.send({ type: "get_entries" }), "get_entries").entries;
  assert.ok(entries.some((entry) => entry.type === "compaction"));
  await closeClient(resumed.client);

  const compacted = await startClient(
    "post-compaction-resume",
    env,
    workspace,
    path.join(sessions, "persist"),
    ["--session", sessionLocator],
  );
  await runPrompt(compacted.client, "[after-compaction]");
  const afterCompaction = assertSuccess(
    await compacted.client.send({ type: "get_last_assistant_text" }),
    "get_last_assistant_text",
  ).text;
  assert.equal(afterCompaction, "after-compaction-ok");
  await closeClient(compacted.client);
  record(
    "manual-compaction-resume",
    "exact",
    "compaction_start/end and Pi compaction entry persisted; process restart by opaque locator continued successfully",
  );

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      startClient(`concurrent-${index}`, env, workspace, path.join(sessions, `concurrent-${index}`)),
    ),
  );
  const ids = new Set(concurrent.map(({ state }) => state.sessionId));
  assert.equal(ids.size, 4);
  const marks = concurrent.map(({ client }) => client.mark());
  await Promise.all([
    concurrent[0].client.send({ type: "prompt", message: "[interrupt-effect]" }),
    ...concurrent.slice(1).map(({ client }, index) =>
      client.send({ type: "prompt", message: `[slow-text] peer-${index + 1}` }),
    ),
  ]);
  await concurrent[0].client.waitFor((item) => item.type === "tool_execution_start", {
    after: marks[0],
    description: "interrupt target tool start",
  });
  const effectPath = path.join(workspace, "effect-marker.txt");
  for (let attempt = 0; attempt < 50 && !existsSync(effectPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(effectPath), "effect marker was not created before abort");
  assertSuccess(await concurrent[0].client.send({ type: "abort" }), "abort");
  await Promise.all(concurrent.map(({ client }, index) => client.waitForSettled(marks[index], 25_000)));
  const effectContent = await readFile(effectPath, "utf8");
  assert.equal(effectContent, "started");
  for (const { client } of concurrent.slice(1)) {
    const peerText = assertSuccess(
      await client.send({ type: "get_last_assistant_text" }),
      "get_last_assistant_text",
    ).text;
    assert.match(peerText, /^slow-complete:/);
  }
  for (const { client } of concurrent) await closeClient(client);
  record("four-session-targeted-abort", "exact", "four session ids stayed independent; only target stopped and three peers settled");
  record(
    "interrupted-tool-effect",
    "lossy",
    "Pi reports an aborted run, but the observed partial file effect proves absence/completion cannot be inferred; map to effect_unknown",
  );

  const invalidModel = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "--mode",
      "rpc",
      "--provider",
      "scopeguard-fake",
      "--model",
      "definitely-missing-model",
      "--no-session",
      "--offline",
    ],
    { cwd: workspace, env, timeout: 5_000 },
  ).catch((error) => ({ error, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  assert.ok(invalidModel.error, "invalid model unexpectedly started");
  assert.match(invalidModel.stderr, /model|resolve|not found/i);
  record("model-configuration-error", "exact", "invalid model exits non-zero with stderr before RPC readiness");

  assert.equal(classifyRpcRecord(contract.syntheticUnknownRecord), "unknown");
  assert.deepEqual(contract.syntheticUnknownRecord.payload, { retained: true });
  record("unknown-event-policy", "unsupported", "client preserves an unknown record but cannot assign product semantics without a versioned adapter update");

  assert.ok(provider.requests.length > 0);
  assert.ok(provider.requests.every((request) => request.authOk));
  assert.ok(provider.requests.every((request) => request.model === "qualification-model"));
  const files = await filesBelow(tempRoot);
  for (const file of files) {
    const content = await readFile(file).catch(() => Buffer.alloc(0));
    assert.equal(content.includes(Buffer.from(SECRET)), false, `secret persisted in ${file}`);
  }
  record("provider-credential-boundary", "lossy", "env-injected fake key reached only the provider; temp config/session files contained no secret");

  await provider.close();
  provider = null;
  await rm(tempRoot, { recursive: true, force: true });
  assert.equal(existsSync(tempRoot), false);
  record("temporary-state-cleanup", "exact", "all child processes, provider, profile, workspace, and sessions removed");

  const summary = {
    package: `${packageJson.name}@${packageJson.version}`,
    license: packageJson.license,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    checks: results.length,
    exact: results.filter((item) => item.classification === "exact").length,
    lossy: results.filter((item) => item.classification === "lossy").length,
    unsupported: results.filter((item) => item.classification === "unsupported").length,
    result: "qualification-complete",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`FAIL pi-rpc-qualification: ${error.stack ?? error}\n`);
  for (const client of clients) {
    await client.kill("SIGKILL").catch(() => {});
  }
  if (provider) await provider.close().catch(() => {});
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});
