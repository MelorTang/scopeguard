import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  SCOPEGUARD_SCHEMA_VERSION,
  assertRunTransition,
  mergeToolPolicy,
  type ApprovalDecision,
  type AgentProfile,
  type AgentRun,
  type AgentThread,
  type ContextRevision,
  type CreateAgentProfileInput,
  type CreateProjectInput,
  type CreateThreadInput,
  type Id,
  type Project,
  type ProviderProfile,
  type ProviderProfileInput,
  type RunConfigSnapshot,
  type RunEvent,
  type RunStatus,
  type ThreadMessage,
  type ToolApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

type UnknownRow = Record<string, unknown>;
const MAX_RUN_PARTIAL_CHARACTERS = 1_000_000;

export class ScopeGuardStore {
  readonly #database: DatabaseSync;
  readonly #databasePath: string | null;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      const databaseDirectory = dirname(databasePath);
      mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    }

    this.#databasePath = databasePath === ":memory:" ? null : databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL");
    }
    this.#migrate();
    if (this.#databasePath) {
      secureDatabaseFiles(this.#databasePath);
    }
  }

  close(): void {
    this.#database.close();
    if (this.#databasePath) {
      secureDatabaseFiles(this.#databasePath);
    }
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return {
      projects: this.listProjects(),
      providerProfiles: this.listProviderProfiles(),
      agentProfiles: this.listAgentProfiles(),
      threads: this.listThreads(),
      activeRuns: this.listActiveRuns(),
      recentRuns: this.listRecentRuns(),
      pendingApprovals: this.listPendingApprovals().flatMap((approval) => {
        const toolCall = this.getToolCall(approval.toolCallId);
        return toolCall ? [{ approval, toolCall }] : [];
      }),
    };
  }

  listProjects(): Project[] {
    return this.#all("SELECT * FROM projects ORDER BY last_opened_at DESC").map(mapProject);
  }

  getProject(projectId: Id): Project | null {
    const row = this.#get("SELECT * FROM projects WHERE id = ?", projectId);
    return row ? mapProject(row) : null;
  }

  addProject(input: CreateProjectInput): Project {
    const existing = this.#get(
      "SELECT * FROM projects WHERE root_path = ?",
      input.rootPath,
    );
    const now = new Date().toISOString();

    if (existing) {
      this.#run(
        "UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?",
        now,
        now,
        asString(existing.id),
      );
      return mapProject({
        ...existing,
        last_opened_at: now,
        updated_at: now,
      });
    }

    const project: Project = {
      id: randomUUID(),
      name: input.name?.trim() || basenameFromPath(input.rootPath),
      rootPath: input.rootPath,
      currentContextRevisionId: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };

    this.#run(
      `INSERT INTO projects (
        id, name, root_path, current_context_revision_id,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      project.name,
      project.rootPath,
      project.currentContextRevisionId,
      project.createdAt,
      project.updatedAt,
      project.lastOpenedAt,
    );

    return project;
  }

  listProviderProfiles(): ProviderProfile[] {
    return this.#all("SELECT * FROM provider_profiles ORDER BY name COLLATE NOCASE").map(
      mapProviderProfile,
    );
  }

  getProviderProfile(providerProfileId: Id): ProviderProfile | null {
    const row = this.#get(
      "SELECT * FROM provider_profiles WHERE id = ?",
      providerProfileId,
    );
    return row ? mapProviderProfile(row) : null;
  }

  saveProviderProfile(
    input: ProviderProfileInput & { id?: Id },
    apiKeyRef: string | null,
  ): ProviderProfile {
    const existing = input.id ? this.getProviderProfile(input.id) : null;
    const now = new Date().toISOString();
    const profile: ProviderProfile = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      defaultModel: input.defaultModel,
      apiKeyRef,
      customHeaders: input.customHeaders ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.#run(
      `INSERT INTO provider_profiles (
        id, name, protocol, base_url, default_model, api_key_ref,
        custom_headers_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        protocol = excluded.protocol,
        base_url = excluded.base_url,
        default_model = excluded.default_model,
        api_key_ref = excluded.api_key_ref,
        custom_headers_json = excluded.custom_headers_json,
        updated_at = excluded.updated_at`,
      profile.id,
      profile.name,
      profile.protocol,
      profile.baseUrl,
      profile.defaultModel,
      profile.apiKeyRef,
      JSON.stringify(profile.customHeaders),
      profile.createdAt,
      profile.updatedAt,
    );

    return profile;
  }

  deleteProviderProfile(providerProfileId: Id): void {
    this.#run("DELETE FROM provider_profiles WHERE id = ?", providerProfileId);
  }

  listAgentProfiles(projectId?: Id): AgentProfile[] {
    const rows = projectId
      ? this.#all(
          "SELECT * FROM agent_profiles WHERE project_id = ? ORDER BY name COLLATE NOCASE",
          projectId,
        )
      : this.#all("SELECT * FROM agent_profiles ORDER BY name COLLATE NOCASE");
    return rows.map(mapAgentProfile);
  }

  getAgentProfile(agentProfileId: Id): AgentProfile | null {
    const row = this.#get("SELECT * FROM agent_profiles WHERE id = ?", agentProfileId);
    return row ? mapAgentProfile(row) : null;
  }

  createAgentProfile(input: CreateAgentProfileInput): AgentProfile {
    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: randomUUID(),
      projectId: input.projectId,
      name: input.name.trim(),
      runtimeKind: input.runtimeKind ?? "native",
      instructions: input.instructions.trim(),
      providerProfileId: input.providerProfileId ?? null,
      modelOverride: input.modelOverride?.trim() || null,
      toolPolicy: mergeToolPolicy(input.toolPolicy),
      cliConfig: input.cliConfig ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.#run(
      `INSERT INTO agent_profiles (
        id, project_id, name, runtime_kind, instructions, provider_profile_id,
        model_override, tool_policy_json, cli_config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      profile.id,
      profile.projectId,
      profile.name,
      profile.runtimeKind,
      profile.instructions,
      profile.providerProfileId,
      profile.modelOverride,
      JSON.stringify(profile.toolPolicy),
      profile.cliConfig ? JSON.stringify(profile.cliConfig) : null,
      profile.createdAt,
      profile.updatedAt,
    );

    return profile;
  }

  listThreads(projectId?: Id): AgentThread[] {
    const rows = projectId
      ? this.#all(
          "SELECT * FROM agent_threads WHERE project_id = ? ORDER BY updated_at DESC",
          projectId,
        )
      : this.#all("SELECT * FROM agent_threads ORDER BY updated_at DESC");
    return rows.map(mapAgentThread);
  }

  getThread(threadId: Id): AgentThread | null {
    const row = this.#get("SELECT * FROM agent_threads WHERE id = ?", threadId);
    return row ? mapAgentThread(row) : null;
  }

  createThread(input: CreateThreadInput): AgentThread {
    const now = new Date().toISOString();
    const thread: AgentThread = {
      id: randomUUID(),
      projectId: input.projectId,
      agentProfileId: input.agentProfileId,
      title: input.title?.trim() || "New conversation",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    this.#run(
      `INSERT INTO agent_threads (
        id, project_id, agent_profile_id, title, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      thread.id,
      thread.projectId,
      thread.agentProfileId,
      thread.title,
      thread.status,
      thread.createdAt,
      thread.updatedAt,
    );

    return thread;
  }

  listThreadMessages(threadId: Id): ThreadMessage[] {
    return this.#all(
      "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY sequence ASC",
      threadId,
    ).map(mapThreadMessage);
  }

  appendMessage(
    input: Omit<ThreadMessage, "id" | "sequence" | "createdAt">,
  ): ThreadMessage {
    return this.#transaction(() => this.#appendMessage(input));
  }

  saveRunPartial(runId: Id, content: string): void {
    if (content.length > MAX_RUN_PARTIAL_CHARACTERS) {
      throw new Error(
        `Run partial output must not exceed ${MAX_RUN_PARTIAL_CHARACTERS} characters.`,
      );
    }
    if (!content) {
      this.clearRunPartial(runId);
      return;
    }
    this.#run(
      `INSERT INTO run_partials (run_id, content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
      runId,
      content,
      new Date().toISOString(),
    );
  }

  clearRunPartial(runId: Id): void {
    this.#run("DELETE FROM run_partials WHERE run_id = ?", runId);
  }

  createRun(
    threadId: Id,
    triggerMessageId: Id,
    contextRevisionId: Id | null,
    configSnapshot: RunConfigSnapshot,
  ): AgentRun {
    const run: AgentRun = {
      id: randomUUID(),
      threadId,
      triggerMessageId,
      contextRevisionId,
      configSnapshot,
      status: "queued",
      startedAt: null,
      completedAt: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.#run(
      `INSERT INTO agent_runs (
        id, thread_id, trigger_message_id, context_revision_id,
        config_snapshot_json, status, started_at, completed_at, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.threadId,
      run.triggerMessageId,
      run.contextRevisionId,
      JSON.stringify(run.configSnapshot),
      run.status,
      run.startedAt,
      run.completedAt,
      run.error,
      run.createdAt,
    );
    return run;
  }

  getRun(runId: Id): AgentRun | null {
    const row = this.#get("SELECT * FROM agent_runs WHERE id = ?", runId);
    return row ? mapAgentRun(row) : null;
  }

  listActiveRuns(): AgentRun[] {
    return this.#all(
      `SELECT * FROM agent_runs
       WHERE status IN (
         'queued', 'preparing', 'running', 'waiting-approval', 'cancelling'
       )
       ORDER BY created_at ASC`,
    ).map(mapAgentRun);
  }

  listRecentRuns(limit = 100): AgentRun[] {
    return this.#all(
      `SELECT * FROM agent_runs
       WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
       ORDER BY created_at DESC
       LIMIT ?`,
      limit,
    ).map(mapAgentRun);
  }

  updateRunStatus(runId: Id, status: RunStatus, error?: string): AgentRun {
    const current = this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }
    assertRunTransition(current.status, status);

    const now = new Date().toISOString();
    const startedAt = status === "running" && !current.startedAt ? now : current.startedAt;
    const completedAt = isTerminalRunStatus(status) ? now : null;
    this.#run(
      `UPDATE agent_runs
       SET status = ?, started_at = ?, completed_at = ?, error = ?
       WHERE id = ?`,
      status,
      startedAt,
      completedAt,
      error ?? null,
      runId,
    );
    this.#touchThread(current.threadId, now);

    return {
      ...current,
      status,
      startedAt,
      completedAt,
      error: error ?? null,
    };
  }

  interruptNonTerminalRuns(): number {
    return this.#transaction(() => {
      const activeRuns = this.#all(
        `SELECT id, thread_id FROM agent_runs
         WHERE status IN (
           'queued', 'preparing', 'running', 'waiting-approval', 'cancelling'
         )`,
      );
      for (const activeRun of activeRuns) {
        const runId = asString(activeRun.id);
        const partial = this.#get(
          "SELECT content, updated_at FROM run_partials WHERE run_id = ?",
          runId,
        );
        if (!partial || !asString(partial.content).trim()) {
          continue;
        }
        const latestAssistant = this.#get(
          `SELECT created_at FROM thread_messages
           WHERE run_id = ? AND role = 'assistant'
           ORDER BY sequence DESC LIMIT 1`,
          runId,
        );
        if (
          latestAssistant &&
          asString(latestAssistant.created_at) >= asString(partial.updated_at)
        ) {
          continue;
        }
        this.#appendMessage({
          threadId: asString(activeRun.thread_id),
          runId,
          role: "assistant",
          status: "interrupted",
          content: [{ type: "text", text: asString(partial.content) }],
          metadata: { partial: true, recovered: true },
        });
      }

      const result = this.#database
        .prepare(
          `UPDATE agent_runs
           SET status = 'interrupted', completed_at = ?,
               error = COALESCE(error, 'The agent host stopped before this run completed.')
           WHERE status IN (
             'queued', 'preparing', 'running', 'waiting-approval', 'cancelling'
           )`,
        )
        .run(new Date().toISOString());
      this.#run("DELETE FROM run_partials");
      return Number(result.changes);
    });
  }

  appendRunEvent(event: RunEvent): void {
    const row = this.#get(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM run_events WHERE run_id = ?`,
      event.runId,
    );
    this.#run(
      `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      event.runId,
      asNumber(row?.next_sequence ?? 1),
      event.type,
      JSON.stringify(event),
      event.at,
    );
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
      const row = this.#get(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM tool_calls WHERE run_id = ?`,
        runId,
      );
      const toolCall: ToolCallRecord = {
        id: randomUUID(),
        runId,
        sequence: asNumber(row?.next_sequence ?? 1),
        providerCallId: input.providerCallId,
        name: input.name,
        description: input.description,
        arguments: input.arguments,
        status: "proposed",
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
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
        JSON.stringify(toolCall.arguments),
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
    const row = this.#get("SELECT * FROM tool_calls WHERE id = ?", toolCallId);
    return row ? mapToolCall(row) : null;
  }

  listToolCallsForRun(runId: Id): ToolCallRecord[] {
    return this.#all(
      "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY sequence ASC",
      runId,
    ).map(mapToolCall);
  }

  updateToolCallStatus(
    toolCallId: Id,
    status: ToolCallStatus,
    result?: { output: string; isError: boolean },
  ): ToolCallRecord {
    const current = this.getToolCall(toolCallId);
    if (!current) {
      throw new Error(`Tool call not found: ${toolCallId}`);
    }
    const completedAt = isTerminalToolCallStatus(status)
      ? new Date().toISOString()
      : null;
    const output = result?.output ?? current.output;
    const error = result?.isError ? result.output : null;
    this.#run(
      `UPDATE tool_calls
       SET status = ?, output = ?, error = ?, completed_at = ?
       WHERE id = ?`,
      status,
      output,
      error,
      completedAt,
      toolCallId,
    );
    return {
      ...current,
      status,
      output,
      error,
      completedAt,
    };
  }

  createApproval(
    runId: Id,
    toolCallId: Id,
    reason: string,
  ): ToolApproval {
    const approval: ToolApproval = {
      id: randomUUID(),
      runId,
      toolCallId,
      status: "pending",
      reason,
      createdAt: new Date().toISOString(),
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
    const row = this.#get("SELECT * FROM tool_approvals WHERE id = ?", approvalId);
    return row ? mapToolApproval(row) : null;
  }

  listPendingApprovals(): ToolApproval[] {
    return this.#all(
      "SELECT * FROM tool_approvals WHERE status = 'pending' ORDER BY created_at ASC",
    ).map(mapToolApproval);
  }

  resolveApproval(
    approvalId: Id,
    decision: ApprovalDecision,
  ): ToolApproval {
    const approval = this.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }
    if (approval.status !== "pending") {
      throw new Error(`Approval is already resolved: ${approvalId}`);
    }
    const status: ToolApproval["status"] =
      decision === "approved-once" ? "approved" : "denied";
    const resolvedAt = new Date().toISOString();
    this.#run(
      `UPDATE tool_approvals SET status = ?, resolved_at = ? WHERE id = ?`,
      status,
      resolvedAt,
      approvalId,
    );
    return { ...approval, status, resolvedAt };
  }

  expirePendingApprovalsForRun(runId: Id): number {
    return this.#expirePendingApprovals(
      "run_id = ?",
      [runId],
    );
  }

  expirePendingApprovalsForTerminalRuns(): number {
    return this.#expirePendingApprovals(
      `run_id IN (
        SELECT id FROM agent_runs
        WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
      )`,
      [],
    );
  }

  cancelUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[] {
    this.#run(
      `UPDATE tool_calls
       SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
       WHERE run_id = ?
         AND status IN ('proposed', 'awaiting-approval', 'running')`,
      new Date().toISOString(),
      runId,
    );
    return this.listToolCallsForRun(runId);
  }

  cancelUnfinishedToolCallsForTerminalRuns(): number {
    const result = this.#database.prepare(
      `UPDATE tool_calls
       SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
       WHERE status IN ('proposed', 'awaiting-approval', 'running')
         AND run_id IN (
           SELECT id FROM agent_runs
           WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
         )`,
    ).run(new Date().toISOString());
    return Number(result.changes);
  }

  getProjectContext(projectId: Id): ContextRevision | null {
    const row = this.#get(
      `SELECT * FROM project_context_versions
       WHERE project_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      projectId,
    );
    return row ? mapContextRevision(row) : null;
  }

  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId: Id | null = null,
    sourceRunId: Id | null = null,
  ): ContextRevision {
    return this.#transaction(() => {
      const parent = this.getProjectContext(projectId);
      const row = this.#get(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM project_context_versions WHERE project_id = ?`,
        projectId,
      );
      const version: ContextRevision = {
        id: randomUUID(),
        projectId,
        version: asNumber(row?.next_version ?? 1),
        parentId: parent?.id ?? null,
        content,
        sourceThreadId,
        sourceRunId,
        createdAt: new Date().toISOString(),
      };
      this.#run(
        `INSERT INTO project_context_versions (
          id, project_id, version, parent_id, content, source_thread_id,
          source_run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        version.id,
        version.projectId,
        version.version,
        version.parentId,
        version.content,
        version.sourceThreadId,
        version.sourceRunId,
        version.createdAt,
      );
      this.#run(
        `UPDATE projects
         SET current_context_revision_id = ?, updated_at = ?
         WHERE id = ?`,
        version.id,
        version.createdAt,
        projectId,
      );
      return version;
    });
  }

  #migrate(): void {
    this.#database.exec(
      `CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    const versionRow = this.#get(
      "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
    );
    let currentVersion = versionRow
      ? Number.parseInt(asString(versionRow.value), 10)
      : 0;
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new Error("ScopeGuard database has an invalid schema version.");
    }
    if (currentVersion > SCOPEGUARD_SCHEMA_VERSION) {
      throw new Error(
        `ScopeGuard database schema ${currentVersion} is newer than supported schema ${SCOPEGUARD_SCHEMA_VERSION}.`,
      );
    }
    if (currentVersion === SCOPEGUARD_SCHEMA_VERSION) {
      return;
    }

    if (currentVersion < 1) {
      this.#transaction(() => {
        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        current_context_revision_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        default_model TEXT NOT NULL,
        api_key_ref TEXT,
        custom_headers_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        instructions TEXT NOT NULL,
        provider_profile_id TEXT REFERENCES provider_profiles(id),
        model_override TEXT,
        tool_policy_json TEXT NOT NULL,
        cli_config_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        trigger_message_id TEXT NOT NULL REFERENCES thread_messages(id),
        context_revision_id TEXT,
        config_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        content_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        provider_call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tool_approvals (
        id TEXT PRIMARY KEY,
        tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS project_context_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent_id TEXT REFERENCES project_context_versions(id),
        content TEXT NOT NULL,
        source_thread_id TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
        source_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_threads_project_updated
        ON agent_threads(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_sequence
        ON thread_messages(thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_runs_thread_created
        ON agent_runs(thread_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_thread
        ON agent_runs(thread_id)
        WHERE status IN (
          'queued', 'preparing', 'running', 'waiting-approval', 'cancelling'
        );
      CREATE INDEX IF NOT EXISTS idx_context_project_version
        ON project_context_versions(project_id, version DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_run_sequence
        ON tool_calls(run_id, sequence);
      `);

        this.#run(
          `INSERT INTO schema_metadata (key, value)
           VALUES ('schema_version', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        );
      });
      currentVersion = 1;
    }

    if (currentVersion < 2) {
      this.#transaction(() => {
        const now = new Date().toISOString();
        this.#database.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_run_provider_call
           ON tool_calls(run_id, provider_call_id)`,
        );
        this.#run(
          `UPDATE provider_profiles
           SET custom_headers_json = '{}', updated_at = ?
           WHERE custom_headers_json <> '{}'`,
          now,
        );
        const profiles = this.#all(
          `SELECT id, cli_config_json FROM agent_profiles
           WHERE cli_config_json IS NOT NULL`,
        );
        for (const row of profiles) {
          const config = parseJsonObject(row.cli_config_json);
          this.#run(
            `UPDATE agent_profiles
             SET cli_config_json = ?, updated_at = ?
             WHERE id = ?`,
            JSON.stringify({
              ...config,
              cwd: null,
              env: {},
            }),
            now,
            asString(row.id),
          );
        }
        this.#run(
          `UPDATE schema_metadata SET value = '2'
           WHERE key = 'schema_version'`,
        );
      });
      currentVersion = 2;
    }

    if (currentVersion < 3) {
      this.#transaction(() => {
        this.#database.exec(
          `CREATE TABLE IF NOT EXISTS run_partials (
            run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
        );
        this.#run(
          `UPDATE schema_metadata SET value = '3'
           WHERE key = 'schema_version'`,
        );
      });
    }
  }

  #appendMessage(
    input: Omit<ThreadMessage, "id" | "sequence" | "createdAt">,
  ): ThreadMessage {
    const row = this.#get(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM thread_messages WHERE thread_id = ?`,
      input.threadId,
    );
    const message: ThreadMessage = {
      ...input,
      id: randomUUID(),
      sequence: asNumber(row?.next_sequence ?? 1),
      createdAt: new Date().toISOString(),
    };

    this.#run(
      `INSERT INTO thread_messages (
        id, thread_id, run_id, sequence, role, status, content_json,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      message.threadId,
      message.runId,
      message.sequence,
      message.role,
      message.status,
      JSON.stringify(message.content),
      JSON.stringify(message.metadata),
      message.createdAt,
    );
    this.#touchThread(message.threadId, message.createdAt);
    return message;
  }

  #touchThread(threadId: Id, updatedAt: string): void {
    this.#run(
      "UPDATE agent_threads SET updated_at = ? WHERE id = ?",
      updatedAt,
      threadId,
    );
  }

  #expirePendingApprovals(
    condition: string,
    parameters: SQLInputValue[],
  ): number {
    return this.#transaction(() => {
      const pending = this.#all(
        `SELECT tool_call_id FROM tool_approvals
         WHERE status = 'pending' AND ${condition}`,
        ...parameters,
      );
      if (pending.length === 0) {
        return 0;
      }
      const now = new Date().toISOString();
      this.#database.prepare(
        `UPDATE tool_calls
         SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
         WHERE status IN ('proposed', 'awaiting-approval')
           AND id IN (
             SELECT tool_call_id FROM tool_approvals
             WHERE status = 'pending' AND ${condition}
           )`,
      ).run(now, ...parameters);
      const result = this.#database.prepare(
        `UPDATE tool_approvals
         SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND ${condition}`,
      ).run(now, ...parameters);
      return Number(result.changes);
    });
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

  #run(sql: string, ...values: SQLInputValue[]): void {
    this.#database.prepare(sql).run(...values);
  }

  #get(sql: string, ...values: SQLInputValue[]): UnknownRow | undefined {
    return this.#database.prepare(sql).get(...values) as UnknownRow | undefined;
  }

  #all(sql: string, ...values: SQLInputValue[]): UnknownRow[] {
    return this.#database.prepare(sql).all(...values) as UnknownRow[];
  }
}

function mapProject(row: UnknownRow): Project {
  return {
    id: asString(row.id),
    name: asString(row.name),
    rootPath: asString(row.root_path),
    currentContextRevisionId: asNullableString(row.current_context_revision_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    lastOpenedAt: asString(row.last_opened_at),
  };
}

function mapProviderProfile(row: UnknownRow): ProviderProfile {
  return {
    id: asString(row.id),
    name: asString(row.name),
    protocol: asString(row.protocol) as ProviderProfile["protocol"],
    baseUrl: asString(row.base_url),
    defaultModel: asString(row.default_model),
    apiKeyRef: asNullableString(row.api_key_ref),
    customHeaders: parseJsonStringRecord(row.custom_headers_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapAgentProfile(row: UnknownRow): AgentProfile {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    name: asString(row.name),
    runtimeKind: asString(row.runtime_kind) as AgentProfile["runtimeKind"],
    instructions: asString(row.instructions),
    providerProfileId: asNullableString(row.provider_profile_id),
    modelOverride: asNullableString(row.model_override),
    toolPolicy: {
      ...mergeToolPolicy(undefined),
      ...parseJsonObject(row.tool_policy_json),
    } as AgentProfile["toolPolicy"],
    cliConfig: parseNullableJsonObject(row.cli_config_json) as AgentProfile["cliConfig"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapAgentThread(row: UnknownRow): AgentThread {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    agentProfileId: asString(row.agent_profile_id),
    title: asString(row.title),
    status: asString(row.status) as AgentThread["status"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapThreadMessage(row: UnknownRow): ThreadMessage {
  return {
    id: asString(row.id),
    threadId: asString(row.thread_id),
    runId: asNullableString(row.run_id),
    sequence: asNumber(row.sequence),
    role: asString(row.role) as ThreadMessage["role"],
    status: asString(row.status) as ThreadMessage["status"],
    content: parseJsonArray(row.content_json) as ThreadMessage["content"],
    metadata: parseJsonObject(row.metadata_json),
    createdAt: asString(row.created_at),
  };
}

function mapAgentRun(row: UnknownRow): AgentRun {
  return {
    id: asString(row.id),
    threadId: asString(row.thread_id),
    triggerMessageId: asString(row.trigger_message_id),
    contextRevisionId: asNullableString(row.context_revision_id),
    configSnapshot: parseJsonObject(row.config_snapshot_json) as AgentRun["configSnapshot"],
    status: asString(row.status) as RunStatus,
    startedAt: asNullableString(row.started_at),
    completedAt: asNullableString(row.completed_at),
    error: asNullableString(row.error),
    createdAt: asString(row.created_at),
  };
}

function mapContextRevision(row: UnknownRow): ContextRevision {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    version: asNumber(row.version),
    parentId: asNullableString(row.parent_id),
    content: asString(row.content),
    sourceThreadId: asNullableString(row.source_thread_id),
    sourceRunId: asNullableString(row.source_run_id),
    createdAt: asString(row.created_at),
  };
}

function mapToolCall(row: UnknownRow): ToolCallRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    sequence: asNumber(row.sequence),
    providerCallId: asString(row.provider_call_id),
    name: asString(row.name),
    description: asString(row.description),
    arguments: parseJsonObject(row.arguments_json),
    status: asString(row.status) as ToolCallStatus,
    output: asNullableString(row.output),
    error: asNullableString(row.error),
    createdAt: asString(row.created_at),
    completedAt: asNullableString(row.completed_at),
  };
}

function mapToolApproval(row: UnknownRow): ToolApproval {
  return {
    id: asString(row.id),
    toolCallId: asString(row.tool_call_id),
    runId: asString(row.run_id),
    status: asString(row.status) as ToolApproval["status"],
    reason: asString(row.reason),
    createdAt: asString(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string database value, received ${typeof value}.`);
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected numeric database value, received ${typeof value}.`);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseJsonObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseJsonObject(value);
}

function basenameFromPath(rootPath: string): string {
  const normalized = rootPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  return segments.at(-1) || "Untitled project";
}

function secureDatabaseFiles(databasePath: string): void {
  chmodExisting(databasePath, 0o600);
  chmodExisting(`${databasePath}-wal`, 0o600);
  chmodExisting(`${databasePath}-shm`, 0o600);
  chmodExisting(`${databasePath}-journal`, 0o600);
}

function chmodExisting(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function isTerminalToolCallStatus(status: ToolCallStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "denied" ||
    status === "cancelled"
  );
}
