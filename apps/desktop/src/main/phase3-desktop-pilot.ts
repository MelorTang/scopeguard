import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import type {
  Agent,
  AgentRun,
  Conversation,
  Dispatch,
  HandoffPrompt,
  PiSessionLocator,
  ProviderProfile,
  Workspace,
  WorkspaceLayout,
  WorkspaceSnapshot,
} from "@scopeguard/domain";

import type { AgentHostClient } from "./agent-host-client.js";
import type { Phase3RendererClient } from "./phase3-renderer-client.js";

export type Phase3DesktopRendererEvidence = {
  client: Phase3RendererClient;
  browserWindowId: number;
  rendererProcessId: number;
  readClipboardText: () => string;
};

type Phase3PilotState = {
  schemaVersion: 1;
  kind: "phase3";
  phase: 1 | 2;
  mainPid: number;
  agentHostPid: number;
  browserWindowId: number;
  rendererProcessId: number;
  rendererApi: "production-preload-ipc";
  clipboardVerified: true;
  workspaceId: string;
  providerId: string;
  agentIds: string[];
  conversationIds: string[];
  locators: Record<string, PiSessionLocator>;
  layout: WorkspaceLayout;
  completedDispatchId: string;
  failedDispatchId: string;
  resumedMessageCount: number;
};

export async function runPhase3DesktopPilotPhase(
  host: AgentHostClient,
  renderer: Phase3DesktopRendererEvidence,
  phase: 1 | 2,
  statePath: string,
): Promise<void> {
  const hostPid = host.processId;
  assert.ok(hostPid, "Production AgentHostClient did not expose a running utility process.");
  if (phase === 1) {
    await runFirstProcess(host, renderer, hostPid, statePath);
  } else {
    await runSecondProcess(renderer, hostPid, statePath);
  }
}

async function runFirstProcess(
  host: AgentHostClient,
  renderer: Phase3DesktopRendererEvidence,
  hostPid: number,
  statePath: string,
): Promise<void> {
  const workspace = await host.request<Workspace>("createWorkspace", {
    name: "Phase 3 Workbench Pilot",
    localRootPath: requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_WORKSPACE"),
  });
  const provider = await host.request<ProviderProfile>("saveProviderProfile", {
    name: "Phase 3 Pilot Provider",
    protocol: "openai-compatible",
    baseUrl: `${requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_PROVIDER_URL")}/v1`,
    defaultModel: "desktop-pilot-model",
    apiKey: requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_API_KEY"),
  });
  const agents: Agent[] = [];
  const conversations: Conversation[] = [];
  for (let index = 0; index < 4; index += 1) {
    const agent = await renderer.client.invoke<Agent>("createAgent", {
      workspaceId: workspace.id,
      name: `Phase 3 Agent ${index + 1}`,
      instructions: "Reply briefly and do not call tools.",
      providerProfileId: provider.id,
    });
    agents.push(agent);
    conversations.push(await renderer.client.invoke<Conversation>("createConversation", {
      workspaceId: workspace.id,
      agentId: agent.id,
      title: `Parallel Conversation ${index + 1}`,
    }));
  }
  const layout = await renderer.client.invoke<WorkspaceLayout>("saveWorkspaceLayout", {
    workspaceId: workspace.id,
    openConversationIds: conversations.map(({ id }) => id),
    paneConversationIds: conversations.map(({ id }) => id),
    activeConversationId: conversations[2]!.id,
    requestedPaneCount: 4,
  });
  const runs: AgentRun[] = [];
  for (let index = 0; index < conversations.length; index += 1) {
    runs.push(await renderer.client.invoke<AgentRun>("startRun", {
      conversationId: conversations[index]!.id,
      prompt: index === 0
        ? "[phase3-slow] cancel only this Conversation"
        : `[phase3-parallel] complete Conversation ${index + 1}`,
    }));
  }
  const concurrent = await renderer.client.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.equal(concurrent.activeRuns.length, 4, "Four Runs were not concurrently active.");
  await renderer.client.invoke("cancelRun", runs[0]!.id);
  await waitForRun(renderer.client, runs[0]!.id, "cancelled");
  await Promise.all(runs.slice(1).map((run) =>
    waitForRun(renderer.client, run.id, "completed")
  ));

  const afterParallel = await renderer.client.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
  const locators = Object.fromEntries(conversations.map(({ id }) => [
    id,
    requireLocator(afterParallel, id),
  ]));
  assert.equal(new Set(Object.values(locators).map(({ sessionId }) => sessionId)).size, 4);

  const handoff = await renderer.client.invoke<HandoffPrompt>("generateHandoffPrompt", {
    workspaceId: workspace.id,
    sourceConversationId: conversations[1]!.id,
    targetConversationId: conversations[0]!.id,
    workRequest: "Review the parallel result and continue.",
  });
  assert.match(handoff.text, /Phase 3 Agent 2/);
  assert.match(handoff.text, /Parallel Conversation 1/);
  assert.doesNotMatch(handoff.text, /complete Conversation 2/);
  await renderer.client.invoke("copyHandoffPrompt", handoff.text);
  assert.equal(
    renderer.readClipboardText(),
    handoff.text,
    "Controlled Handoff clipboard IPC did not preserve the exact text.",
  );

  const created = await renderer.client.invoke<Dispatch>("createDispatch", {
    workspaceId: workspace.id,
    sourceConversationId: conversations[1]!.id,
    targetConversationId: conversations[0]!.id,
    prompt: "successful explicit dispatch",
    sourceRunId: runs[1]!.id,
  });
  const running = await renderer.client.invoke<Dispatch>("executeDispatch", created.id);
  assert.equal(running.status, "running");
  assert.ok(running.targetRunId);
  await waitForRun(renderer.client, running.targetRunId, "completed");

  const busyRun = await renderer.client.invoke<AgentRun>("startRun", {
    conversationId: conversations[2]!.id,
    prompt: "[phase3-slow] keep the Dispatch target busy",
  });
  const blocked = await renderer.client.invoke<Dispatch>("createDispatch", {
    workspaceId: workspace.id,
    sourceConversationId: conversations[3]!.id,
    targetConversationId: conversations[2]!.id,
    prompt: "must fail instead of queueing",
    sourceRunId: runs[3]!.id,
  });
  const failed = await renderer.client.invoke<Dispatch>("executeDispatch", blocked.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /active Run/);
  await renderer.client.invoke("cancelRun", busyRun.id);
  await waitForRun(renderer.client, busyRun.id, "cancelled");

  const finalSnapshot = await renderer.client.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.equal(requireDispatch(finalSnapshot, created.id).status, "completed");
  assert.equal(requireDispatch(finalSnapshot, blocked.id).status, "failed");
  await persistState(statePath, {
    schemaVersion: 1,
    kind: "phase3",
    phase: 1,
    mainPid: process.pid,
    agentHostPid: hostPid,
    browserWindowId: renderer.browserWindowId,
    rendererProcessId: renderer.rendererProcessId,
    rendererApi: "production-preload-ipc",
    clipboardVerified: true,
    workspaceId: workspace.id,
    providerId: provider.id,
    agentIds: agents.map(({ id }) => id),
    conversationIds: conversations.map(({ id }) => id),
    locators,
    layout,
    completedDispatchId: created.id,
    failedDispatchId: blocked.id,
    resumedMessageCount: 0,
  });
  console.log("ScopeGuard Phase 3 Desktop Pilot phase 1 complete");
}

async function runSecondProcess(
  renderer: Phase3DesktopRendererEvidence,
  hostPid: number,
  statePath: string,
): Promise<void> {
  const previous = parseState(await readFile(statePath, "utf8"));
  assert.equal(previous.phase, 1);
  const snapshot = await renderer.client.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.equal(snapshot.conversations.filter(
    ({ workspaceId }) => workspaceId === previous.workspaceId,
  ).length, 4);
  assert.deepEqual(
    await renderer.client.invoke<WorkspaceLayout>("getWorkspaceLayout", previous.workspaceId),
    previous.layout,
  );
  for (const conversationId of previous.conversationIds) {
    assert.deepEqual(requireLocator(snapshot, conversationId), previous.locators[conversationId]);
  }
  assert.equal(requireDispatch(snapshot, previous.completedDispatchId).status, "completed");
  assert.equal(requireDispatch(snapshot, previous.failedDispatchId).status, "failed");

  const resumedConversationId = previous.conversationIds[1]!;
  const run = await renderer.client.invoke<AgentRun>("startRun", {
    conversationId: resumedConversationId,
    prompt: "phase3-restart-continuation",
  });
  await waitForRun(renderer.client, run.id, "completed");
  const finalSnapshot = await renderer.client.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.deepEqual(
    requireLocator(finalSnapshot, resumedConversationId),
    previous.locators[resumedConversationId],
  );
  const messages = await renderer.client.invoke<unknown[]>(
    "listConversationMessages",
    resumedConversationId,
  );
  assert.equal(messages.length, 4);
  await persistState(statePath, {
    ...previous,
    phase: 2,
    mainPid: process.pid,
    agentHostPid: hostPid,
    browserWindowId: renderer.browserWindowId,
    rendererProcessId: renderer.rendererProcessId,
    resumedMessageCount: messages.length,
  });
  console.log("ScopeGuard Phase 3 Desktop Pilot phase 2 complete");
}

async function waitForRun(
  renderer: Phase3RendererClient,
  runId: string,
  expected: AgentRun["status"],
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await renderer.invoke<WorkspaceSnapshot>("getWorkspaceSnapshot");
    const run = [...snapshot.activeRuns, ...snapshot.recentRuns]
      .find(({ id }) => id === runId);
    if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      assert.equal(run.status, expected, run.error ?? `Run ended ${run.status}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Phase 3 Desktop Pilot Run timed out: ${runId}`);
}

function requireLocator(
  snapshot: WorkspaceSnapshot,
  conversationId: string,
): PiSessionLocator {
  const locator = snapshot.conversations.find(({ id }) => id === conversationId)?.piSession;
  assert.ok(locator, `Conversation ${conversationId} has no Pi Session locator.`);
  assert.equal(locator.piVersion, "0.84.2");
  return locator;
}

function requireDispatch(snapshot: WorkspaceSnapshot, dispatchId: string): Dispatch {
  const dispatch = snapshot.dispatches.find(({ id }) => id === dispatchId);
  assert.ok(dispatch, `Dispatch ${dispatchId} is missing.`);
  return dispatch;
}

async function persistState(path: string, state: Phase3PilotState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function parseState(value: string): Phase3PilotState {
  const state = JSON.parse(value) as Phase3PilotState;
  if (state.schemaVersion !== 1 || state.kind !== "phase3" || state.phase !== 1) {
    throw new Error("Phase 3 Desktop Pilot state is incompatible.");
  }
  return state;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
