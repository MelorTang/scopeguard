import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  SCOPEGUARD_SCHEMA_VERSION,
  assertRunTransition,
  assertTaskTransition,
  canTransitionToolCall,
  mergeToolPolicy,
  type ApprovalDecision,
  type AgentDefinition,
  type AgentHandoff,
  type AgentInstance,
  type AgentProfile,
  type AgentRun,
  type AgentThread,
  type AssignmentStatus,
  type Artifact,
  type ContextRevision,
  type ContextRevisionUse,
  type CreateAgentDefinitionInput,
  type CreateAgentInstanceInput,
  type CreateAgentProfileInput,
  type CreateArtifactInput,
  type CreateHandoffInput,
  type CreateInboxItemInput,
  type CreateProjectInput,
  type CreateScheduleInput,
  type CreateTaskAssignmentInput,
  type CreateTaskInput,
  type CreateThreadInput,
  type CreateWorkspaceInput,
  type Id,
  type InboxItem,
  type Project,
  type ProviderProfile,
  type ProviderProfileInput,
  type RuntimeCapabilities,
  type RuntimeNode,
  type RemoteRunBinding,
  type RunConfigSnapshot,
  type RunEvent,
  type RunRequestManifest,
  type RunStatus,
  type RunUsageRecord,
  type TaskAssignment,
  type TaskStatus,
  type ThreadMessage,
  type ToolApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type UpdateThreadSettingsInput,
  type Workspace,
  type WorkspaceSchedule,
  type WorkspaceSnapshot,
  type WorkspaceTask,
} from "@scopeguard/domain";

type UnknownRow = Record<string, unknown>;
const MAX_RUN_PARTIAL_CHARACTERS = 1_000_000;
const LOCAL_RUNTIME_NODE_ID = "local-runtime";
const LOCAL_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  nativeAgents: true,
  cliAgents: true,
  fileTools: true,
  commandTools: true,
  persistentRuns: false,
};

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
    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      if (databasePath !== ":memory:") {
        this.#database.exec("PRAGMA journal_mode = WAL");
      }
      this.#migrate();
      if (this.#databasePath) {
        secureDatabaseFiles(this.#databasePath);
      }
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // Preserve the initialization error that made this store unusable.
      }
      throw error;
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
      workspaces: this.listWorkspaces(),
      runtimeNodes: this.listRuntimeNodes(),
      agentDefinitions: this.listAgentDefinitions(),
      agentInstances: this.listAgentInstances(),
      tasks: this.listTasks(),
      assignments: this.listTaskAssignments(),
      artifacts: this.listArtifacts(),
      handoffs: this.listHandoffs(),
      schedules: this.listSchedules(),
      inboxItems: this.listInboxItems(),
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

  listWorkspaces(): Workspace[] {
    return this.#all(
      "SELECT * FROM workspaces ORDER BY last_opened_at DESC",
    ).map(mapWorkspace);
  }

  getWorkspace(workspaceId: Id): Workspace | null {
    const row = this.#get("SELECT * FROM workspaces WHERE id = ?", workspaceId);
    return row ? mapWorkspace(row) : null;
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const now = new Date().toISOString();
    const localRootPath = input.localRootPath?.trim() || null;
    if (localRootPath) {
      const existing = this.#get(
        "SELECT * FROM workspaces WHERE local_root_path = ?",
        localRootPath,
      );
      if (existing) {
        this.#run(
          "UPDATE workspaces SET last_opened_at = ?, updated_at = ? WHERE id = ?",
          now,
          now,
          asString(existing.id),
        );
        const workspace = mapWorkspace({
          ...existing,
          last_opened_at: now,
          updated_at: now,
        });
        this.#ensureLegacyProjectForWorkspace(workspace);
        return workspace;
      }
    }
    const workspace: Workspace = {
      id: randomUUID(),
      name: input.name.trim(),
      localRootPath,
      currentContextRevisionId: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };
    this.#insertWorkspace(workspace);
    this.#ensureLegacyProjectForWorkspace(workspace);
    return workspace;
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

    this.#insertWorkspace({
      id: project.id,
      name: project.name,
      localRootPath: project.rootPath,
      currentContextRevisionId: project.currentContextRevisionId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
    });

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

  listRuntimeNodes(): RuntimeNode[] {
    return this.#all(
      "SELECT * FROM runtime_nodes ORDER BY kind, name COLLATE NOCASE",
    ).map(mapRuntimeNode);
  }

  getRuntimeNode(runtimeNodeId: Id): RuntimeNode | null {
    const row = this.#get("SELECT * FROM runtime_nodes WHERE id = ?", runtimeNodeId);
    return row ? mapRuntimeNode(row) : null;
  }

  getRuntimeCredentialRef(runtimeNodeId: Id): string | null {
    const row = this.#get(
      "SELECT credential_ref FROM runtime_nodes WHERE id = ?",
      runtimeNodeId,
    );
    return row ? asNullableString(row.credential_ref) : null;
  }

  saveRuntimeNode(input: {
    id?: Id;
    name: string;
    kind: RuntimeNode["kind"];
    baseUrl: string | null;
    credentialRef: string | null;
    status?: RuntimeNode["status"];
    capabilities?: RuntimeCapabilities;
    lastSeenAt?: string | null;
  }): RuntimeNode {
    const existing = input.id ? this.getRuntimeNode(input.id) : null;
    const now = new Date().toISOString();
    const node: RuntimeNode = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name.trim(),
      kind: input.kind,
      baseUrl: input.baseUrl,
      hasCredential: Boolean(input.credentialRef),
      status: input.status ?? existing?.status ?? "unknown",
      capabilities: input.capabilities ?? existing?.capabilities ?? {
        nativeAgents: true,
        cliAgents: false,
        fileTools: false,
        commandTools: false,
        persistentRuns: input.kind === "remote",
      },
      lastSeenAt: input.lastSeenAt ?? existing?.lastSeenAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO runtime_nodes (
        id, name, kind, base_url, credential_ref, status,
        capabilities_json, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        base_url = excluded.base_url,
        credential_ref = excluded.credential_ref,
        status = excluded.status,
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
      node.id,
      node.name,
      node.kind,
      node.baseUrl,
      input.credentialRef,
      node.status,
      JSON.stringify(node.capabilities),
      node.lastSeenAt,
      node.createdAt,
      node.updatedAt,
    );
    return node;
  }

  listAgentDefinitions(): AgentDefinition[] {
    return this.#all(
      "SELECT * FROM agent_definitions ORDER BY name COLLATE NOCASE",
    ).map(mapAgentDefinition);
  }

  getAgentDefinition(agentDefinitionId: Id): AgentDefinition | null {
    const row = this.#get(
      "SELECT * FROM agent_definitions WHERE id = ?",
      agentDefinitionId,
    );
    return row ? mapAgentDefinition(row) : null;
  }

  createAgentDefinition(input: CreateAgentDefinitionInput): AgentDefinition {
    const now = new Date().toISOString();
    const definition: AgentDefinition = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions.trim(),
      providerProfileId: input.providerProfileId ?? null,
      modelOverride: input.modelOverride?.trim() || null,
      toolPolicy: mergeToolPolicy(input.toolPolicy),
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO agent_definitions (
        id, name, description, instructions, provider_profile_id,
        model_override, tool_policy_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      definition.id,
      definition.name,
      definition.description,
      definition.instructions,
      definition.providerProfileId,
      definition.modelOverride,
      JSON.stringify(definition.toolPolicy),
      definition.createdAt,
      definition.updatedAt,
    );
    return definition;
  }

  listAgentInstances(workspaceId?: Id): AgentInstance[] {
    const rows = workspaceId
      ? this.#all(
          `SELECT * FROM agent_instances
           WHERE workspace_id = ? ORDER BY created_at`,
          workspaceId,
        )
      : this.#all("SELECT * FROM agent_instances ORDER BY created_at");
    return rows.map(mapAgentInstance);
  }

  getAgentInstance(agentInstanceId: Id): AgentInstance | null {
    const row = this.#get(
      "SELECT * FROM agent_instances WHERE id = ?",
      agentInstanceId,
    );
    return row ? mapAgentInstance(row) : null;
  }

  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance {
    const now = new Date().toISOString();
    const instance: AgentInstance = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentDefinitionId: input.agentDefinitionId,
      runtimeNodeId: input.runtimeNodeId,
      nameOverride: input.nameOverride?.trim() || null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO agent_instances (
        id, workspace_id, agent_definition_id, runtime_node_id,
        name_override, status, legacy_agent_profile_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      instance.id,
      instance.workspaceId,
      instance.agentDefinitionId,
      instance.runtimeNodeId,
      instance.nameOverride,
      instance.status,
      instance.createdAt,
      instance.updatedAt,
    );
    return instance;
  }

  updateAgentInstanceRuntime(
    agentInstanceId: Id,
    runtimeNodeId: Id,
  ): AgentInstance {
    const current = this.getAgentInstance(agentInstanceId);
    if (!current) {
      throw new Error(`Agent instance not found: ${agentInstanceId}`);
    }
    const now = new Date().toISOString();
    this.#run(
      `UPDATE agent_instances
       SET runtime_node_id = ?, status = 'idle', updated_at = ?
       WHERE id = ?`,
      runtimeNodeId,
      now,
      agentInstanceId,
    );
    return {
      ...current,
      runtimeNodeId,
      status: "idle",
      updatedAt: now,
    };
  }

  listTasks(workspaceId?: Id): WorkspaceTask[] {
    const rows = workspaceId
      ? this.#all(
          `SELECT * FROM workspace_tasks
           WHERE workspace_id = ? ORDER BY updated_at DESC`,
          workspaceId,
        )
      : this.#all("SELECT * FROM workspace_tasks ORDER BY updated_at DESC");
    return rows.map(mapWorkspaceTask);
  }

  getTask(taskId: Id): WorkspaceTask | null {
    const row = this.#get("SELECT * FROM workspace_tasks WHERE id = ?", taskId);
    return row ? mapWorkspaceTask(row) : null;
  }

  createTask(input: CreateTaskInput): WorkspaceTask {
    const now = new Date().toISOString();
    const task: WorkspaceTask = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      status: "draft",
      priority: input.priority ?? "normal",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.#run(
      `INSERT INTO workspace_tasks (
        id, workspace_id, title, description, status, priority,
        legacy_thread_id, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      task.id,
      task.workspaceId,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.createdAt,
      task.updatedAt,
      task.completedAt,
    );
    return task;
  }

  updateTaskStatus(taskId: Id, status: TaskStatus): WorkspaceTask {
    const current = this.getTask(taskId);
    if (!current) {
      throw new Error(`Task not found: ${taskId}`);
    }
    assertTaskTransition(current.status, status);
    const now = new Date().toISOString();
    const completedAt = status === "completed" ? now : current.completedAt;
    this.#run(
      `UPDATE workspace_tasks
       SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      status,
      now,
      completedAt,
      taskId,
    );
    return { ...current, status, updatedAt: now, completedAt };
  }

  listTaskAssignments(taskId?: Id): TaskAssignment[] {
    const rows = taskId
      ? this.#all(
          `SELECT * FROM task_assignments
           WHERE task_id = ? ORDER BY position, created_at`,
          taskId,
        )
      : this.#all(
          "SELECT * FROM task_assignments ORDER BY task_id, position, created_at",
        );
    return rows.map(mapTaskAssignment);
  }

  createTaskAssignment(input: CreateTaskAssignmentInput): TaskAssignment {
    const now = new Date().toISOString();
    const assignment: TaskAssignment = {
      id: randomUUID(),
      taskId: input.taskId,
      agentInstanceId: input.agentInstanceId,
      threadId: input.threadId ?? null,
      role: input.role?.trim() ?? "",
      position: input.position ?? 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO task_assignments (
        id, task_id, agent_instance_id, thread_id, role, position,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assignment.id,
      assignment.taskId,
      assignment.agentInstanceId,
      assignment.threadId,
      assignment.role,
      assignment.position,
      assignment.status,
      assignment.createdAt,
      assignment.updatedAt,
    );
    return assignment;
  }

  updateTaskAssignmentStatus(
    assignmentId: Id,
    status: AssignmentStatus,
  ): TaskAssignment {
    const row = this.#get(
      "SELECT * FROM task_assignments WHERE id = ?",
      assignmentId,
    );
    if (!row) {
      throw new Error(`Task assignment not found: ${assignmentId}`);
    }
    const current = mapTaskAssignment(row);
    const updatedAt = new Date().toISOString();
    this.#run(
      `UPDATE task_assignments SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      updatedAt,
      assignmentId,
    );
    return { ...current, status, updatedAt };
  }

  listArtifacts(workspaceId?: Id): Artifact[] {
    const rows = workspaceId
      ? this.#all(
          `SELECT * FROM artifacts
           WHERE workspace_id = ? ORDER BY created_at DESC`,
          workspaceId,
        )
      : this.#all("SELECT * FROM artifacts ORDER BY created_at DESC");
    return rows.map(mapArtifact);
  }

  createArtifact(input: CreateArtifactInput): Artifact {
    const row = this.#get(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM artifacts WHERE task_id = ? AND title = ?`,
      input.taskId,
      input.title.trim(),
    );
    const artifact: Artifact = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      assignmentId: input.assignmentId ?? null,
      runId: input.runId ?? null,
      agentInstanceId: input.agentInstanceId,
      kind: input.kind,
      title: input.title.trim(),
      mimeType: input.mimeType.trim(),
      content: input.content ?? null,
      filePath: input.filePath ?? null,
      version: asNumber(row?.next_version ?? 1),
      createdAt: new Date().toISOString(),
    };
    this.#run(
      `INSERT INTO artifacts (
        id, workspace_id, task_id, assignment_id, run_id,
        agent_instance_id, kind, title, mime_type, content, file_path,
        version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      artifact.id,
      artifact.workspaceId,
      artifact.taskId,
      artifact.assignmentId,
      artifact.runId,
      artifact.agentInstanceId,
      artifact.kind,
      artifact.title,
      artifact.mimeType,
      artifact.content,
      artifact.filePath,
      artifact.version,
      artifact.createdAt,
    );
    return artifact;
  }

  listHandoffs(workspaceId?: Id): AgentHandoff[] {
    const rows = workspaceId
      ? this.#all(
          `SELECT * FROM agent_handoffs
           WHERE workspace_id = ? ORDER BY created_at DESC`,
          workspaceId,
        )
      : this.#all("SELECT * FROM agent_handoffs ORDER BY created_at DESC");
    return rows.map(mapAgentHandoff);
  }

  createHandoff(input: CreateHandoffInput): AgentHandoff {
    const handoff: AgentHandoff = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      fromAgentInstanceId: input.fromAgentInstanceId,
      toAgentInstanceId: input.toAgentInstanceId,
      sourceRunId: input.sourceRunId ?? null,
      contextRevisionId: input.contextRevisionId,
      summary: input.summary.trim(),
      status: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.#run(
      `INSERT INTO agent_handoffs (
        id, workspace_id, task_id, from_agent_instance_id,
        to_agent_instance_id, source_run_id, context_revision_id,
        summary, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      handoff.id,
      handoff.workspaceId,
      handoff.taskId,
      handoff.fromAgentInstanceId,
      handoff.toAgentInstanceId,
      handoff.sourceRunId,
      handoff.contextRevisionId,
      handoff.summary,
      handoff.status,
      handoff.createdAt,
      handoff.resolvedAt,
    );
    return handoff;
  }

  resolveHandoff(
    handoffId: Id,
    status: "accepted" | "rejected",
  ): AgentHandoff {
    const current = this.#get(
      "SELECT * FROM agent_handoffs WHERE id = ?",
      handoffId,
    );
    if (!current) {
      throw new Error(`Handoff not found: ${handoffId}`);
    }
    const handoff = mapAgentHandoff(current);
    if (handoff.status !== "pending") {
      if (handoff.status === status) {
        return handoff;
      }
      throw new Error(`Handoff is already ${handoff.status}.`);
    }
    const resolvedAt = new Date().toISOString();
    this.#run(
      `UPDATE agent_handoffs SET status = ?, resolved_at = ? WHERE id = ?`,
      status,
      resolvedAt,
      handoff.id,
    );
    return { ...handoff, status, resolvedAt };
  }

  listSchedules(workspaceId?: Id): WorkspaceSchedule[] {
    const rows = workspaceId
      ? this.#all(
          `SELECT * FROM workspace_schedules
           WHERE workspace_id = ? ORDER BY created_at`,
          workspaceId,
        )
      : this.#all("SELECT * FROM workspace_schedules ORDER BY created_at");
    return rows.map(mapWorkspaceSchedule);
  }

  createSchedule(input: CreateScheduleInput): WorkspaceSchedule {
    const now = new Date().toISOString();
    const schedule: WorkspaceSchedule = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentInstanceId: input.agentInstanceId,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      cronExpression: input.cronExpression.trim(),
      timeZone: input.timeZone.trim(),
      enabled: input.enabled ?? true,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#run(
      `INSERT INTO workspace_schedules (
        id, workspace_id, agent_instance_id, title, prompt,
        cron_expression, time_zone, enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      schedule.id,
      schedule.workspaceId,
      schedule.agentInstanceId,
      schedule.title,
      schedule.prompt,
      schedule.cronExpression,
      schedule.timeZone,
      schedule.enabled ? 1 : 0,
      schedule.nextRunAt,
      schedule.createdAt,
      schedule.updatedAt,
    );
    return schedule;
  }

  listInboxItems(workspaceId?: Id): InboxItem[] {
    const rows = workspaceId
      ? this.#all(
          `SELECT * FROM inbox_items
           WHERE workspace_id = ? ORDER BY created_at DESC`,
          workspaceId,
        )
      : this.#all("SELECT * FROM inbox_items ORDER BY created_at DESC");
    return rows.map(mapInboxItem);
  }

  createInboxItem(input: CreateInboxItemInput): InboxItem {
    const item: InboxItem = {
      ...input,
      id: randomUUID(),
      status: "unread",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.#run(
      `INSERT INTO inbox_items (
        id, workspace_id, kind, status, title, summary, task_id,
        assignment_id, run_id, approval_id, agent_instance_id,
        created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id,
      item.workspaceId,
      item.kind,
      item.status,
      item.title,
      item.summary,
      item.taskId,
      item.assignmentId,
      item.runId,
      item.approvalId,
      item.agentInstanceId,
      item.createdAt,
      item.resolvedAt,
    );
    return item;
  }

  resolveInboxItem(inboxItemId: Id): InboxItem {
    const row = this.#get("SELECT * FROM inbox_items WHERE id = ?", inboxItemId);
    if (!row) {
      throw new Error(`Inbox item not found: ${inboxItemId}`);
    }
    const current = mapInboxItem(row);
    if (current.status === "resolved") {
      return current;
    }
    const resolvedAt = new Date().toISOString();
    this.#run(
      `UPDATE inbox_items SET status = 'resolved', resolved_at = ? WHERE id = ?`,
      resolvedAt,
      inboxItemId,
    );
    return { ...current, status: "resolved", resolvedAt };
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

  createAgentProfile(
    input: CreateAgentProfileInput,
    options: { mirrorLegacyControlPlane?: boolean } = {},
  ): AgentProfile {
    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: randomUUID(),
      projectId: input.projectId,
      name: input.name.trim(),
      runtimeKind: input.runtimeKind ?? "native",
      instructions: input.instructions.trim(),
      providerProfileId: input.providerProfileId ?? null,
      modelOverride: input.modelOverride?.trim() || null,
      executionProfile: input.executionProfile ?? (
        input.runtimeKind === "local-cli" ? "full-access" : "request-approval"
      ),
      toolPolicy: mergeToolPolicy(input.toolPolicy),
      cliConfig: input.cliConfig ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.#run(
      `INSERT INTO agent_profiles (
        id, project_id, name, runtime_kind, instructions, provider_profile_id,
        model_override, execution_profile, tool_policy_json, cli_config_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      profile.id,
      profile.projectId,
      profile.name,
      profile.runtimeKind,
      profile.instructions,
      profile.providerProfileId,
      profile.modelOverride,
      profile.executionProfile,
      JSON.stringify(profile.toolPolicy),
      profile.cliConfig ? JSON.stringify(profile.cliConfig) : null,
      profile.createdAt,
      profile.updatedAt,
    );

    if (options.mirrorLegacyControlPlane !== false) {
      this.#run(
        `INSERT OR IGNORE INTO agent_definitions (
          id, name, description, instructions, provider_profile_id,
          model_override, tool_policy_json, created_at, updated_at
        ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`,
        profile.id,
        profile.name,
        profile.instructions,
        profile.providerProfileId,
        profile.modelOverride,
        JSON.stringify(profile.toolPolicy),
        profile.createdAt,
        profile.updatedAt,
      );
      const existingInstance = this.#get(
        "SELECT id FROM agent_instances WHERE legacy_agent_profile_id = ?",
        profile.id,
      );
      if (!existingInstance) {
        this.#run(
          `INSERT INTO agent_instances (
            id, workspace_id, agent_definition_id, runtime_node_id,
            name_override, status, legacy_agent_profile_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`,
          randomUUID(),
          profile.projectId,
          profile.id,
          input.runtimeNodeId ?? LOCAL_RUNTIME_NODE_ID,
          profile.id,
          profile.createdAt,
          profile.updatedAt,
        );
      }
    }

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

  createThread(
    input: CreateThreadInput,
    options: { mirrorLegacyControlPlane?: boolean } = {},
  ): AgentThread {
    const now = new Date().toISOString();
    const profile = this.getAgentProfile(input.agentProfileId);
    if (!profile) {
      throw new Error("Agent Profile not found.");
    }
    const thread: AgentThread = {
      id: randomUUID(),
      projectId: input.projectId,
      agentProfileId: input.agentProfileId,
      title: input.title?.trim() || "New conversation",
      status: "active",
      modelOverride: profile.modelOverride,
      executionProfile: profile.executionProfile,
      createdAt: now,
      updatedAt: now,
    };

    this.#run(
      `INSERT INTO agent_threads (
        id, project_id, agent_profile_id, title, status, model_override,
        execution_profile, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      thread.id,
      thread.projectId,
      thread.agentProfileId,
      thread.title,
      thread.status,
      thread.modelOverride,
      thread.executionProfile,
      thread.createdAt,
      thread.updatedAt,
    );

    if (options.mirrorLegacyControlPlane !== false) {
      this.#run(
        `INSERT OR IGNORE INTO workspace_tasks (
          id, workspace_id, title, description, status, priority,
          legacy_thread_id, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, '', 'ready', 'normal', ?, ?, ?, NULL)`,
        thread.id,
        thread.projectId,
        thread.title,
        thread.id,
        thread.createdAt,
        thread.updatedAt,
      );
      const instance = this.#get(
        `SELECT id FROM agent_instances
         WHERE legacy_agent_profile_id = ?`,
        thread.agentProfileId,
      );
      const existingAssignment = this.#get(
        "SELECT id FROM task_assignments WHERE thread_id = ?",
        thread.id,
      );
      if (instance && !existingAssignment) {
        this.#run(
          `INSERT INTO task_assignments (
            id, task_id, agent_instance_id, thread_id, role, position,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, '', 0, 'pending', ?, ?)`,
          randomUUID(),
          thread.id,
          asString(instance.id),
          thread.id,
          thread.createdAt,
          thread.updatedAt,
        );
      }
    }

    return thread;
  }

  updateThreadSettings(input: UpdateThreadSettingsInput): AgentThread {
    const current = this.getThread(input.threadId);
    if (!current) {
      throw new Error("Thread not found.");
    }
    const updated: AgentThread = {
      ...current,
      modelOverride: input.modelOverride === undefined
        ? current.modelOverride
        : input.modelOverride,
      executionProfile: input.executionProfile ?? current.executionProfile,
      updatedAt: new Date().toISOString(),
    };
    this.#run(
      `UPDATE agent_threads
       SET model_override = ?, execution_profile = ?, updated_at = ?
       WHERE id = ?`,
      updated.modelOverride,
      updated.executionProfile,
      updated.updatedAt,
      updated.id,
    );
    return updated;
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

  getRunPartial(runId: Id): string | null {
    const row = this.#get(
      "SELECT content FROM run_partials WHERE run_id = ?",
      runId,
    );
    return row ? asString(row.content) : null;
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
    if (run.contextRevisionId) {
      this.#run(
        `INSERT INTO context_revision_uses (
          context_revision_id, run_id, used_at
        ) VALUES (?, ?, ?)`,
        run.contextRevisionId,
        run.id,
        run.createdAt,
      );
    }
    return run;
  }

  getRun(runId: Id): AgentRun | null {
    const row = this.#get("SELECT * FROM agent_runs WHERE id = ?", runId);
    return row ? mapAgentRun(row) : null;
  }

  recordRunRequestManifest(
    input: Omit<RunRequestManifest, "createdAt">,
  ): RunRequestManifest {
    const manifest: RunRequestManifest = {
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.#run(
      `INSERT INTO run_request_manifests (
        run_id, step_sequence, provider_protocol, model, messages_json,
        tools_json, max_output_tokens, request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      manifest.runId,
      manifest.stepSequence,
      manifest.providerProtocol,
      manifest.model,
      JSON.stringify(manifest.messages),
      JSON.stringify(manifest.tools),
      manifest.maxOutputTokens,
      manifest.requestHash,
      manifest.createdAt,
    );
    return manifest;
  }

  listRunRequestManifests(runId: Id): RunRequestManifest[] {
    return this.#all(
      `SELECT * FROM run_request_manifests
       WHERE run_id = ? ORDER BY step_sequence`,
      runId,
    ).map(mapRunRequestManifest);
  }

  appendRunUsageRecord(
    input: Omit<RunUsageRecord, "sequence" | "receivedAt">,
  ): RunUsageRecord {
    return this.#transaction(() => {
      const row = this.#get(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM run_usage_records WHERE run_id = ?`,
        input.runId,
      );
      const record: RunUsageRecord = {
        ...input,
        sequence: asNumber(row?.next_sequence ?? 1),
        receivedAt: new Date().toISOString(),
      };
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
      `SELECT * FROM run_usage_records
       WHERE run_id = ? ORDER BY sequence`,
      runId,
    ).map(mapRunUsageRecord);
  }

  listActiveRuns(): AgentRun[] {
    return this.#all(
      `SELECT * FROM agent_runs
       WHERE status IN (
         'queued', 'preparing', 'running', 'waiting-approval', 'waiting-input',
         'cancelling'
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
           'queued', 'preparing', 'running', 'waiting-approval', 'waiting-input',
           'cancelling'
         ) AND id NOT IN (SELECT run_id FROM remote_run_bindings)`,
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
             'queued', 'preparing', 'running', 'waiting-approval', 'waiting-input',
             'cancelling'
           ) AND id NOT IN (SELECT run_id FROM remote_run_bindings)`,
        )
        .run(new Date().toISOString());
      this.#run(
        `DELETE FROM run_partials
         WHERE run_id NOT IN (SELECT run_id FROM remote_run_bindings)`,
      );
      return Number(result.changes);
    });
  }

  createRemoteRunBinding(input: {
    runId: Id;
    runtimeNodeId: Id;
    remoteRunId: Id;
  }): RemoteRunBinding {
    const now = new Date().toISOString();
    this.#run(
      `INSERT INTO remote_run_bindings (
        run_id, runtime_node_id, remote_run_id, last_sequence,
        result_imported_at, created_at, updated_at
      ) VALUES (?, ?, ?, 0, NULL, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        runtime_node_id = excluded.runtime_node_id,
        remote_run_id = excluded.remote_run_id,
        updated_at = excluded.updated_at`,
      input.runId,
      input.runtimeNodeId,
      input.remoteRunId,
      now,
      now,
    );
    return this.requireRemoteRunBinding(input.runId);
  }

  getRemoteRunBinding(runId: Id): RemoteRunBinding | null {
    const row = this.#get(
      "SELECT * FROM remote_run_bindings WHERE run_id = ?",
      runId,
    );
    return row ? mapRemoteRunBinding(row) : null;
  }

  listActiveRemoteRunBindings(): RemoteRunBinding[] {
    return this.#all(
      `SELECT binding.* FROM remote_run_bindings binding
       INNER JOIN agent_runs run ON run.id = binding.run_id
       WHERE run.status IN (
         'queued', 'preparing', 'running', 'waiting-approval', 'waiting-input',
         'cancelling'
       ) ORDER BY binding.created_at`,
    ).map(mapRemoteRunBinding);
  }

  updateRemoteRunCursor(runId: Id, lastSequence: number): RemoteRunBinding {
    this.#run(
      `UPDATE remote_run_bindings
       SET last_sequence = MAX(last_sequence, ?), updated_at = ?
       WHERE run_id = ?`,
      lastSequence,
      new Date().toISOString(),
      runId,
    );
    return this.requireRemoteRunBinding(runId);
  }

  markRemoteRunResultImported(runId: Id): RemoteRunBinding {
    const now = new Date().toISOString();
    this.#run(
      `UPDATE remote_run_bindings
       SET result_imported_at = COALESCE(result_imported_at, ?), updated_at = ?
       WHERE run_id = ?`,
      now,
      now,
      runId,
    );
    return this.requireRemoteRunBinding(runId);
  }

  requireRemoteRunBinding(runId: Id): RemoteRunBinding {
    const binding = this.getRemoteRunBinding(runId);
    if (!binding) {
      throw new Error(`Remote Run binding not found: ${runId}`);
    }
    return binding;
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

  listRunEvents(runId: Id): RunEvent[] {
    return this.#all(
      `SELECT payload_json FROM run_events
       WHERE run_id = ? ORDER BY sequence ASC`,
      runId,
    ).map((row) => JSON.parse(asString(row.payload_json)) as RunEvent);
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
    if (current.status === status || isTerminalToolCallStatus(current.status)) {
      return current;
    }
    if (!canTransitionToolCall(current.status, status)) {
      throw new Error(
        `Invalid tool call status transition: ${current.status} -> ${status}`,
      );
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

  recoverUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[] {
    return this.#transaction(() => {
      const recoverableIds = this.listToolCallsForRun(runId)
        .filter((toolCall) =>
          toolCall.status === "proposed" ||
          toolCall.status === "awaiting-approval" ||
          toolCall.status === "running"
        )
        .map((toolCall) => toolCall.id);
      const completedAt = new Date().toISOString();
      this.#run(
        `UPDATE tool_calls
         SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
         WHERE run_id = ?
           AND status IN ('proposed', 'awaiting-approval')`,
        completedAt,
        runId,
      );
      this.#run(
        `UPDATE tool_calls
         SET status = 'effect_unknown',
             error = COALESCE(
               error,
               'Tool execution effect is unknown after an unclean shutdown.'
             ),
             completed_at = COALESCE(completed_at, ?)
         WHERE run_id = ?
           AND status = 'running'`,
        completedAt,
        runId,
      );
      return recoverableIds.flatMap((toolCallId) => {
        const toolCall = this.getToolCall(toolCallId);
        return toolCall ? [toolCall] : [];
      });
    });
  }

  getProjectContext(projectId: Id): ContextRevision | null {
    return this.getWorkspaceContext(projectId);
  }

  getWorkspaceContext(workspaceId: Id): ContextRevision | null {
    const row = this.#get(
      `SELECT * FROM context_revisions
       WHERE workspace_id = ? AND scope = 'workspace'
       ORDER BY version DESC
       LIMIT 1`,
      workspaceId,
    );
    return row ? mapContextRevision(row) : null;
  }

  getContextRevision(contextRevisionId: Id): ContextRevision | null {
    const row = this.#get(
      "SELECT * FROM context_revisions WHERE id = ?",
      contextRevisionId,
    );
    return row ? mapContextRevision(row) : null;
  }

  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId: Id | null = null,
    sourceRunId: Id | null = null,
  ): ContextRevision {
    return this.updateWorkspaceContext({
      workspaceId: projectId,
      content,
      sourceThreadId,
      sourceRunId,
      publishedBy: "user",
    });
  }

  updateWorkspaceContext(input: {
    workspaceId: Id;
    content: string;
    title?: string;
    scope?: ContextRevision["scope"];
    taskId?: Id | null;
    sourceThreadId?: Id | null;
    sourceRunId?: Id | null;
    sourceAgentInstanceId?: Id | null;
    sourceArtifactId?: Id | null;
    publishedBy: ContextRevision["publishedBy"];
  }): ContextRevision {
    return this.#transaction(() => {
      const scope = input.scope ?? "workspace";
      const taskId = input.taskId ?? null;
      const parentRow = this.#get(
        `SELECT * FROM context_revisions
         WHERE workspace_id = ? AND scope = ?
           AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)
         ORDER BY version DESC LIMIT 1`,
        input.workspaceId,
        scope,
        taskId,
        taskId,
      );
      const parent = parentRow ? mapContextRevision(parentRow) : null;
      const row = this.#get(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM context_revisions
         WHERE workspace_id = ? AND scope = ?
           AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)`,
        input.workspaceId,
        scope,
        taskId,
        taskId,
      );
      const version: ContextRevision = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: input.workspaceId,
        version: asNumber(row?.next_version ?? 1),
        parentId: parent?.id ?? null,
        scope,
        taskId,
        title: input.title?.trim() || `Context v${asNumber(row?.next_version ?? 1)}`,
        content: input.content,
        sourceThreadId: input.sourceThreadId ?? null,
        sourceRunId: input.sourceRunId ?? null,
        sourceAgentInstanceId: input.sourceAgentInstanceId ?? null,
        sourceArtifactId: input.sourceArtifactId ?? null,
        publishedBy: input.publishedBy,
        createdAt: new Date().toISOString(),
      };
      this.#run(
        `INSERT INTO context_revisions (
          id, workspace_id, version, parent_id, scope, task_id, title,
          content, source_thread_id, source_run_id,
          source_agent_instance_id, source_artifact_id, published_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        version.id,
        version.workspaceId,
        version.version,
        version.parentId,
        version.scope,
        version.taskId,
        version.title,
        version.content,
        version.sourceThreadId,
        version.sourceRunId,
        version.sourceAgentInstanceId,
        version.sourceArtifactId,
        version.publishedBy,
        version.createdAt,
      );
      this.#run(
        `UPDATE workspaces
         SET current_context_revision_id = ?, updated_at = ?
         WHERE id = ?`,
        version.id,
        version.createdAt,
        input.workspaceId,
      );
      this.#run(
        `UPDATE projects
         SET current_context_revision_id = ?, updated_at = ?
         WHERE id = ?`,
        version.id,
        version.createdAt,
        input.workspaceId,
      );
      return version;
    });
  }

  listContextRevisionUses(contextRevisionId: Id): ContextRevisionUse[] {
    return this.#all(
      `SELECT * FROM context_revision_uses
       WHERE context_revision_id = ? ORDER BY used_at`,
      contextRevisionId,
    ).map(mapContextRevisionUse);
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
          'queued', 'preparing', 'running', 'waiting-approval', 'waiting-input',
          'cancelling'
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
      currentVersion = 3;
    }

    if (currentVersion < 4) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            local_root_path TEXT UNIQUE,
            current_context_revision_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_opened_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS runtime_nodes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            base_url TEXT,
            credential_ref TEXT,
            status TEXT NOT NULL,
            capabilities_json TEXT NOT NULL,
            last_seen_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS agent_definitions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            instructions TEXT NOT NULL,
            provider_profile_id TEXT REFERENCES provider_profiles(id),
            model_override TEXT,
            tool_policy_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS agent_instances (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
            runtime_node_id TEXT NOT NULL REFERENCES runtime_nodes(id),
            name_override TEXT,
            status TEXT NOT NULL,
            legacy_agent_profile_id TEXT UNIQUE REFERENCES agent_profiles(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS workspace_tasks (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL,
            priority TEXT NOT NULL,
            legacy_thread_id TEXT UNIQUE REFERENCES agent_threads(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
          );

          CREATE TABLE IF NOT EXISTS task_assignments (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
            agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
            thread_id TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
            role TEXT NOT NULL,
            position INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
            assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,
            run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
            agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            content TEXT,
            file_path TEXT,
            version INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(task_id, title, version)
          );

          CREATE TABLE IF NOT EXISTS context_revisions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            parent_id TEXT REFERENCES context_revisions(id),
            scope TEXT NOT NULL,
            task_id TEXT REFERENCES workspace_tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source_thread_id TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
            source_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
            source_agent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
            source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
            published_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(workspace_id, scope, task_id, version)
          );

          CREATE TABLE IF NOT EXISTS context_revision_uses (
            context_revision_id TEXT NOT NULL REFERENCES context_revisions(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            used_at TEXT NOT NULL,
            PRIMARY KEY(context_revision_id, run_id)
          );

          CREATE TABLE IF NOT EXISTS agent_handoffs (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
            from_agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
            to_agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
            source_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
            context_revision_id TEXT NOT NULL REFERENCES context_revisions(id),
            summary TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            resolved_at TEXT
          );

          CREATE TABLE IF NOT EXISTS workspace_schedules (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            cron_expression TEXT NOT NULL,
            time_zone TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            next_run_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS inbox_items (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            task_id TEXT REFERENCES workspace_tasks(id) ON DELETE CASCADE,
            assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,
            run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
            approval_id TEXT REFERENCES tool_approvals(id) ON DELETE SET NULL,
            agent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            resolved_at TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_instances_workspace
            ON agent_instances(workspace_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated
            ON workspace_tasks(workspace_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_assignments_task_position
            ON task_assignments(task_id, position, created_at);
          CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_created
            ON artifacts(workspace_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_context_workspace_scope_version
            ON context_revisions(workspace_id, scope, task_id, version DESC);
          CREATE INDEX IF NOT EXISTS idx_handoffs_workspace_created
            ON agent_handoffs(workspace_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_inbox_workspace_status_created
            ON inbox_items(workspace_id, status, created_at DESC);
        `);

        const now = new Date().toISOString();
        this.#run(
          `INSERT OR IGNORE INTO workspaces (
            id, name, local_root_path, current_context_revision_id,
            created_at, updated_at, last_opened_at
          )
          SELECT id, name, root_path, current_context_revision_id,
                 created_at, updated_at, last_opened_at
          FROM projects`,
        );
        this.#run(
          `INSERT OR IGNORE INTO runtime_nodes (
            id, name, kind, base_url, credential_ref, status,
            capabilities_json, last_seen_at, created_at, updated_at
          ) VALUES (?, ?, 'local', NULL, NULL, 'online', ?, ?, ?, ?)`,
          LOCAL_RUNTIME_NODE_ID,
          "This device",
          JSON.stringify(LOCAL_RUNTIME_CAPABILITIES),
          now,
          now,
          now,
        );
        this.#run(
          `INSERT OR IGNORE INTO agent_definitions (
            id, name, description, instructions, provider_profile_id,
            model_override, tool_policy_json, created_at, updated_at
          )
          SELECT id, name, '', instructions, provider_profile_id,
                 model_override, tool_policy_json, created_at, updated_at
          FROM agent_profiles`,
        );

        const legacyProfiles = this.#all(
          `SELECT id, project_id, name, created_at, updated_at
           FROM agent_profiles ORDER BY created_at`,
        );
        for (const row of legacyProfiles) {
          const profileId = asString(row.id);
          const existing = this.#get(
            "SELECT id FROM agent_instances WHERE legacy_agent_profile_id = ?",
            profileId,
          );
          if (existing) {
            continue;
          }
          this.#run(
            `INSERT INTO agent_instances (
              id, workspace_id, agent_definition_id, runtime_node_id,
              name_override, status, legacy_agent_profile_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`,
            randomUUID(),
            asString(row.project_id),
            profileId,
            LOCAL_RUNTIME_NODE_ID,
            profileId,
            asString(row.created_at),
            asString(row.updated_at),
          );
        }

        const legacyThreads = this.#all(
          `SELECT id, project_id, agent_profile_id, title, status,
                  created_at, updated_at
           FROM agent_threads ORDER BY created_at`,
        );
        for (const row of legacyThreads) {
          const threadId = asString(row.id);
          this.#run(
            `INSERT OR IGNORE INTO workspace_tasks (
              id, workspace_id, title, description, status, priority,
              legacy_thread_id, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, '', ?, 'normal', ?, ?, ?, NULL)`,
            threadId,
            asString(row.project_id),
            asString(row.title),
            asString(row.status) === "archived" ? "archived" : "ready",
            threadId,
            asString(row.created_at),
            asString(row.updated_at),
          );
          const instance = this.#get(
            `SELECT id FROM agent_instances
             WHERE legacy_agent_profile_id = ?`,
            asString(row.agent_profile_id),
          );
          const existingAssignment = this.#get(
            "SELECT id FROM task_assignments WHERE thread_id = ?",
            threadId,
          );
          if (instance && !existingAssignment) {
            this.#run(
              `INSERT INTO task_assignments (
                id, task_id, agent_instance_id, thread_id, role, position,
                status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, '', 0, 'pending', ?, ?)`,
              randomUUID(),
              threadId,
              asString(instance.id),
              threadId,
              asString(row.created_at),
              asString(row.updated_at),
            );
          }
        }

        this.#run(
          `INSERT OR IGNORE INTO context_revisions (
            id, workspace_id, version, parent_id, scope, task_id, title,
            content, source_thread_id, source_run_id,
            source_agent_instance_id, source_artifact_id,
            published_by, created_at
          )
          SELECT id, project_id, version, parent_id, 'workspace', NULL,
                 'Context v' || version, content, source_thread_id,
                 source_run_id, NULL, NULL, 'user', created_at
          FROM project_context_versions`,
        );
        this.#run(
          `INSERT OR IGNORE INTO context_revision_uses (
            context_revision_id, run_id, used_at
          )
          SELECT context_revision_id, id, created_at
          FROM agent_runs
          WHERE context_revision_id IS NOT NULL`,
        );
        this.#run(
          `UPDATE schema_metadata SET value = '4'
           WHERE key = 'schema_version'`,
        );
      });
      currentVersion = 4;
    }

    if (currentVersion < 5) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS remote_run_bindings (
            run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
            runtime_node_id TEXT NOT NULL REFERENCES runtime_nodes(id),
            remote_run_id TEXT NOT NULL UNIQUE,
            last_sequence INTEGER NOT NULL DEFAULT 0,
            result_imported_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_remote_bindings_runtime
            ON remote_run_bindings(runtime_node_id, updated_at DESC);
        `);
        this.#run(
          `UPDATE schema_metadata SET value = '5'
           WHERE key = 'schema_version'`,
        );
      });
      currentVersion = 5;
    }

    if (currentVersion < 6) {
      this.#transaction(() => {
        this.#database.exec(`
          DROP INDEX IF EXISTS idx_one_active_run_per_thread;
          CREATE UNIQUE INDEX idx_one_active_run_per_thread
            ON agent_runs(thread_id)
            WHERE status IN (
              'queued', 'preparing', 'running', 'waiting-approval',
              'waiting-input', 'cancelling'
            );
        `);
        this.#run(
          `UPDATE schema_metadata SET value = '6'
           WHERE key = 'schema_version'`,
        );
      });
      currentVersion = 6;
    }

    if (currentVersion < 7) {
      this.#transaction(() => {
        const profileColumns = this.#all("PRAGMA table_info(agent_profiles)");
        if (!profileColumns.some((column) => column.name === "execution_profile")) {
          this.#database.exec(
            `ALTER TABLE agent_profiles
             ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'request-approval'`,
          );
        }
        this.#run(
          `UPDATE agent_profiles
           SET execution_profile = 'full-access'
           WHERE runtime_kind = 'local-cli'`,
        );
        this.#run(
          `UPDATE schema_metadata SET value = '7'
           WHERE key = 'schema_version'`,
        );
      });
      currentVersion = 7;
    }

    if (currentVersion < 8) {
      this.#transaction(() => {
        const threadColumns = this.#all("PRAGMA table_info(agent_threads)");
        if (!threadColumns.some((column) => column.name === "model_override")) {
          this.#database.exec(
            `ALTER TABLE agent_threads ADD COLUMN model_override TEXT`,
          );
        }
        if (!threadColumns.some((column) => column.name === "execution_profile")) {
          this.#database.exec(
            `ALTER TABLE agent_threads
             ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'request-approval'`,
          );
        }
        this.#database.exec(
          `UPDATE agent_threads
           SET model_override = (
                 SELECT model_override FROM agent_profiles
                 WHERE agent_profiles.id = agent_threads.agent_profile_id
               ),
               execution_profile = COALESCE((
                 SELECT execution_profile FROM agent_profiles
                 WHERE agent_profiles.id = agent_threads.agent_profile_id
               ), 'request-approval')`,
        );
        this.#run(
          `UPDATE schema_metadata SET value = '8'
           WHERE key = 'schema_version'`,
        );
      });
      currentVersion = 8;
    }

    if (currentVersion < 9) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS run_request_manifests (
            run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            step_sequence INTEGER NOT NULL CHECK(step_sequence > 0),
            provider_protocol TEXT NOT NULL,
            model TEXT NOT NULL,
            messages_json TEXT NOT NULL,
            tools_json TEXT NOT NULL,
            max_output_tokens INTEGER CHECK(
              max_output_tokens IS NULL OR max_output_tokens >= 0
            ),
            request_hash TEXT NOT NULL CHECK(
              length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
            ),
            created_at TEXT NOT NULL,
            PRIMARY KEY(run_id, step_sequence)
          );

          CREATE TABLE IF NOT EXISTS run_usage_records (
            run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK(sequence > 0),
            step_sequence INTEGER NOT NULL CHECK(step_sequence > 0),
            source TEXT NOT NULL CHECK(source = 'provider'),
            status TEXT NOT NULL CHECK(status IN ('reported', 'unavailable')),
            input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
            output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
            received_at TEXT NOT NULL,
            PRIMARY KEY(run_id, sequence),
            FOREIGN KEY(run_id, step_sequence)
              REFERENCES run_request_manifests(run_id, step_sequence)
              ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_run_usage_step
            ON run_usage_records(run_id, step_sequence, sequence);
        `);
        this.#run(
          `UPDATE schema_metadata SET value = '9'
           WHERE key = 'schema_version'`,
        );
      });
    }
  }

  #insertWorkspace(workspace: Workspace): void {
    this.#run(
      `INSERT INTO workspaces (
        id, name, local_root_path, current_context_revision_id,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        local_root_path = excluded.local_root_path,
        current_context_revision_id = excluded.current_context_revision_id,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at`,
      workspace.id,
      workspace.name,
      workspace.localRootPath,
      workspace.currentContextRevisionId,
      workspace.createdAt,
      workspace.updatedAt,
      workspace.lastOpenedAt,
    );
  }

  #ensureLegacyProjectForWorkspace(workspace: Workspace): void {
    this.#run(
      `INSERT INTO projects (
        id, name, root_path, current_context_revision_id,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        current_context_revision_id = excluded.current_context_revision_id,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at`,
      workspace.id,
      workspace.name,
      workspace.localRootPath ?? `scopeguard://workspace/${workspace.id}`,
      workspace.currentContextRevisionId,
      workspace.createdAt,
      workspace.updatedAt,
      workspace.lastOpenedAt,
    );
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

function mapWorkspace(row: UnknownRow): Workspace {
  return {
    id: asString(row.id),
    name: asString(row.name),
    localRootPath: asNullableString(row.local_root_path),
    currentContextRevisionId: asNullableString(row.current_context_revision_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    lastOpenedAt: asString(row.last_opened_at),
  };
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

function mapRuntimeNode(row: UnknownRow): RuntimeNode {
  return {
    id: asString(row.id),
    name: asString(row.name),
    kind: asString(row.kind) as RuntimeNode["kind"],
    baseUrl: asNullableString(row.base_url),
    hasCredential: row.credential_ref !== null && row.credential_ref !== undefined,
    status: asString(row.status) as RuntimeNode["status"],
    capabilities: {
      nativeAgents: false,
      cliAgents: false,
      fileTools: false,
      commandTools: false,
      persistentRuns: false,
      ...parseJsonObject(row.capabilities_json),
    } as RuntimeCapabilities,
    lastSeenAt: asNullableString(row.last_seen_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapAgentDefinition(row: UnknownRow): AgentDefinition {
  return {
    id: asString(row.id),
    name: asString(row.name),
    description: asString(row.description),
    instructions: asString(row.instructions),
    providerProfileId: asNullableString(row.provider_profile_id),
    modelOverride: asNullableString(row.model_override),
    toolPolicy: {
      ...mergeToolPolicy(undefined),
      ...parseJsonObject(row.tool_policy_json),
    } as AgentDefinition["toolPolicy"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function parseExecutionProfile(
  value: unknown,
): AgentProfile["executionProfile"] {
  if (
    value === "request-approval" ||
    value === "auto-approve" ||
    value === "full-access"
  ) {
    return value;
  }
  return "request-approval";
}

function mapAgentInstance(row: UnknownRow): AgentInstance {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    agentDefinitionId: asString(row.agent_definition_id),
    runtimeNodeId: asString(row.runtime_node_id),
    nameOverride: asNullableString(row.name_override),
    status: asString(row.status) as AgentInstance["status"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapWorkspaceTask(row: UnknownRow): WorkspaceTask {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    title: asString(row.title),
    description: asString(row.description),
    status: asString(row.status) as WorkspaceTask["status"],
    priority: asString(row.priority) as WorkspaceTask["priority"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    completedAt: asNullableString(row.completed_at),
  };
}

function mapTaskAssignment(row: UnknownRow): TaskAssignment {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    agentInstanceId: asString(row.agent_instance_id),
    threadId: asNullableString(row.thread_id),
    role: asString(row.role),
    position: asNumber(row.position),
    status: asString(row.status) as TaskAssignment["status"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapArtifact(row: UnknownRow): Artifact {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    taskId: asString(row.task_id),
    assignmentId: asNullableString(row.assignment_id),
    runId: asNullableString(row.run_id),
    agentInstanceId: asString(row.agent_instance_id),
    kind: asString(row.kind) as Artifact["kind"],
    title: asString(row.title),
    mimeType: asString(row.mime_type),
    content: asNullableString(row.content),
    filePath: asNullableString(row.file_path),
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
  };
}

function mapAgentHandoff(row: UnknownRow): AgentHandoff {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    taskId: asString(row.task_id),
    fromAgentInstanceId: asString(row.from_agent_instance_id),
    toAgentInstanceId: asString(row.to_agent_instance_id),
    sourceRunId: asNullableString(row.source_run_id),
    contextRevisionId: asString(row.context_revision_id),
    summary: asString(row.summary),
    status: asString(row.status) as AgentHandoff["status"],
    createdAt: asString(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
  };
}

function mapWorkspaceSchedule(row: UnknownRow): WorkspaceSchedule {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    agentInstanceId: asString(row.agent_instance_id),
    title: asString(row.title),
    prompt: asString(row.prompt),
    cronExpression: asString(row.cron_expression),
    timeZone: asString(row.time_zone),
    enabled: asNumber(row.enabled) === 1,
    nextRunAt: asNullableString(row.next_run_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapInboxItem(row: UnknownRow): InboxItem {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    kind: asString(row.kind) as InboxItem["kind"],
    status: asString(row.status) as InboxItem["status"],
    title: asString(row.title),
    summary: asString(row.summary),
    taskId: asNullableString(row.task_id),
    assignmentId: asNullableString(row.assignment_id),
    runId: asNullableString(row.run_id),
    approvalId: asNullableString(row.approval_id),
    agentInstanceId: asNullableString(row.agent_instance_id),
    createdAt: asString(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
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
    executionProfile: parseExecutionProfile(row.execution_profile),
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
    modelOverride: asNullableString(row.model_override),
    executionProfile: parseExecutionProfile(row.execution_profile),
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

function mapRunRequestManifest(row: UnknownRow): RunRequestManifest {
  return {
    runId: asString(row.run_id),
    stepSequence: asNumber(row.step_sequence),
    providerProtocol: asString(row.provider_protocol) as RunRequestManifest["providerProtocol"],
    model: asString(row.model),
    messages: parseJsonArray(row.messages_json) as RunRequestManifest["messages"],
    tools: parseJsonArray(row.tools_json) as RunRequestManifest["tools"],
    maxOutputTokens: asNullableNumber(row.max_output_tokens),
    requestHash: asString(row.request_hash),
    createdAt: asString(row.created_at),
  };
}

function mapRunUsageRecord(row: UnknownRow): RunUsageRecord {
  return {
    runId: asString(row.run_id),
    sequence: asNumber(row.sequence),
    stepSequence: asNumber(row.step_sequence),
    source: asString(row.source) as RunUsageRecord["source"],
    status: asString(row.status) as RunUsageRecord["status"],
    inputTokens: asNullableNumber(row.input_tokens),
    outputTokens: asNullableNumber(row.output_tokens),
    receivedAt: asString(row.received_at),
  };
}

function mapRemoteRunBinding(row: UnknownRow): RemoteRunBinding {
  return {
    runId: asString(row.run_id),
    runtimeNodeId: asString(row.runtime_node_id),
    remoteRunId: asString(row.remote_run_id),
    lastSequence: asNumber(row.last_sequence),
    resultImportedAt: asNullableString(row.result_imported_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapContextRevision(row: UnknownRow): ContextRevision {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    projectId: asString(row.workspace_id),
    version: asNumber(row.version),
    parentId: asNullableString(row.parent_id),
    scope: asString(row.scope) as ContextRevision["scope"],
    taskId: asNullableString(row.task_id),
    title: asString(row.title),
    content: asString(row.content),
    sourceThreadId: asNullableString(row.source_thread_id),
    sourceRunId: asNullableString(row.source_run_id),
    sourceAgentInstanceId: asNullableString(row.source_agent_instance_id),
    sourceArtifactId: asNullableString(row.source_artifact_id),
    publishedBy: asString(row.published_by) as ContextRevision["publishedBy"],
    createdAt: asString(row.created_at),
  };
}

function mapContextRevisionUse(row: UnknownRow): ContextRevisionUse {
  return {
    contextRevisionId: asString(row.context_revision_id),
    runId: asString(row.run_id),
    usedAt: asString(row.used_at),
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

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
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
    status === "cancelled" ||
    status === "effect_unknown"
  );
}
