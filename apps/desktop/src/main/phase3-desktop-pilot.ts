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

type Phase3PilotState = {
  schemaVersion: 1;
  kind: "phase3";
  phase: 1 | 2;
  mainPid: number;
  agentHostPid: number;
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
  phase: 1 | 2,
  statePath: string,
): Promise<void> {
  const hostPid = host.processId;
  assert.ok(hostPid, "Production AgentHostClient did not expose a running utility process.");
  if (phase === 1) {
    await runFirstProcess(host, hostPid, statePath);
  } else {
    await runSecondProcess(host, hostPid, statePath);
  }
}

async function runFirstProcess(
  host: AgentHostClient,
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
    const agent = await host.request<Agent>("createAgent", {
      workspaceId: workspace.id,
      name: `Phase 3 Agent ${index + 1}`,
      instructions: "Reply briefly and do not call tools.",
      providerProfileId: provider.id,
    });
    agents.push(agent);
    conversations.push(await host.request<Conversation>("createConversation", {
      workspaceId: workspace.id,
      agentId: agent.id,
      title: `Parallel Conversation ${index + 1}`,
    }));
  }
  const layout = await host.request<WorkspaceLayout>("saveWorkspaceLayout", {
    workspaceId: workspace.id,
    openConversationIds: conversations.map(({ id }) => id),
    paneConversationIds: conversations.map(({ id }) => id),
    activeConversationId: conversations[2]!.id,
    requestedPaneCount: 4,
  });
  const runs: AgentRun[] = [];
  for (let index = 0; index < conversations.length; index += 1) {
    runs.push(await host.request<AgentRun>("startRun", {
      conversationId: conversations[index]!.id,
      prompt: index === 0
        ? "[phase3-slow] cancel only this Conversation"
        : `[phase3-parallel] complete Conversation ${index + 1}`,
    }));
  }
  const concurrent = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.equal(concurrent.activeRuns.length, 4, "Four Runs were not concurrently active.");
  await host.request("cancelRun", runs[0]!.id);
  await waitForRun(host, runs[0]!.id, "cancelled");
  await Promise.all(runs.slice(1).map((run) => waitForRun(host, run.id, "completed")));

  const afterParallel = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  const locators = Object.fromEntries(conversations.map(({ id }) => [
    id,
    requireLocator(afterParallel, id),
  ]));
  assert.equal(new Set(Object.values(locators).map(({ sessionId }) => sessionId)).size, 4);

  const handoff = await host.request<HandoffPrompt>("generateHandoffPrompt", {
    workspaceId: workspace.id,
    sourceConversationId: conversations[1]!.id,
    targetConversationId: conversations[0]!.id,
    workRequest: "Review the parallel result and continue.",
  });
  assert.match(handoff.text, /Phase 3 Agent 2/);
  assert.match(handoff.text, /Parallel Conversation 1/);
  assert.doesNotMatch(handoff.text, /complete Conversation 2/);

  const created = await host.request<Dispatch>("createDispatch", {
    workspaceId: workspace.id,
    sourceConversationId: conversations[1]!.id,
    targetConversationId: conversations[0]!.id,
    prompt: "successful explicit dispatch",
    sourceRunId: runs[1]!.id,
  });
  const running = await host.request<Dispatch>("executeDispatch", created.id);
  assert.equal(running.status, "running");
  assert.ok(running.targetRunId);
  await waitForRun(host, running.targetRunId, "completed");

  const busyRun = await host.request<AgentRun>("startRun", {
    conversationId: conversations[2]!.id,
    prompt: "[phase3-slow] keep the Dispatch target busy",
  });
  const blocked = await host.request<Dispatch>("createDispatch", {
    workspaceId: workspace.id,
    sourceConversationId: conversations[3]!.id,
    targetConversationId: conversations[2]!.id,
    prompt: "must fail instead of queueing",
    sourceRunId: runs[3]!.id,
  });
  const failed = await host.request<Dispatch>("executeDispatch", blocked.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /active Run/);
  await host.request("cancelRun", busyRun.id);
  await waitForRun(host, busyRun.id, "cancelled");

  const finalSnapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.equal(requireDispatch(finalSnapshot, created.id).status, "completed");
  assert.equal(requireDispatch(finalSnapshot, blocked.id).status, "failed");
  await persistState(statePath, {
    schemaVersion: 1,
    kind: "phase3",
    phase: 1,
    mainPid: process.pid,
    agentHostPid: hostPid,
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
  host: AgentHostClient,
  hostPid: number,
  statePath: string,
): Promise<void> {
  const previous = parseState(await readFile(statePath, "utf8"));
  assert.equal(previous.phase, 1);
  const snapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.equal(snapshot.conversations.filter(
    ({ workspaceId }) => workspaceId === previous.workspaceId,
  ).length, 4);
  assert.deepEqual(
    snapshot.layouts.find(({ workspaceId }) => workspaceId === previous.workspaceId),
    previous.layout,
  );
  for (const conversationId of previous.conversationIds) {
    assert.deepEqual(requireLocator(snapshot, conversationId), previous.locators[conversationId]);
  }
  assert.equal(requireDispatch(snapshot, previous.completedDispatchId).status, "completed");
  assert.equal(requireDispatch(snapshot, previous.failedDispatchId).status, "failed");

  const resumedConversationId = previous.conversationIds[1]!;
  const run = await host.request<AgentRun>("startRun", {
    conversationId: resumedConversationId,
    prompt: "phase3-restart-continuation",
  });
  await waitForRun(host, run.id, "completed");
  const finalSnapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  assert.deepEqual(
    requireLocator(finalSnapshot, resumedConversationId),
    previous.locators[resumedConversationId],
  );
  const messages = await host.request<unknown[]>(
    "listConversationMessages",
    resumedConversationId,
  );
  assert.equal(messages.length, 4);
  await persistState(statePath, {
    ...previous,
    phase: 2,
    mainPid: process.pid,
    agentHostPid: hostPid,
    resumedMessageCount: messages.length,
  });
  console.log("ScopeGuard Phase 3 Desktop Pilot phase 2 complete");
}

async function waitForRun(
  host: AgentHostClient,
  runId: string,
  expected: AgentRun["status"],
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
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
