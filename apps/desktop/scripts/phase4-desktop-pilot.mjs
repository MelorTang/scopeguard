import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { supervisePilotDesktopProcess } from "../dist/main/pilot-desktop-process.js";
import { readPhase4PilotDocxText } from "../dist/main/phase4-file-pilot-workflow.js";
import { assertDesktopPilotLaunchAllowed } from "../dist/main/pilot-safe-storage.js";
import { startPiRuntimeFakeProvider } from "./pi-runtime-fake-provider.mjs";

assertDesktopPilotLaunchAllowed(process.platform);
const electronPath = (await import("electron")).default;

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = process.env.SCOPEGUARD_PILOT_STAGE_ROOT
  ? resolve(process.env.SCOPEGUARD_PILOT_STAGE_ROOT)
  : null;
const applicationRoot = stageRoot ?? desktopRoot;
const root = await mkdtemp(join(tmpdir(), "scopeguard-phase4-pilot-"));
const workspaceRoot = join(root, "workspace");
const userDataRoot = join(root, "user-data");
const lifecyclePath = join(root, "pilot-lifecycle.json");
const statePath = join(root, "pilot-state.json");
const secret = "phase4-desktop-pilot-secret";
const pilotStorageKey = randomBytes(32).toString("base64url");
const provider = await startPiRuntimeFakeProvider(secret, {
  phase4WorkflowScript: join(desktopRoot, "scripts", "phase4-file-pilot-workflow.mjs"),
});
let primaryError = null;
let providerCleanupError = null;
const startedAt = Date.now();

try {
  await mkdir(join(workspaceRoot, "inputs"), { recursive: true });
  await copyFile(
    join(desktopRoot, "tests", "fixtures", "phase4", "source-v1.docx"),
    join(workspaceRoot, "inputs", "source-v1.docx"),
  );
  await copyFile(
    join(desktopRoot, "tests", "fixtures", "phase4", "source-v2.docx"),
    join(workspaceRoot, "inputs", "source-v2.docx"),
  );

  const firstOutput = await launchDesktop(1, {
    SCOPEGUARD_DESKTOP_PILOT_API_KEY: secret,
  });
  const first = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(first.kind, "phase4");
  assert.equal(first.phase, 1);
  assert.equal(first.rendererApi, "production-preload-ipc");
  assert.equal(first.versionIds.length, 2);
  assert.equal(first.inputHashes.length, 3);
  assert.notEqual(first.hashes[0], first.hashes[1]);
  assert.equal(first.conflictStopped, true);
  assert.equal(first.reviewRestored, true);
  assert.deepEqual(first.exportedRelativePaths, ["exports/recovered-v1.docx"]);
  assert.match(firstOutput, /ScopeGuard Phase 4 Desktop Pilot phase 1 complete/);
  assert.equal(
    await fileHash(join(workspaceRoot, "exports", "recovered-v1.docx")),
    first.hashes[0],
  );
  assert.match(
    await readPhase4PilotDocxText(join(workspaceRoot, "exports", "recovered-v1.docx")),
    /版本 1/,
  );

  const encryptedCredentials = await readFile(
    join(userDataRoot, "credentials", "providers.json"),
  );
  assert.equal(encryptedCredentials.includes(Buffer.from(secret)), false);
  assert.equal(encryptedCredentials.includes(Buffer.from(pilotStorageKey)), false);

  const secondOutput = await launchDesktop(2);
  const second = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(second.phase, 2);
  assert.notEqual(second.mainPid, first.mainPid);
  assert.notEqual(second.agentHostPid, first.agentHostPid);
  assert.notEqual(second.rendererProcessId, first.rendererProcessId);
  assert.equal(second.artifactId, first.artifactId);
  assert.deepEqual(second.versionIds, first.versionIds);
  assert.deepEqual(second.inputHashes, first.inputHashes);
  assert.deepEqual(second.hashes, first.hashes);
  assert.equal(second.reviewRestored, true);
  assert.deepEqual(second.exportedRelativePaths, [
    "exports/recovered-v1.docx",
    "exports/recovered-v2.docx",
  ]);
  assert.match(secondOutput, /ScopeGuard Phase 4 Desktop Pilot phase 2 complete/);
  assert.equal(
    await fileHash(join(workspaceRoot, "exports", "recovered-v2.docx")),
    first.hashes[1],
  );
  assert.match(
    await readPhase4PilotDocxText(join(workspaceRoot, "exports", "recovered-v2.docx")),
    /版本 2/,
  );
  assert.equal(provider.requests.every(({ authorized }) => authorized), true);
  assert.equal(provider.requests.length, 4);
  const requestsWithToolHistory = provider.requests.filter(
    ({ roles }) => roles.includes("tool"),
  ).length;
  const toolContinuations = provider.requests.filter(
    ({ roles }) => roles.at(-1) === "tool",
  ).length;
  assert.equal(requestsWithToolHistory, 3);
  assert.equal(toolContinuations, 2);
  await assertTreeDoesNotContain(root, [secret, pilotStorageKey]);

  console.log(JSON.stringify({
    checks: 38,
    mode: stageRoot ? "staged" : "development",
    electronVersion: "42.0.1",
    firstMainPid: first.mainPid,
    secondMainPid: second.mainPid,
    firstAgentHostPid: first.agentHostPid,
    secondAgentHostPid: second.agentHostPid,
    firstRendererProcessId: first.rendererProcessId,
    secondRendererProcessId: second.rendererProcessId,
    rendererApi: second.rendererApi,
    artifactId: second.artifactId,
    versionIds: second.versionIds,
    inputContentHashes: second.inputHashes,
    contentHashes: second.hashes,
    conflictStopped: second.conflictStopped,
    reviewRestoredAcrossDesktopRestart: second.reviewRestored,
    exportedRelativePaths: second.exportedRelativePaths,
    providerRequestsWithToolHistory: requestsWithToolHistory,
    providerToolContinuations: toolContinuations,
    officeWorkflow: "Pi bash Tool + docx 9.7.1 + mammoth 1.12.1",
    outputReopenedAfterCreateAndRevise: true,
    credentialRecoveredFromDiskVault: true,
    elapsedMs: Date.now() - startedAt,
  }));
} catch (error) {
  primaryError = asError(error, "Phase 4 Desktop Pilot failed without an Error object.");
} finally {
  try {
    await provider.close();
  } catch (error) {
    providerCleanupError = asError(error, "Phase 4 Provider cleanup failed.");
  }
  if (!primaryError && !providerCleanupError) {
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}

if (primaryError || providerCleanupError) {
  const primary = primaryError ?? new Error("Phase 4 Provider cleanup failed.");
  const additional = providerCleanupError
    ? `\nAdditional Provider cleanup diagnostic: ${providerCleanupError.message}`
    : "";
  throw new Error(
    `${primary.message}${additional}\nTemporary diagnostics retained at ${root}.`,
    { cause: primary },
  );
}

async function launchDesktop(phase, extraEnvironment = {}) {
  const environment = {
    ...process.env,
    SCOPEGUARD_DESKTOP_PILOT_KIND: "phase4",
    SCOPEGUARD_DESKTOP_PILOT_PHASE: String(phase),
    SCOPEGUARD_DESKTOP_PILOT_LIFECYCLE: lifecyclePath,
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
  return supervisePilotDesktopProcess({
    child,
    completion: `ScopeGuard Phase 4 Desktop Pilot phase ${phase} complete`,
    description: `Phase 4 Desktop Pilot phase ${phase}`,
    lifecyclePath,
    phase,
    redactions: [secret, pilotStorageKey],
    statePath,
    timeoutMs: 120_000,
  });
}

async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertTreeDoesNotContain(directory, secrets) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertTreeDoesNotContain(path, secrets);
      continue;
    }
    const content = await readFile(path);
    for (const value of secrets) {
      assert.equal(content.includes(Buffer.from(value)), false, `Secret leaked into ${path}`);
    }
  }
}

function pilotElectronArguments() {
  return process.platform === "linux" ? ["--password-store=basic"] : [];
}

function asError(error, fallback) {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}
