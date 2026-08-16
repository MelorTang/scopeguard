import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { RunConfigSnapshot } from "@scopeguard/domain";

import { ScopeGuardStore } from "./index.js";

test("creates only the V1 core tables", () => {
  const store = new ScopeGuardStore(":memory:");
  assert.deepEqual(store.listSchemaTables(), [
    "agents",
    "conversation_messages",
    "conversations",
    "provider_profiles",
    "run_events",
    "run_partials",
    "run_request_manifests",
    "run_usage_records",
    "runs",
    "schema_metadata",
    "tool_approvals",
    "tool_calls",
    "workspace_context_revisions",
    "workspaces",
  ]);
  store.close();
});

test("rejects a database from the pre-V1 schema", () => {
  const path = join(mkdtempSync(join(tmpdir(), "scopeguard-old-")), "old.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_metadata (schema_version INTEGER NOT NULL);
    INSERT INTO schema_metadata VALUES (9);
  `);
  database.close();

  assert.throws(
    () => new ScopeGuardStore(path),
    /pre-V1 ScopeGuard schema/,
  );
});

test("persists the canonical workspace graph across restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "scopeguard-v1-")), "scopeguard.sqlite");
  const first = new ScopeGuardStore(path);
  const fixture = createFixture(first);
  first.updateConversationSettings({
    conversationId: fixture.conversation.id,
    executionProfile: "auto-approve",
    modelOverride: "model-b",
  });
  const context = first.updateWorkspaceContext(
    fixture.workspace.id,
    "Shared facts",
    fixture.conversation.id,
  );
  first.close();

  const second = new ScopeGuardStore(path);
  const snapshot = second.getWorkspaceSnapshot();
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(snapshot.providerProfiles.length, 1);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.conversations.length, 1);
  assert.equal(snapshot.conversations[0]?.modelOverride, "model-b");
  assert.equal(snapshot.conversations[0]?.executionProfile, "auto-approve");
  assert.equal(second.getWorkspaceContext(fixture.workspace.id)?.id, context.id);
  second.close();
});

test("enforces one active run per conversation", () => {
  const store = new ScopeGuardStore(":memory:");
  const fixture = createFixture(store);
  const first = store.createRun(
    fixture.conversation.id,
    fixture.trigger.id,
    null,
    fixture.config,
  );
  assert.throws(
    () => store.createRun(
      fixture.conversation.id,
      fixture.trigger.id,
      null,
      fixture.config,
    ),
    /UNIQUE constraint failed/,
  );
  store.updateRunStatus(first.id, "preparing");
  store.updateRunStatus(first.id, "running");
  store.updateRunStatus(first.id, "completed");
  assert.equal(
    store.createRun(
      fixture.conversation.id,
      fixture.trigger.id,
      null,
      fixture.config,
    ).status,
    "queued",
  );
  store.close();
});

test("persists messages, manifests, usage, partials, and events", () => {
  const store = new ScopeGuardStore(":memory:");
  const fixture = createFixture(store);
  const run = store.createRun(
    fixture.conversation.id,
    fixture.trigger.id,
    null,
    fixture.config,
  );
  store.saveRunPartial(run.id, "partial");
  store.recordRunRequestManifest({
    runId: run.id,
    stepSequence: 1,
    providerProtocol: "openai-compatible",
    model: "model-a",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxOutputTokens: null,
    requestHash: "hash",
  });
  store.appendRunUsageRecord({
    runId: run.id,
    stepSequence: 1,
    source: "provider",
    status: "reported",
    inputTokens: 4,
    outputTokens: 7,
  });
  store.appendRunEvent({
    type: "run-status",
    runId: run.id,
    conversationId: fixture.conversation.id,
    status: "queued",
    at: new Date().toISOString(),
  });

  assert.equal(store.getRunPartial(run.id), "partial");
  assert.equal(store.listRunRequestManifests(run.id)[0]?.requestHash, "hash");
  assert.equal(store.listRunUsageRecords(run.id)[0]?.outputTokens, 7);
  assert.equal(store.listRunEvents(run.id)[0]?.type, "run-status");
  assert.equal(
    store.listConversationMessages(fixture.conversation.id)[0]?.content[0]?.type,
    "text",
  );
  store.close();
});

test("recovers unfinished tool calls without assuming side effects", () => {
  const store = new ScopeGuardStore(":memory:");
  const fixture = createFixture(store);
  const run = store.createRun(
    fixture.conversation.id,
    fixture.trigger.id,
    null,
    fixture.config,
  );
  const notStarted = store.createToolCall(run.id, {
    providerCallId: "call-1",
    name: "read_file",
    description: "Read a file",
    arguments: { path: "a.txt" },
  });
  const started = store.createToolCall(run.id, {
    providerCallId: "call-2",
    name: "run_command",
    description: "Run a command",
    arguments: { command: "do-work" },
  });
  store.updateToolCallStatus(started.id, "running");

  const recovered = store.recoverUnfinishedToolCallsForRun(run.id);
  assert.deepEqual(
    recovered.map((call) => [call.id, call.status]),
    [[notStarted.id, "cancelled"], [started.id, "effect_unknown"]],
  );
  store.close();
});

test("resolves approvals and expires pending approvals for terminal runs", () => {
  const store = new ScopeGuardStore(":memory:");
  const fixture = createFixture(store);
  const run = store.createRun(
    fixture.conversation.id,
    fixture.trigger.id,
    null,
    fixture.config,
  );
  const firstCall = store.createToolCall(run.id, {
    providerCallId: "call-1",
    name: "write_file",
    description: "Write a file",
    arguments: {},
  });
  const first = store.createApproval(run.id, firstCall.id, "Write a file");
  assert.equal(store.resolveApproval(first.id, "approved-once").status, "approved");

  const secondCall = store.createToolCall(run.id, {
    providerCallId: "call-2",
    name: "run_command",
    description: "Run a command",
    arguments: {},
  });
  store.createApproval(run.id, secondCall.id, "Run a command");
  store.updateRunStatus(run.id, "cancelled");
  assert.equal(store.expirePendingApprovalsForTerminalRuns(), 1);
  assert.equal(store.listPendingApprovals().length, 0);
  store.close();
});

test("restricts on-disk database permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "scopeguard-mode-"));
  const path = join(directory, "scopeguard.sqlite");
  const store = new ScopeGuardStore(path);
  store.createWorkspace({ name: "Private" });
  store.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

function createFixture(store: ScopeGuardStore) {
  const workspace = store.createWorkspace({
    name: "ScopeGuard",
    localRootPath: "/tmp/scopeguard",
  });
  const provider = store.saveProviderProfile({
    name: "Provider",
    protocol: "openai-compatible",
    baseUrl: "https://example.com/v1",
    defaultModel: "model-a",
  }, "secret:provider");
  const agent = store.createAgent({
    workspaceId: workspace.id,
    name: "General assistant",
    instructions: "Help the user.",
    providerProfileId: provider.id,
  });
  const conversation = store.createConversation({
    workspaceId: workspace.id,
    agentId: agent.id,
    title: "First task",
  });
  const trigger = store.appendMessage({
    conversationId: conversation.id,
    runId: null,
    role: "user",
    status: "committed",
    content: [{ type: "text", text: "hello" }],
    metadata: {},
  });
  const config: RunConfigSnapshot = {
    agentId: agent.id,
    providerProfileId: provider.id,
    providerProtocol: provider.protocol,
    providerBaseUrl: provider.baseUrl,
    model: provider.defaultModel,
    instructions: agent.instructions,
    executionProfile: conversation.executionProfile,
    toolPolicy: agent.toolPolicy,
  };
  return { workspace, provider, agent, conversation, trigger, config };
}
