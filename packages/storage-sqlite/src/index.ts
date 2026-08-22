import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  SCOPEGUARD_SCHEMA_ID,
  SCOPEGUARD_SCHEMA_VERSION,
  assertDispatchTransition,
  assertRunTransition,
  mergeToolPolicy,
  parseArtifact,
  parseArtifactFormat,
  parseArtifactVersion,
  parseAgentToolPolicy,
  parseConversationExecutionProfile,
  parseDispatch,
  parseDispatchPrompt,
  parseWorkspaceCenterState,
  parseWorkspaceRelativePath,
  parseWorkspaceLayout,
  type Artifact,
  type ArtifactVersion,
  type Agent,
  type AgentRun,
  type ApprovalDecision,
  type Conversation,
  type ConversationExecutionProfile,
  type CreateAgentInput,
  type CreateArtifactInput,
  type CreateArtifactVersionInput,
  type CreateConversationInput,
  type CreateDispatchInput,
  type CreateWorkspaceInput,
  type Id,
  type Dispatch,
  type DispatchStatus,
  type PiSessionLocator,
  type ProviderProfile,
  type ProviderProfileInput,
  type RunConfigSnapshot,
  type RunStatus,
  type ToolApproval,
  type ToolCallRecord,
  type UpdateConversationSettingsInput,
  type Workspace,
  type WorkspaceCenterState,
  type WorkspaceLayout,
  type WorkspaceContextRevision,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

type Row = Record<string, unknown>;
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled", "interrupted"];
const EXPECTED_SCHEMA_COLUMNS = {
  agents: ["id", "workspace_id", "name", "instructions", "provider_profile_id", "model_override", "default_execution_profile", "tool_policy_json", "created_at", "updated_at"],
  artifact_versions: ["id", "artifact_id", "version", "parent_version_id", "inputs_json", "source_json", "content_hash", "byte_size", "storage_key", "produced_by_conversation_id", "produced_by_run_id", "toolchain", "limitations_json", "validation_status", "validation_summary", "created_at"],
  artifacts: ["id", "workspace_id", "title", "format", "source_relative_path", "current_version_id", "associated_conversation_id", "created_at", "updated_at"],
  center_state: ["workspace_id", "state_json"],
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
const PHASE3_SCHEMA_VERSION = 1;
const PHASE3_SCHEMA_COLUMNS = {
  agents: EXPECTED_SCHEMA_COLUMNS.agents,
  artifacts: ["id", "workspace_id", "metadata_json"],
  conversations: EXPECTED_SCHEMA_COLUMNS.conversations,
  dispatches: EXPECTED_SCHEMA_COLUMNS.dispatches,
  layout_state: EXPECTED_SCHEMA_COLUMNS.layout_state,
  provider_profiles: EXPECTED_SCHEMA_COLUMNS.provider_profiles,
  runs: EXPECTED_SCHEMA_COLUMNS.runs,
  schema_metadata: EXPECTED_SCHEMA_COLUMNS.schema_metadata,
  tool_approvals: EXPECTED_SCHEMA_COLUMNS.tool_approvals,
  workspace_context_revisions: EXPECTED_SCHEMA_COLUMNS.workspace_context_revisions,
  workspaces: EXPECTED_SCHEMA_COLUMNS.workspaces,
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
    const recentRuns = this.listRecentRuns();
    const seenRunIds = new Set(recentRuns.map(({ id }) => id));
    for (const version of this.listArtifactVersions()) {
      if (!version.producedByRunId || seenRunIds.has(version.producedByRunId)) continue;
      const run = this.getRun(version.producedByRunId);
      if (run) {
        recentRuns.push(run);
        seenRunIds.add(run.id);
      }
    }
    return {
      workspaces: this.listWorkspaces(),
      providerProfiles: this.listProviderProfiles(),
      agents: this.listAgents(),
      conversations: this.listConversations(),
      activeRuns: this.listActiveRuns(),
      recentRuns,
      pendingApprovals: this.listPendingApprovals().map((approval) => ({
        approval,
        toolCall: approvalToolCall(approval),
      })),
      layouts: this.listWorkspaceLayouts(),
      dispatches: this.listDispatches(),
      artifacts: this.listArtifacts(),
      artifactVersions: this.listArtifactVersions(),
      centerStates: this.listWorkspaceCenterStates(),
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

  listArtifacts(workspaceId?: Id): Artifact[] {
    const rows = workspaceId
      ? this.#all("SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY updated_at DESC", workspaceId)
      : this.#all("SELECT * FROM artifacts ORDER BY updated_at DESC");
    return rows.map(mapArtifact);
  }

  getArtifact(id: Id): Artifact | null {
    return mapNullable(this.#get("SELECT * FROM artifacts WHERE id = ?", id), mapArtifact);
  }

  createArtifact(input: CreateArtifactInput): Artifact {
    const workspace = this.getWorkspace(input.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
    const title = input.title.trim();
    const now = nowIso();
    const artifact = parseArtifact({
      id: randomUUID(),
      workspaceId: workspace.id,
      title,
      format: parseArtifactFormat(input.format),
      sourceRelativePath: input.sourceRelativePath == null
        ? null
        : parseWorkspaceRelativePath(input.sourceRelativePath),
      currentVersionId: null,
      associatedConversationId: input.associatedConversationId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    if (artifact.associatedConversationId) {
      const conversation = this.requireConversation(artifact.associatedConversationId);
      if (conversation.workspaceId !== workspace.id) {
        throw new Error("Artifact-associated Conversation must belong to its Workspace.");
      }
    }
    this.#run(
      "INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      artifact.id,
      artifact.workspaceId,
      artifact.title,
      artifact.format,
      artifact.sourceRelativePath,
      artifact.associatedConversationId,
      artifact.createdAt,
      artifact.updatedAt,
    );
    return artifact;
  }

  listArtifactVersions(artifactId?: Id): ArtifactVersion[] {
    const rows = artifactId
      ? this.#all("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version", artifactId)
      : this.#all("SELECT * FROM artifact_versions ORDER BY artifact_id, version");
    return rows.map(mapArtifactVersion);
  }

  getArtifactVersion(id: Id): ArtifactVersion | null {
    return mapNullable(
      this.#get("SELECT * FROM artifact_versions WHERE id = ?", id),
      mapArtifactVersion,
    );
  }

  getArtifactVersionStorageKey(id: Id): string | null {
    const row = this.#get("SELECT storage_key FROM artifact_versions WHERE id = ?", id);
    return row ? asString(row.storage_key) : null;
  }

  createArtifactWithVersion(
    artifactInput: CreateArtifactInput,
    versionInput: Omit<CreateArtifactVersionInput, "artifactId" | "parentVersionId">,
    storageKey: string,
  ): { artifact: Artifact; version: ArtifactVersion } {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const artifact = this.createArtifact(artifactInput);
      const version = this.#createArtifactVersion({
        ...versionInput,
        artifactId: artifact.id,
        parentVersionId: null,
      }, storageKey, true);
      this.#database.exec("COMMIT");
      return { artifact: this.getArtifact(artifact.id)!, version };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  createArtifactVersion(
    input: CreateArtifactVersionInput,
    storageKey: string,
  ): ArtifactVersion {
    return this.#createArtifactVersion(input, storageKey, false);
  }

  #createArtifactVersion(
    input: CreateArtifactVersionInput,
    storageKey: string,
    transactionOpen: boolean,
  ): ArtifactVersion {
    const artifact = this.getArtifact(input.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${input.artifactId}`);
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(storageKey)) {
      throw new Error("Artifact storage key must be content-addressed.");
    }
    if (input.parentVersionId) {
      const parent = this.getArtifactVersion(input.parentVersionId);
      if (!parent || parent.artifactId !== artifact.id) {
        throw new Error("Artifact Version parent must belong to the same Artifact.");
      }
    }
    if ((input.parentVersionId ?? null) !== artifact.currentVersionId) {
      throw new Error("Artifact Version parent must be the selected current Version.");
    }
    for (const inputFile of input.inputs ?? []) {
      if (inputFile.workspaceId !== artifact.workspaceId) {
        throw new Error("Artifact Version inputs must belong to the Artifact Workspace.");
      }
    }
    if (input.source?.workspaceId !== undefined && input.source.workspaceId !== artifact.workspaceId) {
      throw new Error("Artifact Version source must belong to the Artifact Workspace.");
    }
    if (!input.producedByConversationId || !input.producedByRunId) {
      throw new Error("Artifact Version requires its producing Conversation and Run.");
    }
    const producer = this.requireConversation(input.producedByConversationId);
    if (producer.workspaceId !== artifact.workspaceId) {
      throw new Error("Artifact Version producer must belong to the Artifact Workspace.");
    }
    const run = this.requireRun(input.producedByRunId);
    if (run.status !== "completed" || run.effect !== "confirmed") {
      throw new Error("Artifact Version Run must be completed with confirmed Tool effects.");
    }
    const conversation = this.requireConversation(run.conversationId);
    if (
      conversation.workspaceId !== artifact.workspaceId ||
      input.producedByConversationId !== conversation.id
    ) {
      throw new Error("Artifact Version Run provenance must match its Workspace and Conversation.");
    }
    const next = this.#get(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM artifact_versions WHERE artifact_id = ?",
      artifact.id,
    );
    const now = nowIso();
    const version = parseArtifactVersion({
      id: randomUUID(),
      artifactId: artifact.id,
      version: asNumber(next?.next_version),
      parentVersionId: input.parentVersionId ?? null,
      inputs: input.inputs ?? [],
      source: input.source ?? null,
      contentHash: input.contentHash,
      byteSize: input.byteSize,
      producedByConversationId: input.producedByConversationId,
      producedByRunId: input.producedByRunId,
      toolchain: input.toolchain,
      limitations: input.limitations ?? [],
      validationStatus: input.validationStatus,
      validationSummary: input.validationSummary,
      createdAt: now,
    });
    if (storageKey !== `${version.contentHash.slice(0, 2)}/${version.contentHash}`) {
      throw new Error("Artifact storage key must match the Version content identity.");
    }
    if (!transactionOpen) this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#get(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM artifact_versions WHERE artifact_id = ?",
        artifact.id,
      );
      if (asNumber(current?.next_version) !== version.version) {
        throw new Error("Artifact Version changed while publication was being prepared.");
      }
      const selected = this.#get(
        "SELECT current_version_id FROM artifacts WHERE id = ?",
        artifact.id,
      );
      if (asNullableString(selected?.current_version_id) !== version.parentVersionId) {
        throw new Error("Artifact current Version changed while publication was being prepared.");
      }
      this.#run(
        "INSERT INTO artifact_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        version.id,
        version.artifactId,
        version.version,
        version.parentVersionId,
        JSON.stringify(version.inputs),
        version.source ? JSON.stringify(version.source) : null,
        version.contentHash,
        version.byteSize,
        storageKey,
        version.producedByConversationId,
        version.producedByRunId,
        version.toolchain,
        JSON.stringify(version.limitations),
        version.validationStatus,
        version.validationSummary,
        version.createdAt,
      );
      this.#run(
        "UPDATE artifacts SET current_version_id = ?, updated_at = ? WHERE id = ?",
        version.id,
        version.createdAt,
        artifact.id,
      );
      if (!transactionOpen) this.#database.exec("COMMIT");
    } catch (error) {
      if (!transactionOpen) this.#database.exec("ROLLBACK");
      throw error;
    }
    return version;
  }

  setArtifactCurrentVersion(artifactId: Id, versionId: Id): Artifact {
    const artifact = this.getArtifact(artifactId);
    const version = this.getArtifactVersion(versionId);
    if (!artifact || !version || version.artifactId !== artifact.id) {
      throw new Error("Current Artifact Version must belong to the Artifact.");
    }
    this.#run(
      "UPDATE artifacts SET current_version_id = ?, updated_at = ? WHERE id = ?",
      version.id,
      nowIso(),
      artifact.id,
    );
    return this.getArtifact(artifact.id)!;
  }

  getWorkspaceCenterState(workspaceId: Id): WorkspaceCenterState {
    const row = this.#get("SELECT state_json FROM center_state WHERE workspace_id = ?", workspaceId);
    return row
      ? this.#mapWorkspaceCenterState(workspaceId, row.state_json)
      : { workspaceId, mode: "workbench" };
  }

  listWorkspaceCenterStates(): WorkspaceCenterState[] {
    return this.#all("SELECT * FROM center_state ORDER BY workspace_id")
      .map((row) => this.#mapWorkspaceCenterState(asString(row.workspace_id), row.state_json));
  }

  saveWorkspaceCenterState(value: WorkspaceCenterState): WorkspaceCenterState {
    const state = this.#validateWorkspaceCenterState(value);
    this.#run(
      `INSERT INTO center_state VALUES (?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET state_json=excluded.state_json`,
      state.workspaceId,
      JSON.stringify(state),
    );
    return state;
  }

  getWorkspaceLayout(workspaceId: Id): WorkspaceLayout | null {
    const row = this.#get("SELECT * FROM layout_state WHERE workspace_id = ?", workspaceId);
    if (!row) return null;
    return this.#mapWorkspaceLayout(row);
  }

  listWorkspaceLayouts(): WorkspaceLayout[] {
    return this.#all("SELECT * FROM layout_state ORDER BY workspace_id")
      .map((row) => this.#mapWorkspaceLayout(row));
  }

  saveWorkspaceLayout(value: WorkspaceLayout): WorkspaceLayout {
    if (!this.getWorkspace(value.workspaceId)) {
      throw new Error(`Workspace not found: ${value.workspaceId}`);
    }
    const conversationIds = new Set(
      this.listConversations(value.workspaceId).map(({ id }) => id),
    );
    const layout = parseWorkspaceLayout(value, conversationIds);
    this.#run(
      `INSERT INTO layout_state VALUES (?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET state_json=excluded.state_json`,
      layout.workspaceId,
      JSON.stringify(layout),
    );
    return layout;
  }

  createDispatch(input: CreateDispatchInput): Dispatch {
    const source = this.requireConversation(input.sourceConversationId);
    const target = this.requireConversation(input.targetConversationId);
    if (
      source.workspaceId !== input.workspaceId ||
      target.workspaceId !== input.workspaceId
    ) {
      throw new Error("Dispatch Conversations must belong to the same Workspace.");
    }
    if (source.id === target.id) {
      throw new Error("Dispatch source and target must be a different Conversation.");
    }
    if (input.sourceRunId) {
      this.#assertRunBelongsToConversation(input.sourceRunId, source.id, "source");
    }
    const now = nowIso();
    const dispatch: Dispatch = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      prompt: parseDispatchPrompt(input.prompt),
      status: "pending",
      sourceRunId: input.sourceRunId ?? null,
      targetRunId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      "INSERT INTO dispatches VALUES (?, ?, ?)",
      dispatch.id,
      dispatch.workspaceId,
      JSON.stringify(dispatch),
    );
    return dispatch;
  }

  getDispatch(id: Id): Dispatch | null {
    const row = this.#get("SELECT * FROM dispatches WHERE id = ?", id);
    return row ? this.#mapDispatch(row) : null;
  }

  listDispatches(filter: { workspaceId?: Id; conversationId?: Id } = {}): Dispatch[] {
    return this.#all("SELECT * FROM dispatches ORDER BY id")
      .map((row) => this.#mapDispatch(row))
      .filter((dispatch) =>
        (!filter.workspaceId || dispatch.workspaceId === filter.workspaceId) &&
        (!filter.conversationId ||
          dispatch.sourceConversationId === filter.conversationId ||
          dispatch.targetConversationId === filter.conversationId)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  updateDispatchStatus(
    id: Id,
    status: DispatchStatus,
    patch: { targetRunId?: Id | null; error?: string | null } = {},
  ): Dispatch {
    const current = this.getDispatch(id);
    if (!current) throw new Error(`Dispatch not found: ${id}`);
    assertDispatchTransition(current.status, status);
    const targetRunId = patch.targetRunId === undefined
      ? current.targetRunId
      : patch.targetRunId;
    if (targetRunId) {
      this.#assertRunBelongsToConversation(
        targetRunId,
        current.targetConversationId,
        "target",
      );
    }
    const updated = parseDispatch({
      ...current,
      status,
      targetRunId,
      error: patch.error === undefined ? current.error : patch.error,
      updatedAt: nowIso(),
    });
    this.#run(
      "UPDATE dispatches SET metadata_json = ? WHERE id = ?",
      JSON.stringify(updated),
      id,
    );
    return updated;
  }

  interruptNonTerminalDispatches(): number {
    const active = this.listDispatches().filter(
      ({ status }) => status === "pending" || status === "running",
    );
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const dispatch of active) {
        this.updateDispatchStatus(dispatch.id, "interrupted", {
          error: "ScopeGuard restarted before this Dispatch completed.",
        });
      }
      this.#database.exec("COMMIT");
      return active.length;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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

  #assertRunBelongsToConversation(runId: Id, conversationId: Id, role: string): void {
    const run = this.requireRun(runId);
    if (run.conversationId !== conversationId) {
      throw new Error(`Dispatch ${role} Run must belong to its Conversation.`);
    }
  }

  #initializeSchema(): void {
    const tables = this.listSchemaTables();
    if (tables.length > 0) {
      if (!tables.includes("schema_metadata")) throw incompatibleSchema();
      const columns = this.#all("PRAGMA table_info(schema_metadata)").map((row) => asString(row.name));
      if (!columns.includes("schema_id") || !columns.includes("schema_version")) throw incompatibleSchema();
      const metadata = this.#get("SELECT schema_id, schema_version FROM schema_metadata");
      if (!metadata || asString(metadata.schema_id) !== SCOPEGUARD_SCHEMA_ID) {
        throw incompatibleSchema();
      }
      const version = asNumber(metadata.schema_version);
      if (version === PHASE3_SCHEMA_VERSION) {
        this.#migratePhase3Schema();
        this.#validateSchema();
        return;
      }
      if (version !== SCOPEGUARD_SCHEMA_VERSION) throw incompatibleSchema();
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
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        format TEXT NOT NULL,
        source_relative_path TEXT,
        current_version_id TEXT,
        associated_conversation_id TEXT REFERENCES conversations(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent_version_id TEXT REFERENCES artifact_versions(id),
        inputs_json TEXT NOT NULL,
        source_json TEXT,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        produced_by_conversation_id TEXT REFERENCES conversations(id),
        produced_by_run_id TEXT REFERENCES runs(id),
        toolchain TEXT NOT NULL,
        limitations_json TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        validation_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, version)
      ) STRICT;
      CREATE TABLE center_state (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE dispatches (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), metadata_json TEXT NOT NULL) STRICT;
      CREATE TABLE layout_state (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), state_json TEXT NOT NULL) STRICT;
      COMMIT;
    `);
    this.#validateSchema();
  }

  #migratePhase3Schema(): void {
    const expectedTables = Object.keys(PHASE3_SCHEMA_COLUMNS).sort();
    if (JSON.stringify(this.listSchemaTables()) !== JSON.stringify(expectedTables)) {
      throw incompatibleSchema();
    }
    for (const [table, expectedColumns] of Object.entries(PHASE3_SCHEMA_COLUMNS)) {
      const actualColumns = this.#all(`PRAGMA table_info(${table})`)
        .map((row) => asString(row.name));
      if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
        throw incompatibleSchema();
      }
    }
    const activeRunIndex = this.#all("PRAGMA index_list(runs)")
      .find((row) => row.name === ACTIVE_RUN_INDEX_NAME);
    const activeRunIndexDefinition = this.#get(
      "SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND name=?",
      ACTIVE_RUN_INDEX_NAME,
    );
    if (
      !activeRunIndex ||
      asNumber(activeRunIndex.unique) !== 1 ||
      asNumber(activeRunIndex.partial) !== 1 ||
      asString(activeRunIndex.origin) !== "c" ||
      JSON.stringify(this.#all(`PRAGMA index_info(${ACTIVE_RUN_INDEX_NAME})`)
        .map((row) => asString(row.name))) !== JSON.stringify(["conversation_id"]) ||
      !activeRunIndexDefinition ||
      asString(activeRunIndexDefinition.tbl_name) !== "runs" ||
      typeof activeRunIndexDefinition.sql !== "string" ||
      normalizeSchemaSql(activeRunIndexDefinition.sql) !== normalizeSchemaSql(ACTIVE_RUN_INDEX_SQL)
    ) {
      throw incompatibleSchema();
    }
    const placeholderCount = asNumber(
      this.#get("SELECT COUNT(*) AS count FROM artifacts")?.count,
    );
    if (placeholderCount !== 0) {
      throw new Error(
        "Phase 3 placeholder Artifact rows cannot be migrated without an explicit data contract.",
      );
    }
    this.#database.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE artifacts;
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        format TEXT NOT NULL,
        source_relative_path TEXT,
        current_version_id TEXT,
        associated_conversation_id TEXT REFERENCES conversations(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent_version_id TEXT REFERENCES artifact_versions(id),
        inputs_json TEXT NOT NULL,
        source_json TEXT,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        produced_by_conversation_id TEXT REFERENCES conversations(id),
        produced_by_run_id TEXT REFERENCES runs(id),
        toolchain TEXT NOT NULL,
        limitations_json TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        validation_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, version)
      ) STRICT;
      CREATE TABLE center_state (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL
      ) STRICT;
      UPDATE schema_metadata SET schema_version = ${SCOPEGUARD_SCHEMA_VERSION};
      COMMIT;
    `);
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
      this.#all("SELECT * FROM layout_state").forEach((row) => this.#mapWorkspaceLayout(row));
      this.#all("SELECT * FROM dispatches").forEach((row) => this.#mapDispatch(row));
      const artifacts = this.#all("SELECT * FROM artifacts").map(mapArtifact);
      const artifactVersions = this.#all("SELECT * FROM artifact_versions");
      artifactVersions.forEach((row) => {
        const version = mapArtifactVersion(row);
        const artifact = artifacts.find(({ id }) => id === version.artifactId);
        if (
          !artifact ||
          asString(row.storage_key) !==
            `${version.contentHash.slice(0, 2)}/${version.contentHash}`
        ) {
          throw new Error("Artifact Version has invalid ownership or storage identity.");
        }
        if (version.inputs.some(({ workspaceId }) => workspaceId !== artifact.workspaceId)) {
          throw new Error("Artifact Version input belongs to a different Workspace.");
        }
        if (version.source && version.source.workspaceId !== artifact.workspaceId) {
          throw new Error("Artifact Version source belongs to a different Workspace.");
        }
        if (version.parentVersionId) {
          const parent = this.getArtifactVersion(version.parentVersionId);
          if (!parent || parent.artifactId !== artifact.id) {
            throw new Error("Artifact Version parent belongs to a different Artifact.");
          }
        }
        const producer = version.producedByConversationId
          ? this.requireConversation(version.producedByConversationId)
          : null;
        if (producer && producer.workspaceId !== artifact.workspaceId) {
          throw new Error("Artifact Version producer belongs to a different Workspace.");
        }
        if (version.producedByRunId) {
          const run = this.requireRun(version.producedByRunId);
          const owner = this.requireConversation(run.conversationId);
          if (
            run.status !== "completed" ||
            run.effect !== "confirmed" ||
            owner.workspaceId !== artifact.workspaceId ||
            (producer && producer.id !== owner.id)
          ) {
            throw new Error("Artifact Version Run provenance is invalid.");
          }
        }
      });
      for (const artifact of artifacts) {
        if (artifact.associatedConversationId) {
          const conversation = this.requireConversation(artifact.associatedConversationId);
          if (conversation.workspaceId !== artifact.workspaceId) {
            throw new Error("Artifact-associated Conversation belongs to a different Workspace.");
          }
        }
        if (artifact.currentVersionId) {
          const current = this.getArtifactVersion(artifact.currentVersionId);
          if (!current || current.artifactId !== artifact.id) {
            throw new Error("Artifact current Version belongs to a different Artifact.");
          }
        }
      }
      this.#all("SELECT * FROM center_state").forEach((row) => {
        this.#mapWorkspaceCenterState(asString(row.workspace_id), row.state_json);
      });
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

  #mapWorkspaceLayout(row: Row): WorkspaceLayout {
    const workspaceId = asString(row.workspace_id);
    const conversationIds = new Set(
      this.listConversations(workspaceId).map(({ id }) => id),
    );
    const layout = parseWorkspaceLayout(parseObject(row.state_json), conversationIds);
    if (layout.workspaceId !== workspaceId) {
      throw new Error("Workspace Layout metadata does not match its database owner.");
    }
    return layout;
  }

  #mapDispatch(row: Row): Dispatch {
    const rowId = asString(row.id);
    const workspaceId = asString(row.workspace_id);
    const dispatch = parseDispatch(parseObject(row.metadata_json));
    if (dispatch.id !== rowId || dispatch.workspaceId !== workspaceId) {
      throw new Error("Dispatch metadata does not match its database owner.");
    }
    const source = this.requireConversation(dispatch.sourceConversationId);
    const target = this.requireConversation(dispatch.targetConversationId);
    if (
      source.id === target.id ||
      source.workspaceId !== workspaceId ||
      target.workspaceId !== workspaceId
    ) {
      throw new Error("Dispatch has invalid Conversation ownership.");
    }
    if (dispatch.sourceRunId) {
      this.#assertRunBelongsToConversation(
        dispatch.sourceRunId,
        dispatch.sourceConversationId,
        "source",
      );
    }
    if (dispatch.targetRunId) {
      this.#assertRunBelongsToConversation(
        dispatch.targetRunId,
        dispatch.targetConversationId,
        "target",
      );
    }
    return dispatch;
  }

  #mapWorkspaceCenterState(workspaceId: Id, value: unknown): WorkspaceCenterState {
    const state = parseWorkspaceCenterState(parseObject(value));
    if (state.workspaceId !== workspaceId) {
      throw new Error("Workspace center state does not match its database owner.");
    }
    return this.#validateWorkspaceCenterState(state);
  }

  #validateWorkspaceCenterState(value: WorkspaceCenterState): WorkspaceCenterState {
    const state = parseWorkspaceCenterState(value);
    if (!this.getWorkspace(state.workspaceId)) {
      throw new Error(`Workspace not found: ${state.workspaceId}`);
    }
    if (state.mode === "workbench") return state;
    const artifact = this.getArtifact(state.artifactId);
    const version = this.getArtifactVersion(state.versionId);
    if (
      !artifact ||
      artifact.workspaceId !== state.workspaceId ||
      !version ||
      version.artifactId !== artifact.id
    ) {
      throw new Error("Artifact Review selection must belong to its Workspace and Artifact.");
    }
    if (state.comparisonVersionId) {
      const comparison = this.getArtifactVersion(state.comparisonVersionId);
      if (!comparison || comparison.artifactId !== artifact.id) {
        throw new Error("Artifact Review comparison Version must belong to its Artifact.");
      }
      if (comparison.id === version.id) {
        throw new Error("Artifact Review comparison Version must differ from the selected Version.");
      }
    }
    if (state.associatedConversationId) {
      const conversation = this.requireConversation(state.associatedConversationId);
      if (
        conversation.workspaceId !== state.workspaceId ||
        conversation.id !== artifact.associatedConversationId
      ) {
        throw new Error("Artifact Review Conversation must match the Artifact association.");
      }
    }
    if (state.conversationPanelOpen && !state.associatedConversationId) {
      throw new Error("Artifact Review cannot open a Conversation panel without an association.");
    }
    return state;
  }

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

function mapArtifact(row: Row): Artifact {
  return parseArtifact({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    format: row.format,
    sourceRelativePath: row.source_relative_path ?? null,
    currentVersionId: row.current_version_id ?? null,
    associatedConversationId: row.associated_conversation_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapArtifactVersion(row: Row): ArtifactVersion {
  const inputs = parseJsonValue(row.inputs_json);
  const limitations = parseJsonValue(row.limitations_json);
  return parseArtifactVersion({
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    parentVersionId: row.parent_version_id ?? null,
    inputs,
    source: row.source_json == null ? null : parseObject(row.source_json),
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    producedByConversationId: row.produced_by_conversation_id,
    producedByRunId: row.produced_by_run_id,
    toolchain: row.toolchain,
    limitations,
    validationStatus: row.validation_status,
    validationSummary: row.validation_summary,
    createdAt: row.created_at,
  });
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
function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected JSON text in ScopeGuard database.");
  return JSON.parse(value) as unknown;
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
    `Incompatible ScopeGuard database. Expected ${SCOPEGUARD_SCHEMA_ID} schema ${SCOPEGUARD_SCHEMA_VERSION}; only the exact Phase 3 schema can migrate automatically.`,
  );
}
