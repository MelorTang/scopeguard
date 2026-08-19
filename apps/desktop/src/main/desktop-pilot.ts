import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import type {
  Agent,
  AgentRun,
  Conversation,
  PiSessionLocator,
  ProviderProfile,
  Workspace,
  WorkspaceSnapshot,
} from "@scopeguard/domain";

import type { AgentHostClient } from "./agent-host-client.js";

type PilotState = {
  schemaVersion: 1;
  phase: 1 | 2;
  mainPid: number;
  agentHostPid: number;
  workspaceId: string;
  providerId: string;
  agentId: string;
  conversationId: string;
  locator: PiSessionLocator;
  messageCount: number;
};

export async function runDesktopPilotPhase(host: AgentHostClient): Promise<void> {
  const phase = parsePhase(process.env.SCOPEGUARD_DESKTOP_PILOT_PHASE);
  const statePath = requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_STATE");
  const hostPid = host.processId;
  assert.ok(hostPid, "Production AgentHostClient did not expose a running utility process.");

  if (phase === 1) {
    const workspace = await host.request<Workspace>("createWorkspace", {
      name: "Desktop Pilot",
      localRootPath: requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_WORKSPACE"),
    });
    const provider = await host.request<ProviderProfile>("saveProviderProfile", {
      name: "Pilot Provider",
      protocol: "openai-compatible",
      baseUrl: `${requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_PROVIDER_URL")}/v1`,
      defaultModel: "desktop-pilot-model",
      apiKey: requiredEnvironment("SCOPEGUARD_DESKTOP_PILOT_API_KEY"),
    });
    const agent = await host.request<Agent>("createAgent", {
      workspaceId: workspace.id,
      name: "Pilot Agent",
      instructions: "Reply briefly and do not call tools.",
      providerProfileId: provider.id,
    });
    const conversation = await host.request<Conversation>("createConversation", {
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Desktop restart proof",
    });
    const run = await host.request<AgentRun>("startRun", {
      conversationId: conversation.id,
      prompt: "first-turn",
    });
    await waitForRun(host, run.id, "completed");
    const snapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
    const locator = requireLocator(snapshot, conversation.id);
    const messages = await host.request<unknown[]>("listConversationMessages", conversation.id);
    assert.equal(messages.length, 2);
    await persistState(statePath, {
      schemaVersion: 1,
      phase,
      mainPid: process.pid,
      agentHostPid: hostPid,
      workspaceId: workspace.id,
      providerId: provider.id,
      agentId: agent.id,
      conversationId: conversation.id,
      locator,
      messageCount: messages.length,
    });
    console.log("ScopeGuard Desktop Pilot phase 1 complete");
    return;
  }

  const previous = parseState(await readFile(statePath, "utf8"));
  assert.equal(previous.phase, 1);
  const snapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  const resumed = requireLocator(snapshot, previous.conversationId);
  assert.deepEqual(resumed, previous.locator);
  const run = await host.request<AgentRun>("startRun", {
    conversationId: previous.conversationId,
    prompt: "second-turn",
  });
  await waitForRun(host, run.id, "completed");
  const finalSnapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
  const finalLocator = requireLocator(finalSnapshot, previous.conversationId);
  assert.deepEqual(finalLocator, previous.locator);
  const messages = await host.request<unknown[]>("listConversationMessages", previous.conversationId);
  assert.equal(messages.length, 4);
  await persistState(statePath, {
    ...previous,
    phase,
    mainPid: process.pid,
    agentHostPid: hostPid,
    locator: finalLocator,
    messageCount: messages.length,
  });
  console.log("ScopeGuard Desktop Pilot phase 2 complete");
}

async function waitForRun(
  host: AgentHostClient,
  runId: string,
  expected: AgentRun["status"],
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await host.request<WorkspaceSnapshot>("getWorkspaceSnapshot");
    const run = [...snapshot.activeRuns, ...snapshot.recentRuns].find((item) => item.id === runId);
    if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      assert.equal(run.status, expected, run.error ?? `Run ended ${run.status}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Desktop Pilot Run timed out: ${runId}`);
}

function requireLocator(snapshot: WorkspaceSnapshot, conversationId: string): PiSessionLocator {
  const locator = snapshot.conversations.find((item) => item.id === conversationId)?.piSession;
  assert.ok(locator, "Desktop Pilot Conversation has no Pi Session locator.");
  assert.equal(locator.piVersion, "0.84.2");
  return locator;
}

async function persistState(path: string, state: PilotState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function parseState(value: string): PilotState {
  const state = JSON.parse(value) as PilotState;
  if (state.schemaVersion !== 1 || state.phase !== 1) {
    throw new Error("Desktop Pilot state is incompatible.");
  }
  return state;
}

function parsePhase(value: string | undefined): 1 | 2 {
  if (value === "1") return 1;
  if (value === "2") return 2;
  throw new Error("SCOPEGUARD_DESKTOP_PILOT_PHASE must be 1 or 2.");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
