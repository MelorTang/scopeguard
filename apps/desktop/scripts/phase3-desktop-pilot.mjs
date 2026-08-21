import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import { supervisePilotDesktopProcess } from "../dist/main/pilot-desktop-process.js";
import { assertDesktopPilotLaunchAllowed } from "../dist/main/pilot-safe-storage.js";
import { startPiRuntimeFakeProvider } from "./pi-runtime-fake-provider.mjs";

assertDesktopPilotLaunchAllowed(process.platform);

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = process.env.SCOPEGUARD_PILOT_STAGE_ROOT
  ? resolve(process.env.SCOPEGUARD_PILOT_STAGE_ROOT)
  : null;
const applicationRoot = stageRoot ?? desktopRoot;
const root = await mkdtemp(join(tmpdir(), "scopeguard-phase3-pilot-"));
const workspaceRoot = join(root, "workspace");
const userDataRoot = join(root, "user-data");
const lifecyclePath = join(root, "pilot-lifecycle.json");
const statePath = join(root, "pilot-state.json");
const secret = "phase3-desktop-pilot-secret";
const pilotStorageKey = randomBytes(32).toString("base64url");
const provider = await startPiRuntimeFakeProvider(secret);
let primaryError = null;
let providerCleanupError = null;
const startedAt = Date.now();

try {
  await mkdir(workspaceRoot);
  const firstOutput = await launchDesktop(1, {
    SCOPEGUARD_DESKTOP_PILOT_API_KEY: secret,
  });
  const first = JSON.parse(await readFile(statePath, "utf8"));
  const firstShutdown = await readShutdownEvidence(1);
  assert.equal(first.kind, "phase3");
  assert.equal(first.phase, 1);
  assert.equal(first.conversationIds.length, 4);
  assert.equal(new Set(Object.values(first.locators).map((locator) => locator.sessionId)).size, 4);
  assert.equal(first.layout.requestedPaneCount, 3);
  assert.deepEqual(first.layout.paneWidths, [492, 488, 556]);
  assert.equal(first.layoutMutationFlushedOnQuit, true);
  assert.equal(first.lateLayoutMutationArmed, true);
  assert.equal(first.terminalLayoutDrainRaceArmed, true);
  assertShutdownEvidence(firstShutdown, 1, first.lateLayoutStageReceipt);
  assertTargetLayoutDrainEvidence(firstShutdown.targetLayoutDrain, first.layout);
  assert.ok(firstShutdown.quiescedLayoutStageAttempts >= 1);
  assert.equal(first.rendererApi, "production-preload-ipc");
  assert.equal(first.clipboardVerified, true);
  assert.ok(first.browserWindowId > 0);
  assert.ok(first.rendererProcessId > 0);
  assert.match(firstOutput, /ScopeGuard Phase 3 Desktop Pilot phase 1 complete/);

  const credentialPath = join(userDataRoot, "credentials", "providers.json");
  const encryptedCredentials = await readFile(credentialPath);
  assert.equal(encryptedCredentials.includes(Buffer.from(secret)), false);
  assert.equal(encryptedCredentials.includes(Buffer.from(pilotStorageKey)), false);

  const secondOutput = await launchDesktop(2);
  const second = JSON.parse(await readFile(statePath, "utf8"));
  const secondShutdown = await readShutdownEvidence(2);
  assert.equal(second.phase, 2);
  assert.equal(second.resumedMessageCount, 4);
  assert.match(secondOutput, /ScopeGuard Phase 3 Desktop Pilot phase 2 complete/);
  assert.notEqual(second.mainPid, first.mainPid);
  assert.notEqual(second.agentHostPid, first.agentHostPid);
  assert.notEqual(second.rendererProcessId, first.rendererProcessId);
  assert.equal(second.rendererApi, "production-preload-ipc");
  assert.equal(second.clipboardVerified, true);
  assert.deepEqual(second.locators, first.locators);
  assert.deepEqual(second.layout, first.layout);
  assert.deepEqual(second.layout.paneWidths, [492, 488, 556]);
  assert.equal(second.layoutMutationFlushedOnQuit, true);
  assert.equal(second.lateLayoutMutationArmed, true);
  assert.equal(second.terminalLayoutDrainRaceArmed, true);
  assertShutdownEvidence(secondShutdown, 2, second.lateLayoutStageReceipt);
  assert.equal(secondShutdown.targetLayoutDrain, null);

  const finalRequest = provider.requests.at(-1);
  assert.deepEqual(finalRequest?.userTexts, [
    "[phase3-parallel] complete Conversation 2",
    "phase3-restart-continuation",
  ]);
  assert.equal(provider.requests.every((request) => request.authorized), true);
  await assertTreeDoesNotContain(root, [secret, pilotStorageKey]);
  console.log(JSON.stringify({
    checks: 57,
    mode: stageRoot ? "staged" : "development",
    electronVersion: "42.0.1",
    piVersion: Object.values(second.locators)[0]?.piVersion,
    firstMainPid: first.mainPid,
    secondMainPid: second.mainPid,
    firstAgentHostPid: first.agentHostPid,
    secondAgentHostPid: second.agentHostPid,
    firstBrowserWindowId: first.browserWindowId,
    secondBrowserWindowId: second.browserWindowId,
    firstRendererProcessId: first.rendererProcessId,
    secondRendererProcessId: second.rendererProcessId,
    rendererApi: second.rendererApi,
    clipboardVerified: second.clipboardVerified,
    permissionPolicy: "deny-all",
    conversationCount: second.conversationIds.length,
    distinctSessionIds: new Set(Object.values(second.locators).map((locator) => locator.sessionId)).size,
    activePaneConversationId: second.layout.activeConversationId,
    paneWidths: second.layout.paneWidths,
    layoutMutationFlushedOnQuit: second.layoutMutationFlushedOnQuit,
    rendererDestroyedBeforeHostStop: secondShutdown.rendererDestroyedBeforeHostStop,
    shutdownEvents: secondShutdown.events,
    postDestroyObservationMs: secondShutdown.postDestroyObservationMs,
    lateLayoutObservation: secondShutdown.lateLayoutObservation,
    lateLayoutStageAttempts: secondShutdown.lateLayoutStageAttempts,
    rendererDrainAcknowledgedBeforeMainSuspend:
      secondShutdown.rendererDrainAcknowledgedBeforeMainSuspend,
    firstProcessQuiescedLayoutStageAttempts:
      firstShutdown.quiescedLayoutStageAttempts,
    targetLayoutDrain: firstShutdown.targetLayoutDrain,
    completedDispatchId: second.completedDispatchId,
    failedDispatchId: second.failedDispatchId,
    providerObservedHistory: finalRequest.userTexts,
    credentialRecoveredFromDiskVault: true,
    pilotStorage: "aes-256-gcm",
    elapsedMs: Date.now() - startedAt,
  }));
} catch (error) {
  primaryError = asError(error, "Phase 3 Desktop Pilot failed without an Error object.");
} finally {
  try {
    await provider.close();
  } catch (error) {
    providerCleanupError = asError(error, "Phase 3 Provider cleanup failed.");
  }
  if (!primaryError && !providerCleanupError) {
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}

if (primaryError || providerCleanupError) {
  const primary = primaryError ?? new Error("Phase 3 Provider cleanup failed.");
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
    SCOPEGUARD_DESKTOP_PILOT_KIND: "phase3",
    SCOPEGUARD_DESKTOP_PILOT_PHASE: String(phase),
    SCOPEGUARD_DESKTOP_PILOT_LIFECYCLE: lifecyclePath,
    SCOPEGUARD_DESKTOP_PILOT_STATE: statePath,
    SCOPEGUARD_PHASE3_PILOT_SHUTDOWN_EVIDENCE: join(
      root,
      `phase3-shutdown-${phase}.json`,
    ),
    SCOPEGUARD_PHASE3_PILOT_POST_DESTROY_OBSERVATION_MS: "1200",
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
  const completion = `ScopeGuard Phase 3 Desktop Pilot phase ${phase} complete`;
  return supervisePilotDesktopProcess({
    child,
    completion,
    description: `Phase 3 Desktop Pilot phase ${phase}`,
    lifecyclePath,
    phase,
    redactions: [secret, pilotStorageKey],
    statePath,
    timeoutMs: 120_000,
  });
}

async function readShutdownEvidence(phase) {
  return JSON.parse(await readFile(join(root, `phase3-shutdown-${phase}.json`), "utf8"));
}

function assertShutdownEvidence(evidence, phase, armReceipt) {
  assert.equal(evidence.schemaVersion, 3);
  assert.equal(evidence.phase, phase);
  assert.deepEqual(evidence.events, [
    "renderer-layout-drained",
    "layout-suspended",
    "layout-flushed",
    "renderer-destroyed",
    "host-stop-started",
    "host-stop-complete",
  ]);
  assert.equal(evidence.rendererDestroyedBeforeHostStop, true);
  assert.equal(evidence.postDestroyObservationMs, 1200);
  assert.equal(evidence.lateLayoutStageAttempts, 0);
  assert.deepEqual({
    armedAtUnixMs: evidence.lateLayoutObservation.armedAtUnixMs,
    dueAtUnixMs: evidence.lateLayoutObservation.dueAtUnixMs,
  }, armReceipt);
  assert.ok(
    evidence.lateLayoutObservation.rendererDestroyedAtUnixMs
      < evidence.lateLayoutObservation.dueAtUnixMs,
  );
  assert.ok(
    evidence.lateLayoutObservation.observationCompletedAtUnixMs
      >= evidence.lateLayoutObservation.dueAtUnixMs,
  );
  assert.equal(evidence.lateLayoutObservation.lateLayoutStageAttempts, 0);
  assert.equal(evidence.rendererDrainAcknowledgedBeforeMainSuspend, true);
}

function assertTargetLayoutDrainEvidence(evidence, expectedLayout) {
  assert.ok(evidence);
  assert.equal(evidence.targetRevisionRejectedWhileQuiescing, true);
  assert.equal(evidence.targetRevisionAcceptedDuringRendererDrain, true);
  assert.equal(evidence.targetRevisionAcceptedOutsideRendererDrain, false);
  assert.match(evidence.targetDrainReceipt.generation, /^layout-lifecycle-\d+$/);
  assert.equal(
    evidence.targetDrainReceipt.acceptedRevision.workspaceId,
    expectedLayout.workspaceId,
  );
  assert.ok(evidence.targetDrainReceipt.acceptedRevision.revision > 0);
  assert.deepEqual(evidence.targetDrainReceipt.acceptedRevision.layout, expectedLayout);
  assert.deepEqual(evidence.events, [
    "target-revision-rejected-quiescing",
    "target-revision-accepted-by-main",
    "target-revision-confirmed-by-renderer-drain-receipt",
    "main-suspended",
    "sqlite-flushed",
  ]);
}

async function assertTreeDoesNotContain(directory, secrets) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertTreeDoesNotContain(path, secrets);
      continue;
    }
    const content = await readFile(path);
    for (const secret of secrets) {
      assert.equal(content.includes(Buffer.from(secret)), false, `Secret leaked into ${path}`);
    }
  }
}

function pilotElectronArguments() {
  return process.platform === "linux" ? ["--password-store=basic"] : [];
}

function asError(error, fallback) {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}
