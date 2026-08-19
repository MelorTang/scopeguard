import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SCOPEGUARD_SCHEMA_ID } from "@scopeguard/domain";

import { ScopeGuardStore } from "./index.js";

test("creates only the personal Pi product metadata schema", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    assert.deepEqual(store.listSchemaTables(), [
      "agents",
      "artifacts",
      "conversations",
      "dispatches",
      "layout_state",
      "provider_profiles",
      "runs",
      "schema_metadata",
      "tool_approvals",
      "workspace_context_revisions",
      "workspaces",
    ]);
    assert.equal(store.listSchemaTables().includes("conversation_messages"), false);
    assert.equal(store.listSchemaTables().includes("tool_calls"), false);
  } finally {
    store.close();
  }
});

test("rejects old, malformed, and incompatible database families", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-schema-rejection-"));
  let index = 0;
  try {
    for (const prepare of [
    (db: DatabaseSync) => db.exec("CREATE TABLE legacy_data (id TEXT)"),
    (db: DatabaseSync) => db.exec("CREATE TABLE schema_metadata (schema_version INTEGER) STRICT"),
    (db: DatabaseSync) => db.exec(`CREATE TABLE schema_metadata (schema_id TEXT, schema_version INTEGER) STRICT; INSERT INTO schema_metadata VALUES ('scopeguard-v1-core', 1)`),
    (db: DatabaseSync) => db.exec(`CREATE TABLE schema_metadata (schema_id TEXT, schema_version INTEGER, created_at TEXT) STRICT; INSERT INTO schema_metadata VALUES ('${SCOPEGUARD_SCHEMA_ID}', 1, 'now')`),
    ]) {
      const path = join(root, `incompatible-${++index}.db`);
      const db = new DatabaseSync(path);
      prepare(db);
      db.close();
      assert.throws(() => new ScopeGuardStore(path), new RegExp(`Expected ${SCOPEGUARD_SCHEMA_ID}`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing or semantically incorrect active Run index on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-index-rejection-"));
  try {
    const missingPath = join(root, "missing-index.db");
    new ScopeGuardStore(missingPath).close();
    const missing = new DatabaseSync(missingPath);
    missing.exec("DROP INDEX one_active_run_per_conversation");
    missing.close();
    assert.throws(() => new ScopeGuardStore(missingPath), /Incompatible ScopeGuard database/);

    const incorrectPath = join(root, "incorrect-index.db");
    new ScopeGuardStore(incorrectPath).close();
    const incorrect = new DatabaseSync(incorrectPath);
    incorrect.exec(`
      DROP INDEX one_active_run_per_conversation;
      CREATE UNIQUE INDEX one_active_run_per_conversation ON runs(conversation_id)
        WHERE status = 'running';
    `);
    incorrect.close();
    assert.throws(() => new ScopeGuardStore(incorrectPath), /Incompatible ScopeGuard database/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reopens a valid disk schema without treating SQLite automatic indexes as product indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-index-validation-"));
  const path = join(root, "valid.db");
  try {
    new ScopeGuardStore(path).close();
    const database = new DatabaseSync(path);
    const indexes = database.prepare("PRAGMA index_list(runs)").all() as Array<{ name: string }>;
    database.close();
    assert.ok(indexes.some(({ name }) => name.startsWith("sqlite_autoindex_")));
    assert.doesNotThrow(() => new ScopeGuardStore(path).close());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects persisted permission values that could otherwise change deny semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-permission-rejection-"));
  const mutations = [
    "UPDATE agents SET tool_policy_json = '{}'",
    `UPDATE agents SET tool_policy_json = '{"readFiles":"allow","writeFiles":"ask","runCommands":"bogus"}'`,
    "UPDATE agents SET default_execution_profile = 'bogus'",
    "UPDATE conversations SET execution_profile = 'bogus'",
  ];
  try {
    for (const [index, mutation] of mutations.entries()) {
      const path = join(root, `invalid-permission-${index}.db`);
      const store = new ScopeGuardStore(path);
      const workspace = store.createWorkspace({ name: "Workspace" });
      const provider = store.saveProviderProfile({
        name: "Provider",
        protocol: "openai-compatible",
        baseUrl: "http://localhost/v1",
        defaultModel: "model",
      }, null);
      const agent = store.createAgent({
        workspaceId: workspace.id,
        name: "Denied Agent",
        instructions: "",
        providerProfileId: provider.id,
        toolPolicy: { runCommands: "deny" },
      });
      store.createConversation({ workspaceId: workspace.id, agentId: agent.id });
      assert.equal(agent.toolPolicy.runCommands, "deny");
      store.close();

      const database = new DatabaseSync(path);
      database.exec(mutation);
      database.close();
      assert.throws(() => new ScopeGuardStore(path), /Incompatible ScopeGuard database/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces one active Run per Conversation and complete Pi locators", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const workspace = store.createWorkspace({ name: "Workspace" });
    const provider = store.saveProviderProfile({
      name: "Provider", protocol: "openai-compatible", baseUrl: "http://localhost/v1", defaultModel: "model",
    }, null);
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Agent", instructions: "", providerProfileId: provider.id });
    const conversation = store.createConversation({ workspaceId: workspace.id, agentId: agent.id });
    const config = {
      agentId: agent.id, providerProfileId: provider.id, providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl, model: provider.defaultModel, instructions: "",
      executionProfile: "request-approval" as const, toolPolicy: agent.toolPolicy,
    };
    store.createRun(conversation.id, config);
    assert.throws(() => store.createRun(conversation.id, config), /UNIQUE constraint failed/);
  } finally {
    store.close();
  }
});

test("restart interruption preserves Tool effect certainty", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const workspace = store.createWorkspace({ name: "Workspace" });
    const provider = store.saveProviderProfile({
      name: "Provider", protocol: "openai-compatible", baseUrl: "http://localhost/v1", defaultModel: "model",
    }, null);
    const agent = store.createAgent({ workspaceId: workspace.id, name: "Agent", instructions: "", providerProfileId: provider.id });
    const config = {
      agentId: agent.id, providerProfileId: provider.id, providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl, model: provider.defaultModel, instructions: "",
      executionProfile: "request-approval" as const, toolPolicy: agent.toolPolicy,
    };
    const untouched = store.createRun(
      store.createConversation({ workspaceId: workspace.id, agentId: agent.id }).id,
      config,
    );
    const uncertain = store.createRun(
      store.createConversation({ workspaceId: workspace.id, agentId: agent.id }).id,
      config,
    );
    store.updateRunStatus(uncertain.id, "preparing");
    store.updateRunStatus(uncertain.id, "running", undefined, "effect_unknown");
    const approval = store.createApproval(uncertain.id, {
      toolCallId: "process:tool", reason: "test", processId: "process",
      requestId: "request", piToolCallId: "tool", toolName: "write",
      canonicalInput: { path: "report.md" }, canonicalInputSha256: "a".repeat(64),
    });

    assert.equal(store.interruptNonTerminalRuns(), 2);
    assert.equal(store.getRun(untouched.id)?.effect, "none");
    assert.equal(store.getRun(uncertain.id)?.effect, "effect_unknown");
    assert.equal(store.getApproval(approval.id)?.status, "expired");
  } finally {
    store.close();
  }
});
