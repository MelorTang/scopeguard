import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import {
  terminateProcessTree,
  waitForProcessTree,
} from "../dist/main/pilot-process-tree.js";
import { assertDesktopPilotLaunchAllowed } from "../dist/main/pilot-safe-storage.js";
import { startPiRuntimeFakeProvider } from "./pi-runtime-fake-provider.mjs";

assertDesktopPilotLaunchAllowed(process.platform);

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = process.env.SCOPEGUARD_PILOT_STAGE_ROOT
  ? resolve(process.env.SCOPEGUARD_PILOT_STAGE_ROOT)
  : null;
const applicationRoot = stageRoot ?? desktopRoot;
const root = await mkdtemp(join(tmpdir(), "scopeguard-desktop-pi-pilot-"));
const workspaceRoot = join(root, "workspace");
const userDataRoot = join(root, "user-data");
const statePath = join(root, "pilot-state.json");
const secret = "desktop-pilot-secret";
const pilotStorageKey = randomBytes(32).toString("base64url");
const provider = await startPiRuntimeFakeProvider(secret);
const activeDesktopProcesses = new Set();

try {
  await mkdir(workspaceRoot);
  const firstOutput = await launchDesktop(1, {
    SCOPEGUARD_DESKTOP_PILOT_API_KEY: secret,
  });
  const first = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(first.phase, 1);
  assert.equal(first.messageCount, 2);
  assert.match(firstOutput, /ScopeGuard Desktop Pilot phase 1 complete/);

  const credentialPath = join(userDataRoot, "credentials", "providers.json");
  const encryptedCredentials = await readFile(credentialPath);
  assert.equal(encryptedCredentials.includes(Buffer.from(secret)), false);
  assert.equal(encryptedCredentials.includes(Buffer.from(pilotStorageKey)), false);

  const secondOutput = await launchDesktop(2);
  const second = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(second.phase, 2);
  assert.equal(second.messageCount, 4);
  assert.match(secondOutput, /ScopeGuard Desktop Pilot phase 2 complete/);
  assert.notEqual(second.mainPid, first.mainPid);
  assert.notEqual(second.agentHostPid, first.agentHostPid);
  assert.deepEqual(second.locator, first.locator);

  const finalRequest = provider.requests.at(-1);
  assert.deepEqual(finalRequest?.userTexts, ["first-turn", "second-turn"]);
  assert.equal(provider.requests.every((request) => request.authorized), true);
  console.log(JSON.stringify({
    checks: 15,
    mode: stageRoot ? "staged" : "development",
    electronVersion: "42.0.1",
    piVersion: second.locator.piVersion,
    firstMainPid: first.mainPid,
    secondMainPid: second.mainPid,
    firstAgentHostPid: first.agentHostPid,
    secondAgentHostPid: second.agentHostPid,
    sessionId: second.locator.sessionId,
    messagesAfterRestart: second.messageCount,
    providerObservedHistory: finalRequest.userTexts,
    credentialRecoveredFromDiskVault: true,
    pilotStorage: "aes-256-gcm",
    electronCredentialStoreMode: pilotCredentialStoreMode(),
  }));
} finally {
  for (const child of activeDesktopProcesses) {
    await terminateProcessTree(child);
    activeDesktopProcesses.delete(child);
  }
  await provider.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
}

async function launchDesktop(phase, extraEnvironment = {}) {
  const environment = {
    ...process.env,
    SCOPEGUARD_DESKTOP_PILOT_PHASE: String(phase),
    SCOPEGUARD_DESKTOP_PILOT_STATE: statePath,
    SCOPEGUARD_DESKTOP_PILOT_USER_DATA: userDataRoot,
    SCOPEGUARD_DESKTOP_PILOT_WORKSPACE: workspaceRoot,
    SCOPEGUARD_DESKTOP_PILOT_PROVIDER_URL: provider.baseUrl,
    SCOPEGUARD_DESKTOP_PILOT_STORAGE_KEY: pilotStorageKey,
    ...(stageRoot ? { SCOPEGUARD_DESKTOP_PILOT_STAGED: "1" } : {}),
    ...extraEnvironment,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [...pilotElectronArguments(), applicationRoot], {
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  activeDesktopProcesses.add(child);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let result;
  try {
    result = await waitForProcessTree(
      child,
      90_000,
      `Desktop Pilot phase ${phase}`,
    );
    activeDesktopProcesses.delete(child);
  } catch (error) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      activeDesktopProcesses.delete(child);
    }
    throw error;
  }
  const output = Buffer.concat(stdout).toString("utf8");
  const diagnostics = Buffer.concat(stderr).toString("utf8");
  if (result.code !== 0) {
    throw new Error(
      `Desktop Pilot phase ${phase} failed code=${result.code} signal=${result.signal}:\n${output}\n${diagnostics}`,
    );
  }
  const completion = `ScopeGuard Desktop Pilot phase ${phase} complete`;
  if (!output.includes(completion) || !existsSync(statePath)) {
    throw new Error(
      `Desktop Pilot phase ${phase} exited without entering the production Pilot main path:\n${output}\n${diagnostics}`,
    );
  }
  return output;
}

function pilotElectronArguments() {
  if (process.platform === "linux") return ["--password-store=basic"];
  return [];
}

function pilotCredentialStoreMode() {
  if (process.platform === "linux") return "basic-test-store";
  return "platform-noninteractive";
}
