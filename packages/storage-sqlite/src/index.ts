import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  SCOPEGUARD_SCHEMA_ID,
  SCOPEGUARD_SCHEMA_VERSION,
  assertRunTransition,
  mergeToolPolicy,
  parseAgentToolPolicy,
  parseConversationExecutionProfile,
  type Agent,
  type AgentRun,
  type ApprovalDecision,
  type Conversation,
  type ConversationExecutionProfile,
  type CreateAgentInput,
  type CreateConversationInput,
  type CreateWorkspaceInput,
  type Id,
  type PiSessionLocator,
  type ProviderProfile,
  type ProviderProfileInput,
  type RunConfigSnapshot,
  type RunStatus,
  type ToolApproval,
  type ToolCallRecord,
  type UpdateConversationSettingsInput,
  type Workspace,
  type WorkspaceContextRevision,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

type Row = Record<string, unknown>;
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled", "interrupted"];
const EXPECTED_SCHEMA_COLUMNS = {
  agents: ["id", "workspace_id", "name", "instructions", "provider_profile_id", "model_override", "default_execution_profile", "tool_policy_json", "created_at", "updated_at"],
  artifacts: ["id", "workspace_id", "metadata_json"],
  conversations: ["id", "workspace_id", "agent_id", "title", "status", "model_override", "execution_profile", "pi_session_file", "pi_session_id", "pi_version", "pi_session_version", "created_at", "updated_at"],
  dispatches: ["id", "workspace_id", "metadata_json"],
  layout_state: ["workspace_id", "state_json"],
  provider_profiles: ["id", "name", "protocol", "base_url", "default_model", "api_key_ref", "created_at", "updated_at"],
  runs: ["id", "conversation_id", "config_snapshot_json", "status", "started_at", "completed_at", "error", "effect", "created_at"],
  schema_metadata: ["schema_id", "schema_version", "created_at"],
  tool_approvals: ["id", "run_id", "status", "reason", "process_id", "request_id", "pi_tool_call_id", "tool_name", "canonical_input_json", "canonical_input_sha256", "created_at", "tool_call_id", "resolved_at"],
  workspace_context_revisions: ["id", "workspace_id", "version", "parent_id", "title", "content", "source_conversation_id", "source_run_id", "published_by", "created_at"],
  workspaces: ["id", "name", "local_root_path", "current_context_revision_id", "created_at", "updated_at", "last_opened_at"],
} as const;
const ACTIVE_RUN_INDEX_NAME = "one_active_run_per_conversation";
const ACTIVE_RUN_INDEX_SQL = `CREATE UNIQUE INDEX ${ACTIVE_RUN_INDEX_NAME} ON runs(conversation_id)
  WHERE status NOT IN ('completed','failed','cancelled','interrupted')`;

export class ScopeGuardStore {
  readonly #database: DatabaseSync;
  readonly #databasePath: string | null;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#databasePath = databasePath === ":memory:" ? null : databasePath;
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      if (this.#databasePath) this.#database.exec("PRAGMA journal_mode = WAL");
      this.#initializeSchema();
      this.#secureFiles();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
    this.#secureFiles();
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return {
      workspaces: this.listWorkspaces(),
      providerProfiles: this.listProviderProfiles(),
      agents: this.listAgents(),
      conversations: this.listConversations(),
      activeRuns: this.listActiveRuns(),
      recentRuns: this.listRecentRuns(),
      pendingApprovals: this.listPendingApprovals().map((approval) => ({
        approval,
        toolCall: approvalToolCall(approval),
      })),
    };
  }

  listWorkspaces(): Workspace[] {
    return this.#all("SELECT * FROM workspaces ORDER BY last_opened_at DESC").map(mapWorkspace);
  }

  getWorkspace(id: Id): Workspace | null {
    return mapNullable(this.#get("SELECT * FROM workspaces WHERE id = ?", id), mapWorkspace);
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const now = nowIso();
    const root = input.localRootPath?.trim() || null;
    if (root) {
      const existing = this.#get("SELECT id FROM workspaces WHERE local_root_path = ?", root);
      if (existing) return this.getWorkspace(asString(existing.id))!;
    }
    const workspace: Workspace = {
      id: randomUUID(), name: input.name.trim(), localRootPath: root,
      currentContextRevisionId: null, createdAt: now, updatedAt: now, lastOpenedAt: now,
    };
    this.#run(
      "INSERT INTO workspaces VALUES (?, ?, ?, NULL, ?, ?, ?)",
      workspace.id, workspace.name, workspace.localRootPath,
      workspace.createdAt, workspace.updatedAt, workspace.lastOpenedAt,
    );
    return workspace;
  }

  listProviderProfiles(): ProviderProfile[] {
    return this.#all("SELECT * FROM provider_profiles ORDER BY updated_at DESC").map(mapProvider);
  }

  getProviderProfile(id: Id): ProviderProfile | null {
    return mapNullable(this.#get("SELECT * FROM provider_profiles WHERE id = ?", id), mapProvider);
  }

  saveProviderProfile(input: ProviderProfileInput & { id?: Id }, apiKeyRef: string | null): ProviderProfile {
    const existing = input.id ? this.getProviderProfile(input.id) : null;
    const now = nowIso();
    const profile: ProviderProfile = {
      id: input.id ?? randomUUID(), name: input.name.trim(), protocol: input.protocol,
      baseUrl: input.baseUrl, defaultModel: input.defaultModel.trim(), apiKeyRef,
      customHeaders: {}, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.#run(
      `INSERT INTO provider_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, protocol=excluded.protocol,
       base_url=excluded.base_url, default_model=excluded.default_model,
       api_key_ref=excluded.api_key_ref, updated_at=excluded.updated_at`,
      profile.id, profile.name, profile.protocol, profile.baseUrl, profile.defaultModel,
      profile.apiKeyRef, profile.createdAt, profile.updatedAt,
    );
    return profile;
  }

  deleteProviderProfile(id: Id): void {
    this.#run("DELETE FROM provider_profiles WHERE id = ?", id);
  }

  listAgents(workspaceId?: Id): Agent[] {
    const rows = workspaceId
      ? this.#all("SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at", workspaceId)
      : this.#all("SELECT * FROM agents ORDER BY created_at");
    return rows.map(mapAgent);
  }

  getAgent(id: Id): Agent | null {
    return mapNullable(this.#get("SELECT * FROM agents WHERE id = ?", id), mapAgent);
  }

  createAgent(input: CreateAgentInput): Agent {
    const now = nowIso();
    const agent: Agent = {
      id: randomUUID(), workspaceId: input.workspaceId, name: input.name.trim(),
      instructions: input.instructions.trim(), providerProfileId: input.providerProfileId,
      modelOverride: input.modelOverride?.trim() || null,
      defaultExecutionProfile: parseConversationExecutionProfile(
        input.executionProfile ?? "request-approval",
      ),
      toolPolicy: mergeToolPolicy(input.toolPolicy), createdAt: now, updatedAt: now,
    };
    this.#run(
      "INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      agent.id, agent.workspaceId, agent.name, agent.instructions, agent.providerProfileId,
      agent.modelOverride, agent.defaultExecutionProfile, JSON.stringify(agent.toolPolicy), now, now,
    );
    return agent;
  }

  listConversations(workspaceId?: Id): Conversation[] {
    const rows = workspaceId
      ? this.#all("SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC", workspaceId)
      : this.#all("SELECT * FROM conversations ORDER BY updated_at DESC");
    return rows.map(mapConversation);
  }

  getConversation(id: Id): Conversation | null {
    return mapNullable(this.#get("SELECT * FROM conversations WHERE id = ?", id), mapConversation);
  }

  createConversation(input: CreateConversationInput): Conversation {
    const agent = this.getAgent(input.agentId);
    if (!agent || agent.workspaceId !== input.workspaceId) {
      throw new Error("Agent and Conversation must belong to the same Workspace.");
    }
    const now = nowIso();
    const conversation: Conversation = {
      id: randomUUID(), workspaceId: input.workspaceId, agentId: input.agentId,
      title: input.title?.trim() || "New conversation", status: "active",
      modelOverride: null, executionProfile: agent.defaultExecutionProfile,
      piSession: null, createdAt: now, updatedAt: now,
    };
    this.#run(
      `INSERT INTO conversations (
        id, workspace_id, agent_id, title, status, model_override, execution_profile,
        pi_session_file, pi_session_id, pi_version, pi_session_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      conversation.id, conversation.workspaceId, conversation.agentId, conversation.title,
      conversation.status, conversation.modelOverride, conversation.executionProfile, now, now,
    );
    return conversation;
  }

  updateConversationSettings(input: UpdateConversationSettingsInput): Conversation {
    const current = this.requireConversation(input.conversationId);
    const updated = {
      ...current,
      modelOverride: input.modelOverride === undefined ? current.modelOverride : input.modelOverride,
      executionProfile: parseConversationExecutionProfile(
        input.executionProfile ?? current.executionProfile,
      ),
      updatedAt: nowIso(),
    };
    this.#run(
      "UPDATE conversations SET model_override = ?, execution_profile = ?, updated_at = ? WHERE id = ?",
      updated.modelOverride, updated.executionProfile, updated.updatedAt, updated.id,
    );
    return updated;
  }

  setConversationSession(id: Id, locator: PiSessionLocator): Conversation {
    this.#run(
      `UPDATE conversations SET pi_session_file=?, pi_session_id=?, pi_version=?,
       pi_session_version=?, updated_at=? WHERE id=?`,
      locator.sessionFile, locator.sessionId, locator.piVersion, locator.sessionVersion, nowIso(), id,
    );
    return this.requireConversation(id);
  }

  createRun(conversationId: Id, configSnapshot: RunConfigSnapshot): AgentRun {
    const now = nowIso();
    const run: AgentRun = {
      id: randomUUID(), conversationId, triggerMessageId: randomUUID(), contextRevisionId: null,
      configSnapshot: structuredClone(configSnapshot), status: "queued", startedAt: null,
      completedAt: null, error: null, effect: "none", createdAt: now,
    };
    this.#run(
      "INSERT INTO runs VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
      run.id, run.conversationId, JSON.stringify(run.configSnapshot), run.status,
      run.effect, run.createdAt,
    );
    return run;
  }

  getRun(id: Id): AgentRun | null {
    return mapNullable(this.#get("SELECT * FROM runs WHERE id = ?", id), mapRun);
  }

  listActiveRuns(): AgentRun[] {
    return this.#all(
      `SELECT * FROM runs WHERE status NOT IN (${placeholders(TERMINAL.length)}) ORDER BY created_at`,
      ...TERMINAL,
    ).map(mapRun);
  }

  listRecentRuns(limit = 100): AgentRun[] {
    return this.#all("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", limit).map(mapRun);
  }

  updateRunStatus(id: Id, status: RunStatus, error?: string, effect?: AgentRun["effect"]): AgentRun {
    const current = this.requireRun(id);
    if (status !== current.status) assertRunTransition(current.status, status);
    const now = nowIso();
    const startedAt = current.startedAt ?? (status === "queued" ? null : now);
    const completedAt = TERMINAL.includes(status) ? now : null;
    const nextEffect = effect ?? current.effect;
    const nextError = error ?? current.error;
    this.#run(
      "UPDATE runs SET status=?, started_at=?, completed_at=?, error=?, effect=? WHERE id=?",
      status, startedAt, completedAt, nextError, nextEffect, id,
    );
    return { ...current, status, startedAt, completedAt, error: nextError, effect: nextEffect };
  }

  interruptNonTerminalRuns(): number {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const interrupted = Number(this.#run(
        `UPDATE runs SET status='interrupted', completed_at=?,
         error=COALESCE(error, 'ScopeGuard restarted before this Run completed.')
         WHERE status NOT IN (${placeholders(TERMINAL.length)})`,
        nowIso(), ...TERMINAL,
      ).changes);
      this.#run(
        `UPDATE tool_approvals SET status='expired', resolved_at=?
         WHERE status='pending' AND run_id IN (SELECT id FROM runs WHERE status='interrupted')`,
        nowIso(),
      );
      this.#database.exec("COMMIT");
      return interrupted;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  createApproval(runId: Id, request: Omit<ToolApproval, "id" | "runId" | "status" | "createdAt" | "resolvedAt">): ToolApproval {
    const approval: ToolApproval = {
      id: randomUUID(), runId, status: "pending", createdAt: nowIso(), resolvedAt: null, ...request,
    };
    this.#run(
      "INSERT INTO tool_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      approval.id, approval.runId, approval.status, approval.reason, approval.processId,
      approval.requestId, approval.piToolCallId, approval.toolName,
      JSON.stringify(approval.canonicalInput), approval.canonicalInputSha256,
      approval.createdAt, approval.toolCallId,
    );
    return approval;
  }

  getApproval(id: Id): ToolApproval | null {
    return mapNullable(this.#get("SELECT * FROM tool_approvals WHERE id = ?", id), mapApproval);
  }

  listPendingApprovals(): ToolApproval[] {
    return this.#all("SELECT * FROM tool_approvals WHERE status='pending' ORDER BY created_at").map(mapApproval);
  }

  resolveApproval(id: Id, decision: ApprovalDecision): ToolApproval {
    const current = this.getApproval(id);
    if (!current || current.status !== "pending") throw new Error("Approval is no longer pending.");
    const status = decision === "approved-once" ? "approved" : "denied";
    const resolvedAt = nowIso();
    this.#run("UPDATE tool_approvals SET status=?, resolved_at=? WHERE id=?", status, resolvedAt, id);
    return { ...current, status, resolvedAt };
  }

  expireApproval(id: Id): ToolApproval {
    const current = this.getApproval(id);
    if (!current || current.status !== "pending") throw new Error("Approval is no longer pending.");
    const resolvedAt = nowIso();
    this.#run("UPDATE tool_approvals SET status='expired', resolved_at=? WHERE id=?", resolvedAt, id);
    return { ...current, status: "expired", resolvedAt };
  }

  expirePendingApprovalsForRun(runId: Id): number {
    return Number(this.#run(
      "UPDATE tool_approvals SET status='expired', resolved_at=? WHERE run_id=? AND status='pending'",
      nowIso(), runId,
    ).changes);
  }

  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null {
    return mapNullable(this.#get(
      "SELECT * FROM workspace_context_revisions WHERE workspace_id=? ORDER BY version DESC LIMIT 1",
      workspaceId,
    ), mapContext);
  }

  updateWorkspaceContext(
    workspaceId: Id,
    content: string,
    sourceConversationId: Id | null = null,
    sourceRunId: Id | null = null,
  ): WorkspaceContextRevision {
    const current = this.getWorkspaceContext(workspaceId);
    const revision: WorkspaceContextRevision = {
      id: randomUUID(), workspaceId, version: (current?.version ?? 0) + 1,
      parentId: current?.id ?? null, title: `Workspace context v${(current?.version ?? 0) + 1}`,
      content, sourceConversationId, sourceRunId, publishedBy: sourceRunId ? "agent" : "user",
      createdAt: nowIso(),
    };
    this.#run(
      "INSERT INTO workspace_context_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      revision.id, revision.workspaceId, revision.version, revision.parentId, revision.title,
      revision.content, revision.sourceConversationId, revision.sourceRunId,
      revision.publishedBy, revision.createdAt,
    );
    this.#run("UPDATE workspaces SET current_context_revision_id=?, updated_at=? WHERE id=?", revision.id, revision.createdAt, workspaceId);
    return revision;
  }

  listSchemaTables(): string[] {
    return this.#all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => asString(row.name));
  }

  requireConversation(id: Id): Conversation {
    const value = this.getConversation(id);
    if (!value) throw new Error(`Conversation not found: ${id}`);
    return value;
  }

  requireRun(id: Id): AgentRun {
    const value = this.getRun(id);
    if (!value) throw new Error(`Run not found: ${id}`);
    return value;
  }

  #initializeSchema(): void {
    const tables = this.listSchemaTables();
    if (tables.length > 0) {
      if (!tables.includes("schema_metadata")) throw incompatibleSchema();
      const columns = this.#all("PRAGMA table_info(schema_metadata)").map((row) => asString(row.name));
      if (!columns.includes("schema_id") || !columns.includes("schema_version")) throw incompatibleSchema();
      const metadata = this.#get("SELECT schema_id, schema_version FROM schema_metadata");
      if (
        !metadata || asString(metadata.schema_id) !== SCOPEGUARD_SCHEMA_ID ||
        asNumber(metadata.schema_version) !== SCOPEGUARD_SCHEMA_VERSION
      ) throw incompatibleSchema();
      this.#validateSchema();
      return;
    }
    this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE schema_metadata (schema_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_metadata VALUES ('${SCOPEGUARD_SCHEMA_ID}', ${SCOPEGUARD_SCHEMA_VERSION}, '${nowIso()}');
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, local_root_path TEXT UNIQUE,
        current_context_revision_id TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, default_model TEXT NOT NULL, api_key_ref TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL, instructions TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id), model_override TEXT,
        default_execution_profile TEXT NOT NULL, tool_policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id), title TEXT NOT NULL, status TEXT NOT NULL,
        model_override TEXT, execution_profile TEXT NOT NULL, pi_session_file TEXT,
        pi_session_id TEXT, pi_version TEXT, pi_session_version INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK ((pi_session_file IS NULL AND pi_session_id IS NULL AND pi_version IS NULL AND pi_session_version IS NULL)
          OR (pi_session_file IS NOT NULL AND pi_session_id IS NOT NULL AND pi_version IS NOT NULL AND pi_session_version IS NOT NULL))
      ) STRICT;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        config_snapshot_json TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT,
        completed_at TEXT, error TEXT, effect TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_active_run_per_conversation ON runs(conversation_id)
        WHERE status NOT IN ('completed','failed','cancelled','interrupted');
      CREATE TABLE tool_approvals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL, reason TEXT NOT NULL, process_id TEXT NOT NULL,
        request_id TEXT NOT NULL, pi_tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        canonical_input_json TEXT NOT NULL, canonical_input_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL, tool_call_id TEXT NOT NULL, resolved_at TEXT,
        UNIQUE(process_id, request_id), UNIQUE(process_id, pi_tool_call_id, canonical_input_sha256)
      ) STRICT;
      CREATE TABLE workspace_context_revisions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, parent_id TEXT, title TEXT NOT NULL, content TEXT NOT NULL,
        source_conversation_id TEXT, source_run_id TEXT, published_by TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(workspace_id, version)
      ) STRICT;
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), metadata_json TEXT NOT NULL) STRICT;
      CREATE TABLE dispatches (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), metadata_json TEXT NOT NULL) STRICT;
      CREATE TABLE layout_state (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), state_json TEXT NOT NULL) STRICT;
      COMMIT;
    `);
    this.#validateSchema();
  }

  #validateSchema(): void {
    const expectedTables = Object.keys(EXPECTED_SCHEMA_COLUMNS).sort();
    if (JSON.stringify(this.listSchemaTables()) !== JSON.stringify(expectedTables)) {
      throw incompatibleSchema();
    }
    for (const [table, expectedColumns] of Object.entries(EXPECTED_SCHEMA_COLUMNS)) {
      const actualColumns = this.#all(`PRAGMA table_info(${table})`).map((row) => asString(row.name));
      if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
        throw incompatibleSchema();
      }
    }
    const activeRunIndex = this.#all("PRAGMA index_list(runs)")
      .find((row) => row.name === ACTIVE_RUN_INDEX_NAME);
    if (
      !activeRunIndex ||
      asNumber(activeRunIndex.unique) !== 1 ||
      asNumber(activeRunIndex.partial) !== 1 ||
      asString(activeRunIndex.origin) !== "c"
    ) {
      throw incompatibleSchema();
    }
    const activeRunIndexColumns = this.#all(`PRAGMA index_info(${ACTIVE_RUN_INDEX_NAME})`)
      .map((row) => asString(row.name));
    const activeRunIndexDefinition = this.#get(
      "SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND name=?",
      ACTIVE_RUN_INDEX_NAME,
    );
    if (
      JSON.stringify(activeRunIndexColumns) !== JSON.stringify(["conversation_id"]) ||
      !activeRunIndexDefinition ||
      asString(activeRunIndexDefinition.tbl_name) !== "runs" ||
      typeof activeRunIndexDefinition.sql !== "string" ||
      normalizeSchemaSql(activeRunIndexDefinition.sql) !== normalizeSchemaSql(ACTIVE_RUN_INDEX_SQL)
    ) {
      throw incompatibleSchema();
    }
    try {
      this.#all("SELECT * FROM agents").forEach(mapAgent);
      this.#all("SELECT * FROM conversations").forEach(mapConversation);
    } catch {
      throw incompatibleSchema();
    }
    const integrity = this.#get("PRAGMA quick_check");
    if (!integrity || asString(integrity.quick_check) !== "ok") {
      throw new Error("ScopeGuard database integrity check failed; the database was not opened.");
    }
  }

  #run(sql: string, ...values: SQLInputValue[]) { return this.#database.prepare(sql).run(...values); }
  #get(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.#database.prepare(sql).get(...values) as Row | undefined; }
  #all(sql: string, ...values: SQLInputValue[]): Row[] { return this.#database.prepare(sql).all(...values) as Row[]; }

  #secureFiles(): void {
    if (!this.#databasePath || process.platform === "win32") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(`${this.#databasePath}${suffix}`, 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function mapWorkspace(row: Row): Workspace {
  return {
    id: asString(row.id), name: asString(row.name), localRootPath: asNullableString(row.local_root_path),
    currentContextRevisionId: asNullableString(row.current_context_revision_id),
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at), lastOpenedAt: asString(row.last_opened_at),
  };
}

function mapProvider(row: Row): ProviderProfile {
  return {
    id: asString(row.id), name: asString(row.name), protocol: asString(row.protocol) as ProviderProfile["protocol"],
    baseUrl: asString(row.base_url), defaultModel: asString(row.default_model),
    apiKeyRef: asNullableString(row.api_key_ref), customHeaders: {},
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function mapAgent(row: Row): Agent {
  return {
    id: asString(row.id), workspaceId: asString(row.workspace_id), name: asString(row.name),
    instructions: asString(row.instructions), providerProfileId: asString(row.provider_profile_id),
    modelOverride: asNullableString(row.model_override),
    defaultExecutionProfile: parseConversationExecutionProfile(row.default_execution_profile),
    toolPolicy: parseAgentToolPolicy(parseObject(row.tool_policy_json)),
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function mapConversation(row: Row): Conversation {
  const locatorValues = [row.pi_session_file, row.pi_session_id, row.pi_version, row.pi_session_version];
  const populated = locatorValues.filter((value) => value !== null && value !== undefined).length;
  if (populated !== 0 && populated !== locatorValues.length) throw new Error("Conversation has a malformed Pi Session locator.");
  return {
    id: asString(row.id), workspaceId: asString(row.workspace_id), agentId: asString(row.agent_id),
    title: asString(row.title), status: asString(row.status) as Conversation["status"],
    modelOverride: asNullableString(row.model_override),
    executionProfile: parseConversationExecutionProfile(row.execution_profile),
    piSession: populated === 0 ? null : {
      sessionFile: asString(row.pi_session_file), sessionId: asString(row.pi_session_id),
      piVersion: asString(row.pi_version) as PiSessionLocator["piVersion"],
      sessionVersion: asNumber(row.pi_session_version) as PiSessionLocator["sessionVersion"],
    },
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function mapRun(row: Row): AgentRun {
  return {
    id: asString(row.id), conversationId: asString(row.conversation_id),
    triggerMessageId: asString(row.id), contextRevisionId: null,
    configSnapshot: parseObject(row.config_snapshot_json) as RunConfigSnapshot,
    status: asString(row.status) as RunStatus, startedAt: asNullableString(row.started_at),
    completedAt: asNullableString(row.completed_at), error: asNullableString(row.error),
    effect: asString(row.effect) as AgentRun["effect"], createdAt: asString(row.created_at),
  };
}

function mapApproval(row: Row): ToolApproval {
  return {
    id: asString(row.id), toolCallId: asString(row.tool_call_id), runId: asString(row.run_id),
    status: asString(row.status) as ToolApproval["status"], reason: asString(row.reason),
    processId: asString(row.process_id), requestId: asString(row.request_id),
    piToolCallId: asString(row.pi_tool_call_id), toolName: asString(row.tool_name),
    canonicalInput: parseObject(row.canonical_input_json),
    canonicalInputSha256: asString(row.canonical_input_sha256),
    createdAt: asString(row.created_at), resolvedAt: asNullableString(row.resolved_at),
  };
}

function approvalToolCall(approval: ToolApproval): ToolCallRecord {
  return {
    id: approval.toolCallId, runId: approval.runId, sequence: 0,
    providerCallId: approval.piToolCallId, name: approval.toolName,
    description: `${approval.toolName} requires approval`, arguments: approval.canonicalInput,
    status: "awaiting-approval", output: null, error: null,
    createdAt: approval.createdAt, completedAt: null,
  };
}

function mapContext(row: Row): WorkspaceContextRevision {
  return {
    id: asString(row.id), workspaceId: asString(row.workspace_id), version: asNumber(row.version),
    parentId: asNullableString(row.parent_id), title: asString(row.title), content: asString(row.content),
    sourceConversationId: asNullableString(row.source_conversation_id), sourceRunId: asNullableString(row.source_run_id),
    publishedBy: asString(row.published_by) as WorkspaceContextRevision["publishedBy"], createdAt: asString(row.created_at),
  };
}

function mapNullable<T>(row: Row | undefined, mapper: (row: Row) => T): T | null { return row ? mapper(row) : null; }
function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Expected JSON text in ScopeGuard database.");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON object in ScopeGuard database.");
  return parsed as Record<string, unknown>;
}
function asString(value: unknown): string { if (typeof value !== "string") throw new Error("Expected database string."); return value; }
function asNullableString(value: unknown): string | null { return value === null || value === undefined ? null : asString(value); }
function asNumber(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected database number."); return value; }
function nowIso(): string { return new Date().toISOString(); }
function placeholders(count: number): string { return Array.from({ length: count }, () => "?").join(","); }
function normalizeSchemaSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim();
}
function incompatibleSchema(): Error {
  return new Error(
    `Incompatible ScopeGuard database. Expected ${SCOPEGUARD_SCHEMA_ID} schema ${SCOPEGUARD_SCHEMA_VERSION}; old databases are not migrated. Start with a fresh personal Pi profile.`,
  );
}
