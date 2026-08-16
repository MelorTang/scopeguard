import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  SCOPEGUARD_SCHEMA_ID,
  SCOPEGUARD_SCHEMA_VERSION,
  assertRunTransition,
  canTransitionToolCall,
  mergeToolPolicy,
  type Agent,
  type AgentRun,
  type ApprovalDecision,
  type Conversation,
  type ConversationMessage,
  type CreateAgentInput,
  type CreateConversationInput,
  type CreateWorkspaceInput,
  type Id,
  type ProviderProfile,
  type ProviderProfileInput,
  type RunConfigSnapshot,
  type RunEvent,
  type RunRequestManifest,
  type RunStatus,
  type RunUsageRecord,
  type ToolApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type UpdateConversationSettingsInput,
  type Workspace,
  type WorkspaceContextRevision,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

type Row = Record<string, unknown>;
const MAX_RUN_PARTIAL_CHARACTERS = 1_000_000;
const TERMINAL_RUN_STATUSES: RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export class ScopeGuardStore {
  readonly #database: DatabaseSync;
  readonly #databasePath: string | null;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.#databasePath = databasePath === ":memory:" ? null : databasePath;
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      if (this.#databasePath) this.#database.exec("PRAGMA journal_mode = WAL");
      this.#initializeSchema();
      this.#secureFiles();
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // Keep the initialization error as the actionable failure.
      }
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
      pendingApprovals: this.listPendingApprovals().flatMap((approval) => {
        const toolCall = this.getToolCall(approval.toolCallId);
        return toolCall ? [{ approval, toolCall }] : [];
      }),
    };
  }

  listWorkspaces(): Workspace[] {
    return this.#all(
      "SELECT * FROM workspaces ORDER BY last_opened_at DESC, created_at DESC",
    ).map(mapWorkspace);
  }

  getWorkspace(workspaceId: Id): Workspace | null {
    return mapNullable(
      this.#get("SELECT * FROM workspaces WHERE id = ?", workspaceId),
      mapWorkspace,
    );
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const name = input.name.trim();
    const localRootPath = input.localRootPath?.trim() || null;
    const now = nowIso();
    if (localRootPath) {
      const existing = this.#get(
        "SELECT * FROM workspaces WHERE local_root_path = ?",
        localRootPath,
      );
      if (existing) {
        const id = asString(existing.id);
        this.#run(
          "UPDATE workspaces SET name = ?, updated_at = ?, last_opened_at = ? WHERE id = ?",
          name,
          now,
          now,
          id,
        );
        return this.getWorkspace(id)!;
      }
    }
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      localRootPath,
      currentContextRevisionId: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };
    this.#run(
      `INSERT INTO workspaces (
        id, name, local_root_path, current_context_revision_id,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      workspace.id,
      workspace.name,
      workspace.localRootPath,
      workspace.currentContextRevisionId,
      workspace.createdAt,
      workspace.updatedAt,
      workspace.lastOpenedAt,
    );
    return workspace;
  }

  listProviderProfiles(): ProviderProfile[] {
    return this.#all(
      "SELECT * FROM provider_profiles ORDER BY updated_at DESC",
    ).map(mapProviderProfile);
  }

  getProviderProfile(providerProfileId: Id): ProviderProfile | null {
    return mapNullable(
      this.#get("SELECT * FROM provider_profiles WHERE id = ?", providerProfileId),
      mapProviderProfile,
    );
  }

  saveProviderProfile(
    input: ProviderProfileInput & { id?: Id },
    apiKeyRef: string | null,
  ): ProviderProfile {
    const id = input.id ?? randomUUID();
    const existing = this.getProviderProfile(id);
    const now = nowIso();
    const profile: ProviderProfile = {
      id,
      name: input.name.trim(),
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      defaultModel: input.defaultModel.trim(),
      apiKeyRef,
      customHeaders: structuredClone(input.customHeaders ?? {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO provider_profiles (
        id, name, protocol, base_url, default_model, api_key_ref,
        custom_headers_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, protocol = excluded.protocol,
        base_url = excluded.base_url, default_model = excluded.default_model,
        api_key_ref = excluded.api_key_ref,
        custom_headers_json = excluded.custom_headers_json,
        updated_at = excluded.updated_at`,
      profile.id,
      profile.name,
      profile.protocol,
      profile.baseUrl,
      profile.defaultModel,
      profile.apiKeyRef,
      toJson(profile.customHeaders),
      profile.createdAt,
      profile.updatedAt,
    );
    return profile;
  }

  deleteProviderProfile(providerProfileId: Id): void {
    this.#run("DELETE FROM provider_profiles WHERE id = ?", providerProfileId);
  }

  listAgents(workspaceId?: Id): Agent[] {
    const rows = workspaceId
      ? this.#all(
          "SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at",
          workspaceId,
        )
      : this.#all("SELECT * FROM agents ORDER BY created_at");
    return rows.map(mapAgent);
  }

  getAgent(agentId: Id): Agent | null {
    return mapNullable(
      this.#get("SELECT * FROM agents WHERE id = ?", agentId),
      mapAgent,
    );
  }

  createAgent(input: CreateAgentInput): Agent {
    const now = nowIso();
    const agent: Agent = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      instructions: input.instructions.trim(),
      providerProfileId: input.providerProfileId,
      modelOverride: input.modelOverride?.trim() || null,
      defaultExecutionProfile: input.executionProfile ?? "request-approval",
      toolPolicy: mergeToolPolicy(input.toolPolicy),
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO agents (
        id, workspace_id, name, instructions, provider_profile_id,
        model_override, default_execution_profile, tool_policy_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agent.id,
      agent.workspaceId,
      agent.name,
      agent.instructions,
      agent.providerProfileId,
      agent.modelOverride,
      agent.defaultExecutionProfile,
      toJson(agent.toolPolicy),
      agent.createdAt,
      agent.updatedAt,
    );
    return agent;
  }

  listConversations(workspaceId?: Id): Conversation[] {
    const rows = workspaceId
      ? this.#all(
          "SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC",
          workspaceId,
        )
      : this.#all("SELECT * FROM conversations ORDER BY updated_at DESC");
    return rows.map(mapConversation);
  }

  getConversation(conversationId: Id): Conversation | null {
    return mapNullable(
      this.#get("SELECT * FROM conversations WHERE id = ?", conversationId),
      mapConversation,
    );
  }

  createConversation(input: CreateConversationInput): Conversation {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.workspaceId !== input.workspaceId) {
      throw new Error("Agent and Conversation must belong to the same Workspace.");
    }
    const now = nowIso();
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      title: input.title?.trim() || "New conversation",
      status: "active",
      modelOverride: null,
      executionProfile: agent.defaultExecutionProfile,
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO conversations (
        id, workspace_id, agent_id, title, status, model_override,
        execution_profile, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversation.id,
      conversation.workspaceId,
      conversation.agentId,
      conversation.title,
      conversation.status,
      conversation.modelOverride,
      conversation.executionProfile,
      conversation.createdAt,
      conversation.updatedAt,
    );
    return conversation;
  }

  updateConversationSettings(input: UpdateConversationSettingsInput): Conversation {
    const current = this.getConversation(input.conversationId);
    if (!current) throw new Error(`Conversation not found: ${input.conversationId}`);
    const updated: Conversation = {
      ...current,
      modelOverride: input.modelOverride === undefined
        ? current.modelOverride
        : input.modelOverride,
      executionProfile: input.executionProfile ?? current.executionProfile,
      updatedAt: nowIso(),
    };
    this.#run(
      `UPDATE conversations
       SET model_override = ?, execution_profile = ?, updated_at = ? WHERE id = ?`,
      updated.modelOverride,
      updated.executionProfile,
      updated.updatedAt,
      updated.id,
    );
    return updated;
  }

  listConversationMessages(conversationId: Id): ConversationMessage[] {
    return this.#all(
      "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY sequence",
      conversationId,
    ).map(mapConversationMessage);
  }

  appendMessage(
    input: Omit<ConversationMessage, "id" | "sequence" | "createdAt">,
  ): ConversationMessage {
    return this.#transaction(() => {
      const sequence = asNumber(this.#get(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS value
         FROM conversation_messages WHERE conversation_id = ?`,
        input.conversationId,
      )?.value);
      const message: ConversationMessage = {
        ...structuredClone(input),
        id: randomUUID(),
        sequence,
        createdAt: nowIso(),
      };
      this.#run(
        `INSERT INTO conversation_messages (
          id, conversation_id, run_id, sequence, role, status,
          content_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.conversationId,
        message.runId,
        message.sequence,
        message.role,
        message.status,
        toJson(message.content),
        toJson(message.metadata),
        message.createdAt,
      );
      this.#run(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        message.createdAt,
        message.conversationId,
      );
      return message;
    });
  }

  createRun(
    conversationId: Id,
    triggerMessageId: Id,
    contextRevisionId: Id | null,
    configSnapshot: RunConfigSnapshot,
  ): AgentRun {
    const run: AgentRun = {
      id: randomUUID(),
      conversationId,
      triggerMessageId,
      contextRevisionId,
      configSnapshot: structuredClone(configSnapshot),
      status: "queued",
      startedAt: null,
      completedAt: null,
      error: null,
      createdAt: nowIso(),
    };
    this.#run(
      `INSERT INTO runs (
        id, conversation_id, trigger_message_id, context_revision_id,
        config_snapshot_json, status, started_at, completed_at, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.conversationId,
      run.triggerMessageId,
      run.contextRevisionId,
      toJson(run.configSnapshot),
      run.status,
      run.startedAt,
      run.completedAt,
      run.error,
      run.createdAt,
    );
    return run;
  }

  getRun(runId: Id): AgentRun | null {
    return mapNullable(this.#get("SELECT * FROM runs WHERE id = ?", runId), mapRun);
  }

  listActiveRuns(): AgentRun[] {
    return this.#all(
      `SELECT * FROM runs WHERE status NOT IN (${placeholders(TERMINAL_RUN_STATUSES.length)})
       ORDER BY created_at`,
      ...TERMINAL_RUN_STATUSES,
    ).map(mapRun);
  }

  listRecentRuns(limit = 100): AgentRun[] {
    return this.#all(
      "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?",
      limit,
    ).map(mapRun);
  }

  updateRunStatus(runId: Id, status: RunStatus, error?: string): AgentRun {
    const current = this.getRun(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    if (current.status !== status) assertRunTransition(current.status, status);
    const now = nowIso();
    const startedAt = current.startedAt ?? (status === "queued" ? null : now);
    const completedAt = TERMINAL_RUN_STATUSES.includes(status) ? now : null;
    const nextError = error ?? current.error;
    this.#run(
      `UPDATE runs SET status = ?, started_at = ?, completed_at = ?, error = ?
       WHERE id = ?`,
      status,
      startedAt,
      completedAt,
      nextError,
      runId,
    );
    return { ...current, status, startedAt, completedAt, error: nextError };
  }

  interruptNonTerminalRuns(): number {
    const result = this.#run(
      `UPDATE runs
       SET status = 'interrupted', completed_at = ?,
           error = COALESCE(error, 'ScopeGuard restarted before this run completed.')
       WHERE status NOT IN (${placeholders(TERMINAL_RUN_STATUSES.length)})`,
      nowIso(),
      ...TERMINAL_RUN_STATUSES,
    );
    return Number(result.changes);
  }

  appendRunEvent(event: RunEvent): void {
    this.#run(
      "INSERT INTO run_events (id, run_id, type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      randomUUID(),
      event.runId,
      event.type,
      toJson(event),
      event.at,
    );
  }

  listRunEvents(runId: Id): RunEvent[] {
    return this.#all(
      "SELECT event_json FROM run_events WHERE run_id = ? ORDER BY sequence",
      runId,
    ).map((row) => fromJson<RunEvent>(row.event_json));
  }

  saveRunPartial(runId: Id, content: string): void {
    if (content.length > MAX_RUN_PARTIAL_CHARACTERS) {
      throw new Error(`Run partial must not exceed ${MAX_RUN_PARTIAL_CHARACTERS} characters.`);
    }
    this.#run(
      `INSERT INTO run_partials (run_id, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         content = excluded.content, updated_at = excluded.updated_at`,
      runId,
      content,
      nowIso(),
    );
  }

  getRunPartial(runId: Id): string | null {
    const row = this.#get("SELECT content FROM run_partials WHERE run_id = ?", runId);
    return row ? asString(row.content) : null;
  }

  clearRunPartial(runId: Id): void {
    this.#run("DELETE FROM run_partials WHERE run_id = ?", runId);
  }

  recordRunRequestManifest(
    input: Omit<RunRequestManifest, "createdAt">,
  ): RunRequestManifest {
    const manifest: RunRequestManifest = { ...structuredClone(input), createdAt: nowIso() };
    this.#run(
      `INSERT INTO run_request_manifests (
        run_id, step_sequence, provider_protocol, model, messages_json,
        tools_json, max_output_tokens, request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      manifest.runId,
      manifest.stepSequence,
      manifest.providerProtocol,
      manifest.model,
      toJson(manifest.messages),
      toJson(manifest.tools),
      manifest.maxOutputTokens,
      manifest.requestHash,
      manifest.createdAt,
    );
    return manifest;
  }

  listRunRequestManifests(runId: Id): RunRequestManifest[] {
    return this.#all(
      "SELECT * FROM run_request_manifests WHERE run_id = ? ORDER BY step_sequence",
      runId,
    ).map(mapRunRequestManifest);
  }

  appendRunUsageRecord(
    input: Omit<RunUsageRecord, "sequence" | "receivedAt">,
  ): RunUsageRecord {
    return this.#transaction(() => {
      const sequence = asNumber(this.#get(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM run_usage_records WHERE run_id = ?",
        input.runId,
      )?.value);
      const record: RunUsageRecord = { ...input, sequence, receivedAt: nowIso() };
      this.#run(
        `INSERT INTO run_usage_records (
          run_id, sequence, step_sequence, source, status,
          input_tokens, output_tokens, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.runId,
        record.sequence,
        record.stepSequence,
        record.source,
        record.status,
        record.inputTokens,
        record.outputTokens,
        record.receivedAt,
      );
      return record;
    });
  }

  listRunUsageRecords(runId: Id): RunUsageRecord[] {
    return this.#all(
      "SELECT * FROM run_usage_records WHERE run_id = ? ORDER BY sequence",
      runId,
    ).map(mapRunUsageRecord);
  }

  createToolCall(
    runId: Id,
    input: {
      providerCallId: string;
      name: string;
      description: string;
      arguments: Record<string, unknown>;
    },
  ): ToolCallRecord {
    return this.#transaction(() => {
      const sequence = asNumber(this.#get(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM tool_calls WHERE run_id = ?",
        runId,
      )?.value);
      const toolCall: ToolCallRecord = {
        id: randomUUID(),
        runId,
        sequence,
        providerCallId: input.providerCallId,
        name: input.name,
        description: input.description,
        arguments: structuredClone(input.arguments),
        status: "proposed",
        output: null,
        error: null,
        createdAt: nowIso(),
        completedAt: null,
      };
      this.#run(
        `INSERT INTO tool_calls (
          id, run_id, sequence, provider_call_id, name, description,
          arguments_json, status, output, error, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        toolCall.id,
        toolCall.runId,
        toolCall.sequence,
        toolCall.providerCallId,
        toolCall.name,
        toolCall.description,
        toJson(toolCall.arguments),
        toolCall.status,
        toolCall.output,
        toolCall.error,
        toolCall.createdAt,
        toolCall.completedAt,
      );
      return toolCall;
    });
  }

  getToolCall(toolCallId: Id): ToolCallRecord | null {
    return mapNullable(
      this.#get("SELECT * FROM tool_calls WHERE id = ?", toolCallId),
      mapToolCall,
    );
  }

  listToolCallsForRun(runId: Id): ToolCallRecord[] {
    return this.#all(
      "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY sequence",
      runId,
    ).map(mapToolCall);
  }

  updateToolCallStatus(
    toolCallId: Id,
    status: ToolCallStatus,
    result?: { output: string; isError: boolean },
  ): ToolCallRecord {
    const current = this.getToolCall(toolCallId);
    if (!current) throw new Error(`Tool call not found: ${toolCallId}`);
    if (current.status !== status && !canTransitionToolCall(current.status, status)) {
      throw new Error(`Invalid tool call status transition: ${current.status} -> ${status}`);
    }
    const terminal = [
      "succeeded",
      "failed",
      "denied",
      "cancelled",
      "effect_unknown",
    ].includes(status);
    const output = result?.output ?? current.output;
    const error = result?.isError ? result.output : current.error;
    const completedAt = terminal ? nowIso() : null;
    this.#run(
      `UPDATE tool_calls SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ?`,
      status,
      output,
      error,
      completedAt,
      toolCallId,
    );
    return { ...current, status, output, error, completedAt };
  }

  createApproval(runId: Id, toolCallId: Id, reason: string): ToolApproval {
    const approval: ToolApproval = {
      id: randomUUID(),
      toolCallId,
      runId,
      status: "pending",
      reason,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.#run(
      `INSERT INTO tool_approvals (
        id, tool_call_id, run_id, status, reason, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      approval.id,
      approval.toolCallId,
      approval.runId,
      approval.status,
      approval.reason,
      approval.createdAt,
      approval.resolvedAt,
    );
    return approval;
  }

  getApproval(approvalId: Id): ToolApproval | null {
    return mapNullable(
      this.#get("SELECT * FROM tool_approvals WHERE id = ?", approvalId),
      mapApproval,
    );
  }

  listPendingApprovals(): ToolApproval[] {
    return this.#all(
      "SELECT * FROM tool_approvals WHERE status = 'pending' ORDER BY created_at",
    ).map(mapApproval);
  }

  resolveApproval(approvalId: Id, decision: ApprovalDecision): ToolApproval {
    const current = this.getApproval(approvalId);
    if (!current) throw new Error(`Approval not found: ${approvalId}`);
    if (current.status !== "pending") throw new Error("Approval is no longer pending.");
    const status = decision === "approved-once" ? "approved" : "denied";
    const resolvedAt = nowIso();
    this.#run(
      "UPDATE tool_approvals SET status = ?, resolved_at = ? WHERE id = ?",
      status,
      resolvedAt,
      approvalId,
    );
    return { ...current, status, resolvedAt };
  }

  expirePendingApprovalsForRun(runId: Id): number {
    return Number(this.#run(
      `UPDATE tool_approvals SET status = 'expired', resolved_at = ?
       WHERE run_id = ? AND status = 'pending'`,
      nowIso(),
      runId,
    ).changes);
  }

  expirePendingApprovalsForTerminalRuns(): number {
    return Number(this.#run(
      `UPDATE tool_approvals SET status = 'expired', resolved_at = ?
       WHERE status = 'pending' AND run_id IN (
         SELECT id FROM runs WHERE status IN (${placeholders(TERMINAL_RUN_STATUSES.length)})
       )`,
      nowIso(),
      ...TERMINAL_RUN_STATUSES,
    ).changes);
  }

  cancelUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[] {
    return this.#finishUncertainToolCalls(runId);
  }

  recoverUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[] {
    return this.#finishUncertainToolCalls(runId);
  }

  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace?.currentContextRevisionId) return null;
    return mapNullable(
      this.#get(
        "SELECT * FROM workspace_context_revisions WHERE id = ?",
        workspace.currentContextRevisionId,
      ),
      mapWorkspaceContextRevision,
    );
  }

  updateWorkspaceContext(
    workspaceId: Id,
    content: string,
    sourceConversationId: Id | null = null,
    sourceRunId: Id | null = null,
  ): WorkspaceContextRevision {
    return this.#transaction(() => {
      const current = this.getWorkspaceContext(workspaceId);
      const version = (current?.version ?? 0) + 1;
      const revision: WorkspaceContextRevision = {
        id: randomUUID(),
        workspaceId,
        version,
        parentId: current?.id ?? null,
        title: `Workspace context v${version}`,
        content,
        sourceConversationId,
        sourceRunId,
        publishedBy: sourceRunId ? "agent" : "user",
        createdAt: nowIso(),
      };
      this.#run(
        `INSERT INTO workspace_context_revisions (
          id, workspace_id, version, parent_id, title, content,
          source_conversation_id, source_run_id, published_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision.id,
        revision.workspaceId,
        revision.version,
        revision.parentId,
        revision.title,
        revision.content,
        revision.sourceConversationId,
        revision.sourceRunId,
        revision.publishedBy,
        revision.createdAt,
      );
      this.#run(
        `UPDATE workspaces
         SET current_context_revision_id = ?, updated_at = ? WHERE id = ?`,
        revision.id,
        revision.createdAt,
        workspaceId,
      );
      return revision;
    });
  }

  listSchemaTables(): string[] {
    return this.#all(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((row) => asString(row.name));
  }

  #finishUncertainToolCalls(runId: Id): ToolCallRecord[] {
    const unfinished = this.listToolCallsForRun(runId).filter((toolCall) =>
      ["proposed", "awaiting-approval", "running"].includes(toolCall.status)
    );
    return unfinished.map((toolCall) => this.updateToolCallStatus(
      toolCall.id,
      toolCall.status === "running" ? "effect_unknown" : "cancelled",
    ));
  }

  #initializeSchema(): void {
    const tables = this.listSchemaTables();
    if (tables.length > 0 && !tables.includes("schema_metadata")) {
      throw incompatibleSchemaError();
    }
    if (tables.includes("schema_metadata")) {
      const columns = this.#all("PRAGMA table_info(schema_metadata)")
        .map((row) => asString(row.name));
      if (!columns.includes("schema_id") || !columns.includes("schema_version")) {
        throw incompatibleSchemaError();
      }
      const metadata = this.#get(
        "SELECT schema_id, schema_version FROM schema_metadata LIMIT 1",
      );
      if (
        !metadata ||
        asString(metadata.schema_id) !== SCOPEGUARD_SCHEMA_ID ||
        asNumber(metadata.schema_version) !== SCOPEGUARD_SCHEMA_VERSION
      ) {
        throw incompatibleSchemaError();
      }
      return;
    }

    this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE schema_metadata (
        schema_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata (schema_id, schema_version, created_at)
      VALUES ('${SCOPEGUARD_SCHEMA_ID}', ${SCOPEGUARD_SCHEMA_VERSION}, '${nowIso()}');

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, local_root_path TEXT UNIQUE,
        current_context_revision_id TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, default_model TEXT NOT NULL, api_key_ref TEXT,
        custom_headers_json TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL, instructions TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
        model_override TEXT, default_execution_profile TEXT NOT NULL,
        tool_policy_json TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id), title TEXT NOT NULL,
        status TEXT NOT NULL, model_override TEXT, execution_profile TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT, sequence INTEGER NOT NULL, role TEXT NOT NULL,
        status TEXT NOT NULL, content_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(conversation_id, sequence)
      ) STRICT;
      CREATE TABLE workspace_context_revisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent_id TEXT REFERENCES workspace_context_revisions(id),
        title TEXT NOT NULL, content TEXT NOT NULL,
        source_conversation_id TEXT REFERENCES conversations(id),
        source_run_id TEXT, published_by TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, version)
      ) STRICT;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        trigger_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
        context_revision_id TEXT REFERENCES workspace_context_revisions(id),
        config_snapshot_json TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, error TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_active_run_per_conversation
      ON runs(conversation_id)
      WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted');
      CREATE TABLE run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE run_partials (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        content TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE run_request_manifests (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_sequence INTEGER NOT NULL, provider_protocol TEXT NOT NULL,
        model TEXT NOT NULL, messages_json TEXT NOT NULL, tools_json TEXT NOT NULL,
        max_output_tokens INTEGER, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, step_sequence)
      ) STRICT;
      CREATE TABLE run_usage_records (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, step_sequence INTEGER NOT NULL,
        source TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER,
        output_tokens INTEGER, received_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      ) STRICT;
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, provider_call_id TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, arguments_json TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        completed_at TEXT, UNIQUE(run_id, sequence), UNIQUE(run_id, provider_call_id)
      ) STRICT;
      CREATE TABLE tool_approvals (
        id TEXT PRIMARY KEY,
        tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX one_pending_approval_per_tool_call
      ON tool_approvals(tool_call_id) WHERE status = 'pending';
      CREATE INDEX conversations_by_workspace ON conversations(workspace_id, updated_at);
      CREATE INDEX messages_by_conversation ON conversation_messages(conversation_id, sequence);
      CREATE INDEX runs_by_conversation ON runs(conversation_id, created_at);
      COMMIT;
    `);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #run(sql: string, ...values: SQLInputValue[]) {
    return this.#database.prepare(sql).run(...values);
  }

  #get(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.#database.prepare(sql).get(...values) as Row | undefined;
  }

  #all(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.#database.prepare(sql).all(...values) as Row[];
  }

  #secureFiles(): void {
    if (!this.#databasePath) return;
    for (const path of [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`,
    ]) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // WAL and SHM are optional and may disappear after close.
      }
    }
  }
}

function mapWorkspace(row: Row): Workspace {
  return {
    id: asString(row.id), name: asString(row.name),
    localRootPath: asNullableString(row.local_root_path),
    currentContextRevisionId: asNullableString(row.current_context_revision_id),
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
    lastOpenedAt: asString(row.last_opened_at),
  };
}

function mapProviderProfile(row: Row): ProviderProfile {
  return {
    id: asString(row.id), name: asString(row.name),
    protocol: asString(row.protocol) as ProviderProfile["protocol"],
    baseUrl: asString(row.base_url), defaultModel: asString(row.default_model),
    apiKeyRef: asNullableString(row.api_key_ref),
    customHeaders: fromJson<Record<string, string>>(row.custom_headers_json),
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function mapAgent(row: Row): Agent {
  return {
    id: asString(row.id), workspaceId: asString(row.workspace_id),
    name: asString(row.name), instructions: asString(row.instructions),
    providerProfileId: asString(row.provider_profile_id),
    modelOverride: asNullableString(row.model_override),
    defaultExecutionProfile: asString(row.default_execution_profile) as Agent["defaultExecutionProfile"],
    toolPolicy: fromJson<Agent["toolPolicy"]>(row.tool_policy_json),
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function mapConversation(row: Row): Conversation {
  return {
    id: asString(row.id), workspaceId: asString(row.workspace_id),
    agentId: asString(row.agent_id), title: asString(row.title),
    status: asString(row.status) as Conversation["status"],
    modelOverride: asNullableString(row.model_override),
    executionProfile: asString(row.execution_profile) as Conversation["executionProfile"],
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function mapConversationMessage(row: Row): ConversationMessage {
  return {
    id: asString(row.id), conversationId: asString(row.conversation_id),
    runId: asNullableString(row.run_id), sequence: asNumber(row.sequence),
    role: asString(row.role) as ConversationMessage["role"],
    status: asString(row.status) as ConversationMessage["status"],
    content: fromJson<ConversationMessage["content"]>(row.content_json),
    metadata: fromJson<Record<string, unknown>>(row.metadata_json),
    createdAt: asString(row.created_at),
  };
}

function mapRun(row: Row): AgentRun {
  return {
    id: asString(row.id), conversationId: asString(row.conversation_id),
    triggerMessageId: asString(row.trigger_message_id),
    contextRevisionId: asNullableString(row.context_revision_id),
    configSnapshot: fromJson<RunConfigSnapshot>(row.config_snapshot_json),
    status: asString(row.status) as RunStatus,
    startedAt: asNullableString(row.started_at),
    completedAt: asNullableString(row.completed_at),
    error: asNullableString(row.error), createdAt: asString(row.created_at),
  };
}

function mapRunRequestManifest(row: Row): RunRequestManifest {
  return {
    runId: asString(row.run_id), stepSequence: asNumber(row.step_sequence),
    providerProtocol: asString(row.provider_protocol) as RunRequestManifest["providerProtocol"],
    model: asString(row.model),
    messages: fromJson<RunRequestManifest["messages"]>(row.messages_json),
    tools: fromJson<RunRequestManifest["tools"]>(row.tools_json),
    maxOutputTokens: asNullableNumber(row.max_output_tokens),
    requestHash: asString(row.request_hash), createdAt: asString(row.created_at),
  };
}

function mapRunUsageRecord(row: Row): RunUsageRecord {
  return {
    runId: asString(row.run_id), sequence: asNumber(row.sequence),
    stepSequence: asNumber(row.step_sequence),
    source: asString(row.source) as RunUsageRecord["source"],
    status: asString(row.status) as RunUsageRecord["status"],
    inputTokens: asNullableNumber(row.input_tokens),
    outputTokens: asNullableNumber(row.output_tokens),
    receivedAt: asString(row.received_at),
  };
}

function mapToolCall(row: Row): ToolCallRecord {
  return {
    id: asString(row.id), runId: asString(row.run_id),
    sequence: asNumber(row.sequence), providerCallId: asString(row.provider_call_id),
    name: asString(row.name), description: asString(row.description),
    arguments: fromJson<Record<string, unknown>>(row.arguments_json),
    status: asString(row.status) as ToolCallStatus,
    output: asNullableString(row.output), error: asNullableString(row.error),
    createdAt: asString(row.created_at), completedAt: asNullableString(row.completed_at),
  };
}

function mapApproval(row: Row): ToolApproval {
  return {
    id: asString(row.id), toolCallId: asString(row.tool_call_id),
    runId: asString(row.run_id), status: asString(row.status) as ToolApproval["status"],
    reason: asString(row.reason), createdAt: asString(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
  };
}

function mapWorkspaceContextRevision(row: Row): WorkspaceContextRevision {
  return {
    id: asString(row.id), workspaceId: asString(row.workspace_id),
    version: asNumber(row.version), parentId: asNullableString(row.parent_id),
    title: asString(row.title), content: asString(row.content),
    sourceConversationId: asNullableString(row.source_conversation_id),
    sourceRunId: asNullableString(row.source_run_id),
    publishedBy: asString(row.published_by) as WorkspaceContextRevision["publishedBy"],
    createdAt: asString(row.created_at),
  };
}

function mapNullable<T>(row: Row | undefined, mapper: (value: Row) => T): T | null {
  return row ? mapper(row) : null;
}

function toJson(value: unknown): string { return JSON.stringify(value); }
function fromJson<T>(value: unknown): T { return JSON.parse(asString(value)) as T; }
function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string database value.");
  return value;
}
function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}
function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Expected a number database value.");
  return value;
}
function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}
function nowIso(): string { return new Date().toISOString(); }
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
function incompatibleSchemaError(): Error {
  return new Error(
    "This database belongs to a pre-V1 ScopeGuard schema. Start with a fresh V1 profile.",
  );
}
