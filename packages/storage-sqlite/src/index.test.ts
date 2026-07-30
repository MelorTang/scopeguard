import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { ScopeGuardStore } from "./index.js";

test("persists the first multi-agent workspace slice", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const project = store.addProject({
      name: "ScopeGuard",
      rootPath: "/tmp/scopeguard",
    });
    const provider = store.saveProviderProfile(
      {
        name: "Relay",
        protocol: "openai-compatible",
        baseUrl: "https://relay.example.com/v1",
        defaultModel: "test-model",
        customHeaders: { "X-Tenant": "scopeguard" },
      },
      "provider-secret:test",
    );
    const agent = store.createAgentProfile({
      projectId: project.id,
      name: "Research",
      instructions: "Investigate the request and report evidence.",
      providerProfileId: provider.id,
    });
    const thread = store.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "Provider architecture",
    });
    const trigger = store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: "Compare provider protocols." }],
      metadata: {},
    });
    const run = store.createRun(thread.id, trigger.id, null, {
      agentProfileId: agent.id,
      runtimeKind: "native",
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: provider.defaultModel,
      instructions: agent.instructions,
      toolPolicy: agent.toolPolicy,
      cliConfig: null,
    });
    store.updateRunStatus(run.id, "preparing");
    store.updateRunStatus(run.id, "running");
    store.appendMessage({
      threadId: thread.id,
      runId: run.id,
      role: "assistant",
      status: "committed",
      content: [
        {
          type: "text",
          text: "OpenAI-compatible and Anthropic-compatible need separate adapters.",
        },
      ],
      metadata: {},
    });
    store.updateRunStatus(run.id, "completed");
    const context = store.updateProjectContext(
      project.id,
      "Provider adapters are explicit and independently tested.",
      thread.id,
    );

    const snapshot = store.getWorkspaceSnapshot();
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.providerProfiles[0]?.apiKeyRef, "provider-secret:test");
    assert.equal(snapshot.agentProfiles[0]?.toolPolicy.writeFiles, "ask");
    assert.equal(snapshot.threads[0]?.status, "active");
    assert.equal(snapshot.activeRuns.length, 0);
    assert.equal(snapshot.recentRuns[0]?.status, "completed");
    assert.deepEqual(
      store.listThreadMessages(thread.id).map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(context.version, 1);
    assert.equal(store.getProjectContext(project.id)?.content, context.content);
  } finally {
    store.close();
  }
});

test("keeps projects idempotent by root path", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const first = store.addProject({ rootPath: "/tmp/project" });
    const second = store.addProject({
      name: "A different display name",
      rootPath: "/tmp/project",
    });

    assert.equal(second.id, first.id);
    assert.equal(store.listProjects().length, 1);
  } finally {
    store.close();
  }
});

test("rejects invalid run transitions", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const project = store.addProject({ rootPath: "/tmp/project" });
    const provider = store.saveProviderProfile(
      {
        name: "Direct",
        protocol: "anthropic-compatible",
        baseUrl: "https://provider.example.com",
        defaultModel: "model",
      },
      null,
    );
    const agent = store.createAgentProfile({
      projectId: project.id,
      name: "General",
      instructions: "",
      providerProfileId: provider.id,
    });
    const thread = store.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    const trigger = store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: "Hello" }],
      metadata: {},
    });
    const run = store.createRun(thread.id, trigger.id, null, {
      agentProfileId: agent.id,
      runtimeKind: "native",
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: provider.defaultModel,
      instructions: agent.instructions,
      toolPolicy: agent.toolPolicy,
      cliConfig: null,
    });

    assert.throws(
      () => store.updateRunStatus(run.id, "completed"),
      /Invalid run status transition/,
    );
  } finally {
    store.close();
  }
});

test("rejects a database created by a newer schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-schema-"));
  const databasePath = join(directory, "scopeguard.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', '999');
  `);
  database.close();

  try {
    assert.throws(
      () => new ScopeGuardStore(databasePath),
      /newer than supported schema/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restricts on-disk database files to the current user", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not meaningful on Windows.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "scopeguard-permissions-"));
  const directory = join(root, "private-data");
  const databasePath = join(directory, "scopeguard.db");

  try {
    const store = new ScopeGuardStore(databasePath);
    try {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
      assert.equal((await stat(`${databasePath}-wal`)).mode & 0o777, 0o600);
      assert.equal((await stat(`${databasePath}-shm`)).mode & 0o777, 0o600);
    } finally {
      store.close();
    }
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 migration removes plaintext provider headers and CLI environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-migration-"));
  const databasePath = join(directory, "scopeguard.db");
  let providerId = "";
  let agentId = "";
  try {
    const initial = new ScopeGuardStore(databasePath);
    const project = initial.addProject({ rootPath: directory });
    const provider = initial.saveProviderProfile(
      {
        name: "Legacy relay",
        protocol: "openai-compatible",
        baseUrl: "https://provider.example.com/v1",
        defaultModel: "model",
        customHeaders: { "X-Legacy-Secret": "plaintext" },
      },
      null,
    );
    const agent = initial.createAgentProfile({
      projectId: project.id,
      name: "Legacy CLI",
      runtimeKind: "local-cli",
      instructions: "",
      cliConfig: {
        command: "agent",
        args: [],
        cwd: "/tmp",
        env: { AGENT_TOKEN: "plaintext" },
      },
    });
    providerId = provider.id;
    agentId = agent.id;
    initial.close();

    const database = new DatabaseSync(databasePath);
    database.prepare(
      "UPDATE schema_metadata SET value = '1' WHERE key = 'schema_version'",
    ).run();
    database.close();

    const migrated = new ScopeGuardStore(databasePath);
    assert.deepEqual(
      migrated.getProviderProfile(providerId)?.customHeaders,
      {},
    );
    assert.deepEqual(
      migrated.getAgentProfile(agentId)?.cliConfig,
      {
        command: "agent",
        args: [],
        cwd: null,
        env: {},
      },
    );
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expires approvals that belong to interrupted Runs", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const project = store.addProject({ rootPath: "/tmp/interrupted-project" });
    const provider = store.saveProviderProfile(
      {
        name: "Direct",
        protocol: "openai-compatible",
        baseUrl: "https://provider.example.com/v1",
        defaultModel: "model",
      },
      null,
    );
    const agent = store.createAgentProfile({
      projectId: project.id,
      name: "General",
      instructions: "",
      providerProfileId: provider.id,
    });
    const thread = store.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    const trigger = store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: "Run a command" }],
      metadata: {},
    });
    const run = store.createRun(thread.id, trigger.id, null, {
      agentProfileId: agent.id,
      runtimeKind: "native",
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: provider.defaultModel,
      instructions: agent.instructions,
      toolPolicy: agent.toolPolicy,
      cliConfig: null,
    });
    store.updateRunStatus(run.id, "preparing");
    store.updateRunStatus(run.id, "running");
    const toolCall = store.createToolCall(run.id, {
      providerCallId: "provider-call",
      name: "run_command",
      description: "Run command",
      arguments: { command: "echo test" },
    });
    store.updateToolCallStatus(toolCall.id, "awaiting-approval");
    const approval = store.createApproval(
      run.id,
      toolCall.id,
      "Run command",
    );

    assert.equal(store.interruptNonTerminalRuns(), 1);
    assert.equal(store.expirePendingApprovalsForTerminalRuns(), 1);

    assert.equal(store.getRun(run.id)?.status, "interrupted");
    assert.equal(store.getApproval(approval.id)?.status, "expired");
    assert.equal(store.getToolCall(toolCall.id)?.status, "cancelled");
    assert.equal(store.listPendingApprovals().length, 0);
  } finally {
    store.close();
  }
});

test("recovers checkpointed partial output after an unclean shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-partial-"));
  const databasePath = join(directory, "scopeguard.db");
  let runId = "";
  let threadId = "";
  try {
    const initial = new ScopeGuardStore(databasePath);
    const workspace = createRunningWorkspace(initial, directory);
    runId = workspace.run.id;
    threadId = workspace.thread.id;
    initial.saveRunPartial(runId, "Checkpointed partial output");
    initial.close();

    const recovered = new ScopeGuardStore(databasePath);
    assert.equal(recovered.interruptNonTerminalRuns(), 1);
    assert.equal(recovered.getRun(runId)?.status, "interrupted");
    const partial = recovered.listThreadMessages(threadId).find(
      (message) =>
        message.runId === runId &&
        message.role === "assistant" &&
        message.status === "interrupted",
    );
    assert.deepEqual(partial?.content, [{
      type: "text",
      text: "Checkpointed partial output",
    }]);
    assert.equal(partial?.metadata.recovered, true);
    recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not duplicate a partial checkpoint committed before a crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-partial-"));
  const databasePath = join(directory, "scopeguard.db");
  let runId = "";
  let threadId = "";
  try {
    const initial = new ScopeGuardStore(databasePath);
    const workspace = createRunningWorkspace(initial, directory);
    runId = workspace.run.id;
    threadId = workspace.thread.id;
    initial.saveRunPartial(runId, "Committed response");
    initial.appendMessage({
      threadId,
      runId,
      role: "assistant",
      status: "committed",
      content: [{ type: "text", text: "Committed response" }],
      metadata: {},
    });
    initial.close();

    const recovered = new ScopeGuardStore(databasePath);
    assert.equal(recovered.interruptNonTerminalRuns(), 1);
    const assistantMessages = recovered.listThreadMessages(threadId).filter(
      (message) => message.runId === runId && message.role === "assistant",
    );
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0]?.status, "committed");
    recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createRunningWorkspace(store: ScopeGuardStore, rootPath: string) {
  const project = store.addProject({ rootPath });
  const provider = store.saveProviderProfile(
    {
      name: "Provider",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "model",
    },
    null,
  );
  const agent = store.createAgentProfile({
    projectId: project.id,
    name: "Agent",
    instructions: "",
    providerProfileId: provider.id,
  });
  const thread = store.createThread({
    projectId: project.id,
    agentProfileId: agent.id,
  });
  const trigger = store.appendMessage({
    threadId: thread.id,
    runId: null,
    role: "user",
    status: "committed",
    content: [{ type: "text", text: "Start" }],
    metadata: {},
  });
  const run = store.createRun(thread.id, trigger.id, null, {
    agentProfileId: agent.id,
    runtimeKind: "native",
    providerProfileId: provider.id,
    providerProtocol: provider.protocol,
    providerBaseUrl: provider.baseUrl,
    model: provider.defaultModel,
    instructions: agent.instructions,
    toolPolicy: agent.toolPolicy,
    cliConfig: null,
  });
  store.updateRunStatus(run.id, "preparing");
  store.updateRunStatus(run.id, "running");
  return { thread, run };
}
