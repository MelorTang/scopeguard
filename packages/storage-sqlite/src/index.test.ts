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
      executionProfile: agent.executionProfile,
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
    const followUp = store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: "Use the approved context." }],
      metadata: {},
    });
    const contextualRun = store.createRun(thread.id, followUp.id, context.id, {
      agentProfileId: agent.id,
      runtimeKind: "native",
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: provider.defaultModel,
      instructions: agent.instructions,
      executionProfile: agent.executionProfile,
      toolPolicy: agent.toolPolicy,
      cliConfig: null,
    });
    store.updateRunStatus(contextualRun.id, "preparing");
    store.updateRunStatus(contextualRun.id, "running");
    store.updateRunStatus(contextualRun.id, "completed");

    const snapshot = store.getWorkspaceSnapshot();
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.providerProfiles[0]?.apiKeyRef, "provider-secret:test");
    assert.equal(snapshot.agentProfiles[0]?.toolPolicy.writeFiles, "ask");
    assert.equal(snapshot.threads[0]?.status, "active");
    assert.equal(snapshot.threads[0]?.executionProfile, "request-approval");
    assert.equal(snapshot.activeRuns.length, 0);
    assert.equal(snapshot.recentRuns[0]?.status, "completed");
    assert.deepEqual(
      store.listThreadMessages(thread.id).map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal(context.version, 1);
    assert.equal(store.getProjectContext(project.id)?.content, context.content);
    assert.deepEqual(store.listContextRevisionUses(context.id), [{
      contextRevisionId: context.id,
      runId: contextualRun.id,
      usedAt: contextualRun.createdAt,
    }]);
  } finally {
    store.close();
  }
});

test("persists model and execution settings per conversation", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const project = store.addProject({ rootPath: "/tmp/thread-settings" });
    const agent = store.createAgentProfile({
      projectId: project.id,
      name: "Analyst",
      instructions: "Analyze.",
      modelOverride: "model-default",
      executionProfile: "request-approval",
    });
    const first = store.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "First",
    });
    const second = store.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "Second",
    });

    assert.equal(first.modelOverride, "model-default");
    assert.equal(first.executionProfile, "request-approval");
    const updated = store.updateThreadSettings({
      threadId: first.id,
      modelOverride: "model-specialist",
      executionProfile: "full-access",
    });

    assert.equal(updated.modelOverride, "model-specialist");
    assert.equal(updated.executionProfile, "full-access");
    assert.equal(store.getThread(second.id)?.modelOverride, "model-default");
    assert.equal(
      store.getThread(second.id)?.executionProfile,
      "request-approval",
    );
  } finally {
    store.close();
  }
});

test("persists immutable request manifests and usage records across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-run-ledger-"));
  const databasePath = join(directory, "scopeguard.db");
  let threadId = "";
  let runId = "";
  try {
    const initial = new ScopeGuardStore(databasePath);
    const workspace = createRunningWorkspace(initial, directory);
    threadId = workspace.thread.id;
    runId = workspace.run.id;
    const manifest = initial.recordRunRequestManifest({
      runId,
      stepSequence: 1,
      providerProtocol: "openai-compatible",
      model: "model",
      messages: [{ role: "user", content: "Start" }],
      tools: [{
        name: "read_file",
        description: "Read a Workspace file.",
        inputSchema: { type: "object", required: ["path"] },
      }],
      maxOutputTokens: 4096,
      requestHash: "a".repeat(64),
    });
    initial.appendRunUsageRecord({
      runId,
      stepSequence: 1,
      source: "provider",
      status: "reported",
      inputTokens: 128,
      outputTokens: null,
    });
    initial.appendRunUsageRecord({
      runId,
      stepSequence: 1,
      source: "provider",
      status: "reported",
      inputTokens: null,
      outputTokens: 32,
    });
    assert.throws(
      () => initial.recordRunRequestManifest({
        ...manifest,
        requestHash: "b".repeat(64),
      }),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => initial.recordRunRequestManifest({
        ...manifest,
        stepSequence: 2,
        requestHash: "not-a-sha256",
      }),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => initial.appendRunUsageRecord({
        runId,
        stepSequence: 1,
        source: "provider",
        status: "reported",
        inputTokens: -1,
        outputTokens: null,
      }),
      /CHECK constraint failed/,
    );
    initial.close();

    const recovered = new ScopeGuardStore(databasePath);
    assert.deepEqual(recovered.listRunRequestManifests(runId), [manifest]);
    assert.deepEqual(
      recovered.listRunUsageRecords(runId).map((record) => ({
        sequence: record.sequence,
        stepSequence: record.stepSequence,
        status: record.status,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      })),
      [
        {
          sequence: 1,
          stepSequence: 1,
          status: "reported",
          inputTokens: 128,
          outputTokens: null,
        },
        {
          sequence: 2,
          stepSequence: 1,
          status: "reported",
          inputTokens: null,
          outputTokens: 32,
        },
      ],
    );
    recovered.close();

    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.prepare("DELETE FROM agent_threads WHERE id = ?").run(threadId);
    const manifestCount = database.prepare(
      "SELECT COUNT(*) AS count FROM run_request_manifests WHERE run_id = ?",
    ).get(runId) as { count: number };
    const usageCount = database.prepare(
      "SELECT COUNT(*) AS count FROM run_usage_records WHERE run_id = ?",
    ).get(runId) as { count: number };
    database.close();
    assert.equal(manifestCount.count, 0);
    assert.equal(usageCount.count, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test("persists the first-stage workspace control-plane entities", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const workspace = store.createWorkspace({ name: "Personal operations" });
    assert.equal(workspace.localRootPath, null);
    assert.equal(store.getProject(workspace.id)?.name, workspace.name);
    assert.match(
      store.getProject(workspace.id)?.rootPath ?? "",
      /^scopeguard:\/\/workspace\//,
    );
    const runtime = store.listRuntimeNodes().find((node) => node.kind === "local");
    assert.ok(runtime);

    const researcher = store.createAgentDefinition({
      name: "Researcher",
      description: "Collects evidence.",
      instructions: "Collect primary sources and report evidence.",
    });
    const reviewer = store.createAgentDefinition({
      name: "Reviewer",
      instructions: "Check claims and provenance.",
    });
    const researcherInstance = store.createAgentInstance({
      workspaceId: workspace.id,
      agentDefinitionId: researcher.id,
      runtimeNodeId: runtime.id,
    });
    const reviewerInstance = store.createAgentInstance({
      workspaceId: workspace.id,
      agentDefinitionId: reviewer.id,
      runtimeNodeId: runtime.id,
    });
    const task = store.createTask({
      workspaceId: workspace.id,
      title: "Prepare a market brief",
      description: "Research, verify, and write a Markdown brief.",
      priority: "high",
    });
    store.updateTaskStatus(task.id, "ready");
    store.updateTaskStatus(task.id, "running");
    const assignment = store.createTaskAssignment({
      taskId: task.id,
      agentInstanceId: researcherInstance.id,
      role: "research",
      position: 0,
    });
    const artifact = store.createArtifact({
      workspaceId: workspace.id,
      taskId: task.id,
      assignmentId: assignment.id,
      agentInstanceId: researcherInstance.id,
      kind: "markdown",
      title: "Research notes",
      mimeType: "text/markdown",
      content: "# Evidence\n\nSource-backed notes.",
    });
    const context = store.updateWorkspaceContext({
      workspaceId: workspace.id,
      scope: "task",
      taskId: task.id,
      title: "Verified research input",
      content: "Only the cited findings are approved for the report.",
      sourceAgentInstanceId: researcherInstance.id,
      sourceArtifactId: artifact.id,
      publishedBy: "agent",
    });
    const handoff = store.createHandoff({
      workspaceId: workspace.id,
      taskId: task.id,
      fromAgentInstanceId: researcherInstance.id,
      toAgentInstanceId: reviewerInstance.id,
      contextRevisionId: context.id,
      summary: "Review the approved findings before writing.",
    });
    store.createSchedule({
      workspaceId: workspace.id,
      agentInstanceId: researcherInstance.id,
      title: "Weekly refresh",
      prompt: "Refresh the market brief.",
      cronExpression: "0 9 * * 1",
      timeZone: "Asia/Shanghai",
    });
    const inbox = store.createInboxItem({
      workspaceId: workspace.id,
      kind: "input-required",
      title: "Review scope",
      summary: "Choose whether competitor pricing is in scope.",
      taskId: task.id,
      assignmentId: assignment.id,
      runId: null,
      approvalId: null,
      agentInstanceId: reviewerInstance.id,
    });

    const snapshot = store.getWorkspaceSnapshot();
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.agentDefinitions.length, 2);
    assert.equal(snapshot.agentInstances.length, 2);
    assert.equal(snapshot.tasks[0]?.status, "running");
    assert.equal(snapshot.assignments[0]?.role, "research");
    assert.equal(snapshot.artifacts[0]?.content, artifact.content);
    assert.equal(snapshot.handoffs[0]?.id, handoff.id);
    assert.equal(store.resolveHandoff(handoff.id, "accepted").status, "accepted");
    assert.ok(store.listHandoffs(workspace.id)[0]?.resolvedAt);
    assert.equal(snapshot.schedules[0]?.enabled, true);
    assert.equal(snapshot.inboxItems[0]?.status, "unread");
    assert.equal(store.resolveInboxItem(inbox.id).status, "resolved");
    assert.throws(
      () => store.updateTaskStatus(task.id, "archived"),
      /Invalid task status transition/,
    );
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
      executionProfile: agent.executionProfile,
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

test("treats waiting-input as an active Run in storage constraints", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const project = store.addProject({ rootPath: "/tmp/waiting-input-project" });
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
    const firstTrigger = store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: "First" }],
      metadata: {},
    });
    const config = {
      agentProfileId: agent.id,
      runtimeKind: "native" as const,
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: provider.defaultModel,
      instructions: agent.instructions,
      executionProfile: agent.executionProfile,
      toolPolicy: agent.toolPolicy,
      cliConfig: null,
    };
    const firstRun = store.createRun(thread.id, firstTrigger.id, null, config);
    store.updateRunStatus(firstRun.id, "preparing");
    store.updateRunStatus(firstRun.id, "running");
    store.updateRunStatus(firstRun.id, "waiting-input");
    assert.equal(store.listActiveRuns()[0]?.status, "waiting-input");

    const secondTrigger = store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: "Second" }],
      metadata: {},
    });
    assert.throws(
      () => store.createRun(thread.id, secondTrigger.id, null, config),
      /UNIQUE constraint failed/,
    );
  } finally {
    store.close();
  }
});

test("v6 migration adds waiting-input to the active Run index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-v6-migration-"));
  const databasePath = join(directory, "scopeguard.db");
  try {
    new ScopeGuardStore(databasePath).close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX idx_one_active_run_per_thread;
      CREATE UNIQUE INDEX idx_one_active_run_per_thread
        ON agent_runs(thread_id)
        WHERE status IN (
          'queued', 'preparing', 'running', 'waiting-approval', 'cancelling'
        );
      UPDATE schema_metadata SET value = '5' WHERE key = 'schema_version';
    `);
    legacy.close();

    new ScopeGuardStore(databasePath).close();
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const version = migrated.prepare(
      "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
    ).get() as { value: string };
    const index = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get("idx_one_active_run_per_thread") as { sql: string };
    migrated.close();

    assert.equal(version.value, "9");
    assert.match(index.sql, /waiting-input/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v7 migration assigns explicit conversation execution profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-v7-migration-"));
  const databasePath = join(directory, "scopeguard.db");
  try {
    const initial = new ScopeGuardStore(databasePath);
    const project = initial.addProject({ rootPath: "/tmp/v7-project" });
    const native = initial.createAgentProfile({
      projectId: project.id,
      name: "Native",
      instructions: "",
    });
    const cli = initial.createAgentProfile({
      projectId: project.id,
      name: "CLI",
      runtimeKind: "local-cli",
      instructions: "",
      cliConfig: { command: "codex", args: [], cwd: null, env: {} },
    });
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      UPDATE agent_profiles SET execution_profile = 'request-approval';
      UPDATE schema_metadata SET value = '6' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new ScopeGuardStore(databasePath);
    assert.equal(migrated.getAgentProfile(native.id)?.executionProfile, "request-approval");
    assert.equal(migrated.getAgentProfile(cli.id)?.executionProfile, "full-access");
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v8 migration inherits model and execution settings into conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-v8-migration-"));
  const databasePath = join(directory, "scopeguard.db");
  try {
    const initial = new ScopeGuardStore(databasePath);
    const project = initial.addProject({ rootPath: "/tmp/v8-project" });
    const agent = initial.createAgentProfile({
      projectId: project.id,
      name: "Native",
      instructions: "",
      modelOverride: "inherited-model",
      executionProfile: "auto-approve",
    });
    const thread = initial.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      UPDATE agent_threads
      SET model_override = NULL, execution_profile = 'request-approval';
      UPDATE schema_metadata SET value = '7' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new ScopeGuardStore(databasePath);
    assert.equal(migrated.getThread(thread.id)?.modelOverride, "inherited-model");
    assert.equal(migrated.getThread(thread.id)?.executionProfile, "auto-approve");
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v9 migration creates the local Run request and usage ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-v9-migration-"));
  const databasePath = join(directory, "scopeguard.db");
  try {
    new ScopeGuardStore(databasePath).close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX idx_run_usage_step;
      DROP TABLE run_usage_records;
      DROP TABLE run_request_manifests;
      UPDATE schema_metadata SET value = '8' WHERE key = 'schema_version';
    `);
    legacy.close();

    new ScopeGuardStore(databasePath).close();
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const version = migrated.prepare(
      "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
    ).get() as { value: string };
    const tables = migrated.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (?, ?) ORDER BY name`,
    ).all("run_request_manifests", "run_usage_records") as Array<{ name: string }>;
    migrated.close();

    assert.equal(version.value, "9");
    assert.deepEqual(tables.map((table) => table.name), [
      "run_request_manifests",
      "run_usage_records",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test("v4 migration preserves legacy work as workspaces, instances, tasks, and context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-v4-migration-"));
  const databasePath = join(directory, "scopeguard.db");
  let projectId = "";
  let agentId = "";
  let threadId = "";
  let contextId = "";
  try {
    const initial = new ScopeGuardStore(databasePath);
    const project = initial.addProject({
      name: "Legacy workspace",
      rootPath: directory,
    });
    const provider = initial.saveProviderProfile(
      {
        name: "Direct",
        protocol: "openai-compatible",
        baseUrl: "https://provider.example.com/v1",
        defaultModel: "model",
      },
      null,
    );
    const agent = initial.createAgentProfile({
      projectId: project.id,
      name: "Legacy researcher",
      instructions: "Research.",
      providerProfileId: provider.id,
    });
    const thread = initial.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "Legacy research",
    });
    const context = initial.updateProjectContext(
      project.id,
      "A retained decision.",
      thread.id,
    );
    projectId = project.id;
    agentId = agent.id;
    threadId = thread.id;
    contextId = context.id;
    initial.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      INSERT OR REPLACE INTO project_context_versions (
        id, project_id, version, parent_id, content,
        source_thread_id, source_run_id, created_at
      )
      SELECT id, workspace_id, version, parent_id, content,
             source_thread_id, source_run_id, created_at
      FROM context_revisions;
      DROP TABLE inbox_items;
      DROP TABLE workspace_schedules;
      DROP TABLE agent_handoffs;
      DROP TABLE context_revision_uses;
      DROP TABLE context_revisions;
      DROP TABLE artifacts;
      DROP TABLE task_assignments;
      DROP TABLE workspace_tasks;
      DROP TABLE agent_instances;
      DROP TABLE agent_definitions;
      DROP TABLE runtime_nodes;
      DROP TABLE workspaces;
      UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version';
    `);
    database.close();

    const migrated = new ScopeGuardStore(databasePath);
    const workspace = migrated.getWorkspace(projectId);
    assert.equal(workspace?.localRootPath, directory);
    assert.equal(
      migrated.listAgentDefinitions().find((item) => item.id === agentId)?.name,
      "Legacy researcher",
    );
    const instance = migrated.listAgentInstances(projectId).find(
      (item) => item.agentDefinitionId === agentId,
    );
    assert.ok(instance);
    assert.equal(migrated.getTask(threadId)?.status, "ready");
    assert.equal(
      migrated.listTaskAssignments(threadId)[0]?.agentInstanceId,
      instance.id,
    );
    assert.equal(migrated.getWorkspaceContext(projectId)?.id, contextId);
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
      executionProfile: agent.executionProfile,
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

test("preserves active Runs that are bound to a remote Runtime across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-remote-run-"));
  const databasePath = join(directory, "scopeguard.db");
  let runId = "";
  let runtimeId = "";
  try {
    const initial = new ScopeGuardStore(databasePath);
    const workspace = createRunningWorkspace(initial, directory);
    runId = workspace.run.id;
    const runtime = initial.saveRuntimeNode({
      name: "Remote Runtime",
      kind: "remote",
      baseUrl: "https://runtime.example.com",
      credentialRef: "runtime-secret:test",
      status: "online",
    });
    runtimeId = runtime.id;
    initial.createRemoteRunBinding({
      runId,
      runtimeNodeId: runtime.id,
      remoteRunId: "remote-job-1",
    });
    initial.saveRunPartial(runId, "Remote partial output");
    initial.close();

    const recovered = new ScopeGuardStore(databasePath);
    assert.equal(recovered.interruptNonTerminalRuns(), 0);
    assert.equal(recovered.getRun(runId)?.status, "running");
    assert.equal(recovered.listActiveRemoteRunBindings().length, 1);
    assert.equal(recovered.getRemoteRunBinding(runId)?.runtimeNodeId, runtimeId);
    assert.equal(recovered.getRunPartial(runId), "Remote partial output");
    recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
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
    executionProfile: agent.executionProfile,
    toolPolicy: agent.toolPolicy,
    cliConfig: null,
  });
  store.updateRunStatus(run.id, "preparing");
  store.updateRunStatus(run.id, "running");
  return { thread, run };
}
