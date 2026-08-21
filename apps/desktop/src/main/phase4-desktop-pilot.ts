import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Agent,
  AgentRun,
  Artifact,
  ArtifactVersion,
  Conversation,
  ProviderProfile,
  Workspace,
  WorkspaceCenterState,
  WorkspaceFileVersion,
  WorkspaceSnapshot,
} from "@scopeguard/domain";
import type { CapturedArtifactVersion } from "@scopeguard/ipc-contracts";

import type { AgentHostClient } from "./agent-host-client.js";
import type { Phase3DesktopRendererEvidence } from "./phase3-desktop-pilot.js";

type Phase4PilotState = {
  schemaVersion: 1;
  kind: "phase4";
  phase: 1 | 2;
  mainPid: number;
  agentHostPid: number;
  browserWindowId: number;
  rendererProcessId: number;
  rendererApi: "production-preload-ipc";
  workspaceId: string;
  conversationId: string;
  runIds: [string, string];
  artifactId: string;
  versionIds: [string, string];
  inputHashes: [string, string];
  hashes: [string, string];
  conflictStopped: true;
  reviewRestored: true;
  exportedRelativePaths: string[];
};

export async function runPhase4DesktopPilotPhase(
  host: AgentHostClient,
  renderer: Phase3DesktopRendererEvidence,
  phase: 1 | 2,
  statePath: string,
): Promise<void> {
  const hostPid = host.processId;
  assert.ok(hostPid, "Production AgentHostClient did not expose a running utility process.");
  if (phase === 1) {
    await firstProcess(host, renderer, hostPid, statePath);
  } else {
    await secondProcess(host, renderer, hostPid, statePath);
  }
}

async function firstProcess(
  host: AgentHostClient,
  renderer: Phase3DesktopRendererEvidence,
  hostPid: number,
  statePath: string,
): Promise<void> {
  const workspaceRoot = requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_WORKSPACE");
  const workspace = await host.request<Workspace>("createWorkspace", {
    name: "Phase 4 Artifact Pilot",
    localRootPath: workspaceRoot,
  });
  const provider = await host.request<ProviderProfile>("saveProviderProfile", {
    name: "Phase 4 Pilot Provider",
    protocol: "openai-compatible",
    baseUrl: `${requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_PROVIDER_URL")}/v1`,
    defaultModel: "desktop-pilot-model",
    apiKey: requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_API_KEY"),
  });
  const agent = await renderer.client.invoke<Agent>("createAgent", {
    workspaceId: workspace.id,
    name: "Phase 4 File Agent",
    instructions: "Use the declared file workflow and report its actual limits.",
    providerProfileId: provider.id,
    executionProfile: "full-access",
    toolPolicy: { readFiles: "allow", writeFiles: "allow", runCommands: "allow" },
  });
  const conversation = await renderer.client.invoke<Conversation>("createConversation", {
    workspaceId: workspace.id,
    agentId: agent.id,
    title: "Representative office file workflow",
  });

  const firstRun = await runFileWorkflow(renderer, conversation.id, "[phase4-file-v1]");
  const firstInputHash = await fileHash(join(workspaceRoot, "inputs", "source-v1.docx"));
  const firstHash = await fileHash(join(workspaceRoot, "reports", "agent-result.docx"));
  const first = await renderer.client.invoke<CapturedArtifactVersion>("captureWorkspaceFile", {
    workspaceId: workspace.id,
    relativePath: "reports/agent-result.docx",
    inputRelativePaths: ["inputs/source-v1.docx"],
    producedByConversationId: conversation.id,
    producedByRunId: firstRun.id,
    toolchain: "Pi bash Tool + docx 9.7.1 + mammoth 1.12.1",
    limitations: [
      "Test-only workflow regenerates a simple DOCX; complex styles, macros, revisions, and embedded objects are not preserved.",
      "Evidence applies only to the public synthetic fixtures and declared toolchain.",
    ],
  });
  assert.equal(first.version.contentHash, firstHash);
  assert.equal(first.version.source?.contentHash, firstHash);
  assert.deepEqual(first.version.inputs.map(({ contentHash }) => contentHash), [firstInputHash]);
  assert.equal(first.version.version, 1);

  const secondRun = await runFileWorkflow(renderer, conversation.id, "[phase4-file-v2]");
  const secondInputHash = await fileHash(join(workspaceRoot, "inputs", "source-v2.docx"));
  const secondHash = await fileHash(join(workspaceRoot, "reports", "agent-result.docx"));
  assert.notEqual(secondHash, firstHash);
  const second = await renderer.client.invoke<CapturedArtifactVersion>("captureWorkspaceFile", {
    workspaceId: workspace.id,
    relativePath: "reports/agent-result.docx",
    inputRelativePaths: ["inputs/source-v2.docx"],
    artifactId: first.artifact.id,
    producedByConversationId: conversation.id,
    producedByRunId: secondRun.id,
    toolchain: "Pi bash Tool + docx 9.7.1 + mammoth 1.12.1",
    limitations: [
      "Test-only workflow regenerates a simple DOCX; complex styles, macros, revisions, and embedded objects are not preserved.",
      "Evidence applies only to the public synthetic fixtures and declared toolchain.",
    ],
  });
  assert.equal(second.version.version, 2);
  assert.equal(second.version.parentVersionId, first.version.id);
  assert.equal(second.version.contentHash, secondHash);
  assert.equal(second.version.source?.contentHash, secondHash);
  assert.deepEqual(second.version.inputs.map(({ contentHash }) => contentHash), [secondInputHash]);

  const review: WorkspaceCenterState = {
    workspaceId: workspace.id,
    mode: "artifact-review",
    artifactId: first.artifact.id,
    versionId: first.version.id,
    comparisonVersionId: second.version.id,
    associatedConversationId: conversation.id,
    conversationPanelOpen: false,
  };
  await renderer.client.invoke("saveWorkspaceCenterState", review);
  await renderer.reloadRenderer();
  const rendererReview = await renderer.client.readArtifactReview({
    artifactTitle: first.artifact.title,
    versionId: first.version.id,
    comparisonVersionId: second.version.id,
    toolchain: first.version.toolchain,
    inputHash: firstInputHash,
  });
  assert.match(rendererReview.text, /public synthetic fixtures/);

  const conflictingPath = join(workspaceRoot, "reports", "agent-result.docx");
  await writeFile(conflictingPath, "external concurrent write\n", "utf8");
  await assert.rejects(
    renderer.client.invoke("exportArtifactVersion", {
      workspaceId: workspace.id,
      versionId: first.version.id,
      relativePath: "reports/agent-result.docx",
      expectedContentHash: secondHash,
    }),
    /no longer matches|conflict|version selected/i,
  );
  assert.equal(await readFile(conflictingPath, "utf8"), "external concurrent write\n");

  const exported = await renderer.client.invoke<WorkspaceFileVersion>("exportArtifactVersion", {
    workspaceId: workspace.id,
    versionId: first.version.id,
    relativePath: "exports/recovered-v1.docx",
    expectedContentHash: null,
  });
  assert.equal(exported.contentHash, firstHash);
  assert.equal(await fileHash(join(workspaceRoot, "exports", "recovered-v1.docx")), firstHash);

  await persistState(statePath, {
    schemaVersion: 1,
    kind: "phase4",
    phase: 1,
    mainPid: process.pid,
    agentHostPid: hostPid,
    browserWindowId: renderer.browserWindowId,
    rendererProcessId: renderer.rendererProcessId,
    rendererApi: "production-preload-ipc",
    workspaceId: workspace.id,
    conversationId: conversation.id,
    runIds: [firstRun.id, secondRun.id],
    artifactId: first.artifact.id,
    versionIds: [first.version.id, second.version.id],
    inputHashes: [firstInputHash, secondInputHash],
    hashes: [firstHash, secondHash],
    conflictStopped: true,
    reviewRestored: true,
    exportedRelativePaths: [exported.relativePath],
  });
  console.log("ScopeGuard Phase 4 Desktop Pilot phase 1 complete");
}

async function secondProcess(
  host: AgentHostClient,
  renderer: Phase3DesktopRendererEvidence,
  hostPid: number,
  statePath: string,
): Promise<void> {
  const previous = parseState(await readFile(statePath, "utf8"));
  const snapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  const artifact = requireArtifact(snapshot, previous.artifactId);
  const versions = previous.versionIds.map((id) => requireVersion(snapshot, id));
  assert.deepEqual(versions.map(({ contentHash }) => contentHash), previous.hashes);
  assert.deepEqual(
    versions.map(({ inputs }) => inputs[0]?.contentHash),
    previous.inputHashes,
  );
  assert.equal(artifact.currentVersionId, previous.versionIds[1]);
  const review = snapshot.centerStates.find(({ workspaceId }) => workspaceId === previous.workspaceId);
  assert.deepEqual(review, {
    workspaceId: previous.workspaceId,
    mode: "artifact-review",
    artifactId: previous.artifactId,
    versionId: previous.versionIds[0],
    comparisonVersionId: previous.versionIds[1],
    associatedConversationId: previous.conversationId,
    conversationPanelOpen: false,
  });
  await renderer.client.readArtifactReview({
    artifactTitle: artifact.title,
    versionId: previous.versionIds[0],
    comparisonVersionId: previous.versionIds[1],
    toolchain: versions[0]!.toolchain,
    inputHash: previous.inputHashes[0],
  });

  const exported = await renderer.client.invoke<WorkspaceFileVersion>("exportArtifactVersion", {
    workspaceId: previous.workspaceId,
    versionId: previous.versionIds[1],
    relativePath: "exports/recovered-v2.docx",
    expectedContentHash: null,
  });
  assert.equal(exported.contentHash, previous.hashes[1]);
  await persistState(statePath, {
    ...previous,
    phase: 2,
    mainPid: process.pid,
    agentHostPid: hostPid,
    browserWindowId: renderer.browserWindowId,
    rendererProcessId: renderer.rendererProcessId,
    exportedRelativePaths: [...previous.exportedRelativePaths, exported.relativePath],
  });
  console.log("ScopeGuard Phase 4 Desktop Pilot phase 2 complete");
}

async function runFileWorkflow(
  renderer: Phase3DesktopRendererEvidence,
  conversationId: string,
  prompt: string,
): Promise<AgentRun> {
  const run = await renderer.client.invoke<AgentRun>("startRun", { conversationId, prompt });
  const completed = await waitForRun(renderer, run.id);
  assert.equal(completed.status, "completed", completed.error ?? "Agent file Run failed.");
  assert.equal(completed.effect, "confirmed");
  return completed;
}

async function waitForRun(
  renderer: Phase3DesktopRendererEvidence,
  runId: string,
): Promise<AgentRun> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await renderer.client.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
    const run = [...snapshot.activeRuns, ...snapshot.recentRuns].find(({ id }) => id === runId);
    if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Phase 4 Agent file Run timed out: ${runId}`);
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function requireArtifact(snapshot: WorkspaceSnapshot, id: string): Artifact {
  const artifact = snapshot.artifacts.find((item) => item.id === id);
  assert.ok(artifact, `Artifact is missing after restart: ${id}`);
  return artifact;
}

function requireVersion(snapshot: WorkspaceSnapshot, id: string): ArtifactVersion {
  const version = snapshot.artifactVersions.find((item) => item.id === id);
  assert.ok(version, `Artifact Version is missing after restart: ${id}`);
  return version;
}

async function persistState(path: string, state: Phase4PilotState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function parseState(value: string): Phase4PilotState {
  const state = JSON.parse(value) as Phase4PilotState;
  if (
    state.schemaVersion !== 1 ||
    state.kind !== "phase4" ||
    state.phase !== 1 ||
    state.conflictStopped !== true ||
    state.reviewRestored !== true
  ) {
    throw new Error("Phase 4 Desktop Pilot state is incompatible.");
  }
  return state;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
