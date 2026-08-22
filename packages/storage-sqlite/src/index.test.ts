import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SCOPEGUARD_SCHEMA_ID, SCOPEGUARD_SCHEMA_VERSION } from "@scopeguard/domain";

import { ScopeGuardStore } from "./index.js";

test("creates only the personal Pi product metadata schema", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    assert.deepEqual(store.listSchemaTables(), [
      "agents",
      "artifact_versions",
      "artifacts",
      "center_state",
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

test("migrates the exact Phase 3 schema to Artifact schema v2 without losing product state", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-v1-migration-"));
  const path = join(root, "scopeguard.db");
  try {
    const original = new ScopeGuardStore(path);
    const fixture = createWorkspaceFixture(original, 2);
    const layout = original.saveWorkspaceLayout({
      workspaceId: fixture.workspace.id,
      openConversationIds: fixture.conversations.map(({ id }) => id),
      paneConversationIds: fixture.conversations.map(({ id }) => id),
      paneWidths: [440, 560],
      activeConversationId: fixture.conversations[1]!.id,
      requestedPaneCount: 2,
    });
    original.close();

    const v1 = new DatabaseSync(path);
    v1.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE center_state;
      DROP TABLE artifact_versions;
      DROP TABLE artifacts;
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        metadata_json TEXT NOT NULL
      ) STRICT;
      UPDATE schema_metadata SET schema_version = 1;
      COMMIT;
    `);
    v1.close();

    const migrated = new ScopeGuardStore(path);
    assert.equal(migrated.listWorkspaces().length, 1);
    assert.equal(migrated.listConversations(fixture.workspace.id).length, 2);
    assert.deepEqual(migrated.getWorkspaceLayout(fixture.workspace.id), layout);
    assert.deepEqual(migrated.listArtifacts(fixture.workspace.id), []);
    assert.deepEqual(migrated.listWorkspaceCenterStates(), []);
    migrated.close();

    const verified = new DatabaseSync(path);
    const metadata = verified.prepare("SELECT schema_id, schema_version FROM schema_metadata").get() as {
      schema_id: string;
      schema_version: number;
    };
    verified.close();
    assert.equal(metadata.schema_id, SCOPEGUARD_SCHEMA_ID);
    assert.equal(metadata.schema_version, SCOPEGUARD_SCHEMA_VERSION);
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

test("persists and restores a strict Workspace layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-layout-roundtrip-"));
  const path = join(root, "scopeguard.db");
  try {
    const store = new ScopeGuardStore(path);
    const { workspace, conversations } = createWorkspaceFixture(store, 2);
    const layout = store.saveWorkspaceLayout({
      workspaceId: workspace.id,
      openConversationIds: conversations.map(({ id }) => id),
      paneConversationIds: conversations.map(({ id }) => id).reverse(),
      paneWidths: [480, 360],
      activeConversationId: conversations[1]!.id,
      requestedPaneCount: 2,
    });
    assert.deepEqual(store.getWorkspaceLayout(workspace.id), layout);
    store.close();

    const reopened = new ScopeGuardStore(path);
    assert.deepEqual(reopened.getWorkspaceLayout(workspace.id), layout);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists and restores five open Conversations with only four visible panes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-five-conversation-layout-"));
  const path = join(root, "scopeguard.db");
  try {
    const store = new ScopeGuardStore(path);
    const { workspace, conversations } = createWorkspaceFixture(store, 5);
    const ids = conversations.map(({ id }) => id);
    const layout = store.saveWorkspaceLayout({
      workspaceId: workspace.id,
      openConversationIds: ids,
      paneConversationIds: [ids[0]!, ids[4]!, ids[2]!, ids[3]!],
      paneWidths: [360, 420, 480, 540],
      activeConversationId: ids[4]!,
      requestedPaneCount: 4,
    });
    assert.equal(layout.openConversationIds.length, 5);
    assert.equal(layout.paneConversationIds.length, 4);
    store.close();

    const reopened = new ScopeGuardStore(path);
    assert.deepEqual(reopened.getWorkspaceLayout(workspace.id), layout);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate, cross-Workspace, and malformed persisted layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-layout-rejection-"));
  try {
    const store = new ScopeGuardStore(":memory:");
    const first = createWorkspaceFixture(store, 1);
    const second = createWorkspaceFixture(store, 1);
    assert.throws(() => store.saveWorkspaceLayout({
      workspaceId: first.workspace.id,
      openConversationIds: [first.conversations[0]!.id, first.conversations[0]!.id],
      paneConversationIds: [first.conversations[0]!.id],
      paneWidths: [420],
      activeConversationId: first.conversations[0]!.id,
      requestedPaneCount: 1,
    }), /duplicate/i);
    assert.throws(() => store.saveWorkspaceLayout({
      workspaceId: first.workspace.id,
      openConversationIds: [second.conversations[0]!.id],
      paneConversationIds: [second.conversations[0]!.id],
      paneWidths: [420],
      activeConversationId: second.conversations[0]!.id,
      requestedPaneCount: 1,
    }), /outside its Workspace/i);
    store.close();

    for (const index of [0, 1, 2]) {
      const path = join(root, `malformed-${index}.db`);
      const disk = new ScopeGuardStore(path);
      const fixture = createWorkspaceFixture(disk, 1);
      disk.close();
      const conversationId = fixture.conversations[0]!.id;
      const state = [
        { workspaceId: fixture.workspace.id, openConversationIds: [], paneConversationIds: [], paneWidths: [], activeConversationId: null, requestedPaneCount: 1, extra: true },
        { workspaceId: fixture.workspace.id, openConversationIds: [conversationId, conversationId], paneConversationIds: [conversationId], paneWidths: [420], activeConversationId: conversationId, requestedPaneCount: 1 },
        { workspaceId: fixture.workspace.id, openConversationIds: [conversationId], paneConversationIds: [conversationId], paneWidths: [420], activeConversationId: "missing", requestedPaneCount: 1 },
      ][index]!;
      const database = new DatabaseSync(path);
      database.prepare("INSERT INTO layout_state VALUES (?, ?)").run(
        fixture.workspace.id,
        JSON.stringify(state),
      );
      database.close();
      assert.throws(() => new ScopeGuardStore(path), /Incompatible ScopeGuard database/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists Dispatch status and validates Conversation ownership", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const first = createWorkspaceFixture(store, 2);
    const second = createWorkspaceFixture(store, 1);
    const dispatch = store.createDispatch({
      workspaceId: first.workspace.id,
      sourceConversationId: first.conversations[0]!.id,
      targetConversationId: first.conversations[1]!.id,
      prompt: "Review the backend result.",
    });
    assert.equal(dispatch.status, "pending");
    const running = store.updateDispatchStatus(dispatch.id, "running");
    assert.equal(running.status, "running");
    const completed = store.updateDispatchStatus(dispatch.id, "completed");
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      store.listDispatches({ conversationId: first.conversations[0]!.id }),
      [completed],
    );
    assert.deepEqual(
      store.listDispatches({ conversationId: first.conversations[1]!.id }),
      [completed],
    );
    assert.throws(
      () => store.updateDispatchStatus(dispatch.id, "running"),
      /Invalid Dispatch status transition/,
    );
    assert.throws(() => store.createDispatch({
      workspaceId: first.workspace.id,
      sourceConversationId: first.conversations[0]!.id,
      targetConversationId: second.conversations[0]!.id,
      prompt: "Cross Workspace",
    }), /same Workspace/i);
    assert.throws(() => store.createDispatch({
      workspaceId: first.workspace.id,
      sourceConversationId: first.conversations[0]!.id,
      targetConversationId: first.conversations[0]!.id,
      prompt: "Self Dispatch",
    }), /different Conversation/i);
  } finally {
    store.close();
  }
});

test("rejects malformed persisted Dispatch metadata on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-dispatch-rejection-"));
  try {
    for (const [index, mutate] of [
      (value: Record<string, unknown>) => ({ ...value, status: "bogus" }),
      (value: Record<string, unknown>) => ({ ...value, id: "wrong-id" }),
      (value: Record<string, unknown>) => ({ ...value, prompt: "  " }),
      (value: Record<string, unknown>) => ({ ...value, transcript: [] }),
    ].entries()) {
      const path = join(root, `malformed-${index}.db`);
      const store = new ScopeGuardStore(path);
      const fixture = createWorkspaceFixture(store, 2);
      const dispatch = store.createDispatch({
        workspaceId: fixture.workspace.id,
        sourceConversationId: fixture.conversations[0]!.id,
        targetConversationId: fixture.conversations[1]!.id,
        prompt: "Review this result.",
      });
      store.close();

      const database = new DatabaseSync(path);
      const row = database.prepare(
        "SELECT metadata_json FROM dispatches WHERE id = ?",
      ).get(dispatch.id) as { metadata_json: string };
      database.prepare("UPDATE dispatches SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify(mutate(JSON.parse(row.metadata_json) as Record<string, unknown>)),
        dispatch.id,
      );
      database.close();
      assert.throws(() => new ScopeGuardStore(path), /Incompatible ScopeGuard database/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists immutable Artifact Versions, provenance, current selection, and Review state", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-artifact-roundtrip-"));
  const path = join(root, "scopeguard.db");
  try {
    const store = new ScopeGuardStore(path);
    const fixture = createWorkspaceFixture(store, 2);
    const firstRun = createTerminalRun(store, fixture, "completed", "confirmed");
    const secondRun = createTerminalRun(store, fixture, "completed", "confirmed");
    const artifact = store.createArtifact({
      workspaceId: fixture.workspace.id,
      title: "Quarterly report",
      format: "docx",
      sourceRelativePath: "reports/quarter.docx",
      associatedConversationId: fixture.conversations[0]!.id,
    });
    const first = store.createArtifactVersion({
      artifactId: artifact.id,
      source: {
        workspaceId: fixture.workspace.id,
        relativePath: "reports/quarter.docx",
        contentHash: "a".repeat(64),
        byteSize: 40,
      },
      contentHash: "a".repeat(64),
      byteSize: 40,
      producedByConversationId: fixture.conversations[0]!.id,
      producedByRunId: firstRun.id,
      toolchain: "import",
      validationStatus: "passed",
      validationSummary: "The source reopened with readable content.",
    }, `aa/${"a".repeat(64)}`);
    const second = store.createArtifactVersion({
      artifactId: artifact.id,
      parentVersionId: first.id,
      source: {
        workspaceId: fixture.workspace.id,
        relativePath: "reports/quarter.docx",
        contentHash: "a".repeat(64),
        byteSize: 40,
      },
      contentHash: "b".repeat(64),
      byteSize: 41,
      producedByConversationId: fixture.conversations[0]!.id,
      producedByRunId: secondRun.id,
      toolchain: "Agent Skill: documents",
      limitations: ["External viewer required."],
      validationStatus: "passed",
      validationSummary: "The revised source reopened with readable content.",
    }, `bb/${"b".repeat(64)}`);
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(store.getArtifact(artifact.id)?.currentVersionId, second.id);
    assert.equal(store.setArtifactCurrentVersion(artifact.id, first.id).currentVersionId, first.id);
    assert.throws(() => store.saveWorkspaceCenterState({
      workspaceId: fixture.workspace.id,
      mode: "artifact-review",
      artifactId: artifact.id,
      versionId: second.id,
      comparisonVersionId: first.id,
      associatedConversationId: fixture.conversations[1]!.id,
      conversationPanelOpen: true,
    }), /must match the Artifact association/i);
    assert.throws(() => store.saveWorkspaceCenterState({
      workspaceId: fixture.workspace.id,
      mode: "artifact-review",
      artifactId: artifact.id,
      versionId: second.id,
      comparisonVersionId: first.id,
      associatedConversationId: null,
      conversationPanelOpen: true,
    }), /without an association/i);
    const review = store.saveWorkspaceCenterState({
      workspaceId: fixture.workspace.id,
      mode: "artifact-review",
      artifactId: artifact.id,
      versionId: second.id,
      comparisonVersionId: first.id,
      associatedConversationId: fixture.conversations[0]!.id,
      conversationPanelOpen: true,
    });
    assert.equal(review.mode, "artifact-review");
    store.close();

    const reopened = new ScopeGuardStore(path);
    assert.equal(reopened.listArtifacts(fixture.workspace.id).length, 1);
    assert.deepEqual(reopened.listArtifactVersions(artifact.id), [first, second]);
    assert.deepEqual(reopened.getWorkspaceCenterState(fixture.workspace.id), review);
    assert.equal(reopened.getArtifactVersionStorageKey(second.id), `bb/${"b".repeat(64)}`);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects cross-Workspace Artifact provenance and Review selections", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const first = createWorkspaceFixture(store, 1);
    const second = createWorkspaceFixture(store, 1);
    const run = createTerminalRun(store, first, "completed", "confirmed");
    assert.throws(() => store.createArtifact({
      workspaceId: first.workspace.id,
      title: "Wrong owner",
      format: "pdf",
      associatedConversationId: second.conversations[0]!.id,
    }), /must belong to its Workspace/i);
    const artifact = store.createArtifact({
      workspaceId: first.workspace.id,
      title: "Report",
      format: "pdf",
    });
    assert.throws(() => store.createArtifactVersion({
      artifactId: artifact.id,
      source: {
        workspaceId: second.workspace.id,
        relativePath: "report.pdf",
        contentHash: "c".repeat(64),
        byteSize: 1,
      },
      contentHash: "c".repeat(64),
      byteSize: 1,
      producedByConversationId: first.conversations[0]!.id,
      producedByRunId: run.id,
      toolchain: "import",
      validationStatus: "passed",
      validationSummary: "The output reopened.",
    }, `cc/${"c".repeat(64)}`), /source must belong/i);
  } finally {
    store.close();
  }
});

test("rejects Artifact Versions backed by an unconfirmed Run at the storage boundary", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const fixture = createWorkspaceFixture(store, 1);
    const artifact = store.createArtifact({
      workspaceId: fixture.workspace.id,
      title: "Unconfirmed output",
      format: "txt",
    });
    const run = createTerminalRun(store, fixture, "completed", "none");
    assert.throws(() => store.createArtifactVersion({
      artifactId: artifact.id,
      contentHash: "d".repeat(64),
      byteSize: 1,
      producedByConversationId: fixture.conversations[0]!.id,
      producedByRunId: run.id,
      toolchain: "Agent write Tool",
      validationStatus: "passed",
      validationSummary: "The output reopened.",
    }, `dd/${"d".repeat(64)}`), /confirmed Tool effects/i);
  } finally {
    store.close();
  }
});

test("rejects Artifact Run provenance without its producing Conversation", () => {
  const store = new ScopeGuardStore(":memory:");
  try {
    const fixture = createWorkspaceFixture(store, 1);
    const artifact = store.createArtifact({
      workspaceId: fixture.workspace.id,
      title: "Incomplete provenance",
      format: "txt",
    });
    const run = createTerminalRun(store, fixture, "completed", "confirmed");
    const incomplete = {
      artifactId: artifact.id,
      contentHash: "f".repeat(64),
      byteSize: 1,
      producedByRunId: run.id,
      toolchain: "Agent write Tool",
      validationStatus: "passed",
      validationSummary: "The output reopened.",
    } as unknown as Parameters<ScopeGuardStore["createArtifactVersion"]>[0];
    assert.throws(
      () => store.createArtifactVersion(incomplete, `ff/${"f".repeat(64)}`),
      /producing Conversation/i,
    );
  } finally {
    store.close();
  }
});

test("keeps Artifact provenance Runs in the snapshot after they leave the recent window", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-artifact-run-snapshot-"));
  const path = join(root, "scopeguard.db");
  try {
    const store = new ScopeGuardStore(path);
    const fixture = createWorkspaceFixture(store, 1);
    const provenanceRun = createTerminalRun(store, fixture, "completed", "confirmed");
    const artifact = store.createArtifact({
      workspaceId: fixture.workspace.id,
      title: "Durable provenance",
      format: "txt",
    });
    store.createArtifactVersion({
      artifactId: artifact.id,
      contentHash: "e".repeat(64),
      byteSize: 1,
      producedByConversationId: fixture.conversations[0]!.id,
      producedByRunId: provenanceRun.id,
      toolchain: "Agent write Tool",
      validationStatus: "passed",
      validationSummary: "The output reopened.",
    }, `ee/${"e".repeat(64)}`);
    for (let index = 0; index < 100; index += 1) {
      createTerminalRun(store, fixture, "completed", "confirmed");
    }
    store.close();

    const database = new DatabaseSync(path);
    database.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      provenanceRun.id,
    );
    database.close();

    const reopened = new ScopeGuardStore(path);
    assert.equal(
      reopened.listRecentRuns().some(({ id }) => id === provenanceRun.id),
      false,
    );
    assert.equal(
      reopened.getWorkspaceSnapshot().recentRuns.some(({ id }) => id === provenanceRun.id),
      true,
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createWorkspaceFixture(store: ScopeGuardStore, conversationCount: number) {
  const workspace = store.createWorkspace({ name: `Workspace ${Math.random()}` });
  const provider = store.saveProviderProfile({
    name: `Provider ${Math.random()}`,
    protocol: "openai-compatible",
    baseUrl: "http://localhost/v1",
    defaultModel: "model",
  }, null);
  const agent = store.createAgent({
    workspaceId: workspace.id,
    name: "Agent",
    instructions: "",
    providerProfileId: provider.id,
  });
  const conversations = Array.from({ length: conversationCount }, (_, index) =>
    store.createConversation({
      workspaceId: workspace.id,
      agentId: agent.id,
      title: `Conversation ${index + 1}`,
    })
  );
  return { workspace, provider, agent, conversations };
}

function createTerminalRun(
  store: ScopeGuardStore,
  fixture: ReturnType<typeof createWorkspaceFixture>,
  status: "completed" | "failed",
  effect: "none" | "confirmed" | "effect_unknown",
) {
  const run = store.createRun(fixture.conversations[0]!.id, {
    agentId: fixture.agent.id,
    providerProfileId: fixture.provider.id,
    providerProtocol: fixture.provider.protocol,
    providerBaseUrl: fixture.provider.baseUrl,
    model: fixture.provider.defaultModel,
    instructions: fixture.agent.instructions,
    executionProfile: fixture.conversations[0]!.executionProfile,
    toolPolicy: fixture.agent.toolPolicy,
  });
  store.updateRunStatus(run.id, "preparing");
  store.updateRunStatus(run.id, "running", undefined, effect);
  return store.updateRunStatus(
    run.id,
    status,
    status === "failed" ? "Tool failed." : undefined,
    effect,
  );
}
