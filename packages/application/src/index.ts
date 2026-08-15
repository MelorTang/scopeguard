import { randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import {
  NativeAgentRuntime,
  type ModelMessage,
  type NativeAgentRunObserver,
  type ProviderAdapter,
  type ProviderCredentials,
  type ToolExecutionResult,
  type ToolRegistry,
} from "@scopeguard/agent-runtime";
import {
  RemoteRuntimeRequestError,
  type RemoteArtifact,
  type RemoteRunEvent,
  type RemoteRunRecord,
  type RemoteRuntimeClient,
} from "@scopeguard/remote-runtime";
import {
  canTransitionRun,
  canTransitionTask,
  normalizeProviderBaseUrl,
  validateProviderProfileInput,
  type AgentDefinition,
  type AgentHandoff,
  type AgentInstance,
  type AgentProfile,
  type AgentRun,
  type AgentThread,
  type AgentToolPolicy,
  type AssignmentStatus,
  type ApprovalDecision,
  type Artifact,
  type CliAgentConfig,
  type ContextRevision,
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
  type MessageContentBlock,
  type ManagedExecutionProgress,
  type Project,
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderProtocol,
  type RuntimeCapabilities,
  type RuntimeConnectionResult,
  type RuntimeNode,
  type RemoteRunBinding,
  type SaveRuntimeNodeInput,
  type RunConfigSnapshot,
  type RunEvent,
  type RunStatus,
  type StartRunInput,
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

export interface WorkspaceStore {
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  listWorkspaces(): Workspace[];
  getWorkspace(workspaceId: Id): Workspace | null;
  createWorkspace(input: CreateWorkspaceInput): Workspace;
  listProjects(): Project[];
  getProject(projectId: Id): Project | null;
  addProject(input: CreateProjectInput): Project;

  listProviderProfiles(): ProviderProfile[];
  getProviderProfile(providerProfileId: Id): ProviderProfile | null;
  saveProviderProfile(
    input: ProviderProfileInput & { id?: Id },
    apiKeyRef: string | null,
  ): ProviderProfile;
  deleteProviderProfile(providerProfileId: Id): void;

  listRuntimeNodes(): RuntimeNode[];
  getRuntimeNode(runtimeNodeId: Id): RuntimeNode | null;
  getRuntimeCredentialRef(runtimeNodeId: Id): string | null;
  saveRuntimeNode(input: {
    id?: Id;
    name: string;
    kind: RuntimeNode["kind"];
    baseUrl: string | null;
    credentialRef: string | null;
    status?: RuntimeNode["status"];
    capabilities?: RuntimeCapabilities;
    lastSeenAt?: string | null;
  }): RuntimeNode;

  listAgentDefinitions(): AgentDefinition[];
  getAgentDefinition(agentDefinitionId: Id): AgentDefinition | null;
  createAgentDefinition(input: CreateAgentDefinitionInput): AgentDefinition;
  listAgentInstances(workspaceId?: Id): AgentInstance[];
  getAgentInstance(agentInstanceId: Id): AgentInstance | null;
  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance;
  updateAgentInstanceRuntime(
    agentInstanceId: Id,
    runtimeNodeId: Id,
  ): AgentInstance;

  listTasks(workspaceId?: Id): WorkspaceTask[];
  getTask(taskId: Id): WorkspaceTask | null;
  createTask(input: CreateTaskInput): WorkspaceTask;
  updateTaskStatus(taskId: Id, status: TaskStatus): WorkspaceTask;
  listTaskAssignments(taskId?: Id): TaskAssignment[];
  createTaskAssignment(input: CreateTaskAssignmentInput): TaskAssignment;
  updateTaskAssignmentStatus(
    assignmentId: Id,
    status: AssignmentStatus,
  ): TaskAssignment;
  listArtifacts(workspaceId?: Id): Artifact[];
  createArtifact(input: CreateArtifactInput): Artifact;
  listHandoffs(workspaceId?: Id): AgentHandoff[];
  createHandoff(input: CreateHandoffInput): AgentHandoff;
  resolveHandoff(
    handoffId: Id,
    status: "accepted" | "rejected",
  ): AgentHandoff;
  listSchedules(workspaceId?: Id): WorkspaceSchedule[];
  createSchedule(input: CreateScheduleInput): WorkspaceSchedule;
  listInboxItems(workspaceId?: Id): InboxItem[];
  createInboxItem(input: CreateInboxItemInput): InboxItem;
  resolveInboxItem(inboxItemId: Id): InboxItem;

  listAgentProfiles(projectId?: Id): AgentProfile[];
  getAgentProfile(agentProfileId: Id): AgentProfile | null;
  createAgentProfile(input: CreateAgentProfileInput): AgentProfile;

  listThreads(projectId?: Id): AgentThread[];
  getThread(threadId: Id): AgentThread | null;
  createThread(input: CreateThreadInput): AgentThread;
  updateThreadSettings(input: UpdateThreadSettingsInput): AgentThread;
  listThreadMessages(threadId: Id): ThreadMessage[];
  appendMessage(
    input: Omit<ThreadMessage, "id" | "sequence" | "createdAt">,
  ): ThreadMessage;
  saveRunPartial(runId: Id, content: string): void;
  getRunPartial(runId: Id): string | null;
  clearRunPartial(runId: Id): void;

  createRun(
    threadId: Id,
    triggerMessageId: Id,
    contextRevisionId: Id | null,
    configSnapshot: RunConfigSnapshot,
  ): AgentRun;
  getRun(runId: Id): AgentRun | null;
  listActiveRuns(): AgentRun[];
  updateRunStatus(runId: Id, status: RunStatus, error?: string): AgentRun;
  interruptNonTerminalRuns(): number;
  appendRunEvent(event: RunEvent): void;
  createRemoteRunBinding(input: {
    runId: Id;
    runtimeNodeId: Id;
    remoteRunId: Id;
  }): RemoteRunBinding;
  getRemoteRunBinding(runId: Id): RemoteRunBinding | null;
  listActiveRemoteRunBindings(): RemoteRunBinding[];
  updateRemoteRunCursor(runId: Id, lastSequence: number): RemoteRunBinding;
  markRemoteRunResultImported(runId: Id): RemoteRunBinding;

  createToolCall(
    runId: Id,
    input: {
      providerCallId: string;
      name: string;
      description: string;
      arguments: Record<string, unknown>;
    },
  ): ToolCallRecord;
  getToolCall(toolCallId: Id): ToolCallRecord | null;
  listToolCallsForRun(runId: Id): ToolCallRecord[];
  updateToolCallStatus(
    toolCallId: Id,
    status: ToolCallStatus,
    result?: ToolExecutionResult,
  ): ToolCallRecord;

  createApproval(runId: Id, toolCallId: Id, reason: string): ToolApproval;
  getApproval(approvalId: Id): ToolApproval | null;
  listPendingApprovals(): ToolApproval[];
  resolveApproval(approvalId: Id, decision: ApprovalDecision): ToolApproval;
  expirePendingApprovalsForRun(runId: Id): number;
  expirePendingApprovalsForTerminalRuns(): number;
  cancelUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[];
  cancelUnfinishedToolCallsForTerminalRuns(): number;

  getProjectContext(projectId: Id): ContextRevision | null;
  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId?: Id | null,
    sourceRunId?: Id | null,
  ): ContextRevision;
  getWorkspaceContext(workspaceId: Id): ContextRevision | null;
  getContextRevision(contextRevisionId: Id): ContextRevision | null;
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
  }): ContextRevision;
}

export interface SecretVault {
  put(reference: string, secret: string): Promise<string>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export type ProviderAdapterFactory = (protocol: ProviderProtocol) => ProviderAdapter;
export type RunEventPublisher = (event: RunEvent) => void;
export type RemoteRuntimeClientFactory = (input: {
  baseUrl: string;
  token: string;
}) => RemoteRuntimeClient;

export type SaveProviderProfileInput = ProviderProfileInput & {
  id?: Id;
  clearApiKey?: boolean;
};

export type PublishWorkspaceContextInput = {
  workspaceId: Id;
  title: string;
  content: string;
  scope?: ContextRevision["scope"];
  taskId?: Id | null;
  sourceThreadId?: Id | null;
  sourceRunId?: Id | null;
  sourceAgentInstanceId?: Id | null;
  sourceArtifactId?: Id | null;
  publishedBy: ContextRevision["publishedBy"];
};

export type CliAgentOutput = {
  stream: "stdout" | "stderr";
  chunk: string;
};

export interface CliAgentRunner {
  run(input: {
    config: CliAgentConfig;
    prompt: string;
    projectRoot: string;
    signal: AbortSignal;
    onOutput: (output: CliAgentOutput) => void;
  }): Promise<{ stdout: string; stderr: string }>;
}

type ActiveRun = {
  controller: AbortController;
  settled: Promise<void>;
  execution: "local" | "remote";
};

type PartialOutputState = {
  text: string;
  checkpointedLength: number;
  checkpointedAt: number;
};

const HOST_SHUTDOWN_ABORT_NAME = "ScopeGuardHostShutdown";
const HOST_SHUTDOWN_MESSAGE =
  "The agent host stopped before this run completed.";
const REMOTE_POLL_SHUTDOWN_ABORT_NAME = "ScopeGuardRemotePollShutdown";
const REMOTE_POLL_INTERVAL_MS = 500;
const REMOTE_RECONNECT_MAX_DELAY_MS = 5_000;
const REMOTE_MISSING_RUN_RETRY_LIMIT = 5;
const REMOTE_CANCELLATION_RETRY_LIMIT = 5;
const PARTIAL_CHECKPOINT_INTERVAL_MS = 250;
const PARTIAL_CHECKPOINT_CHARACTERS = 4_096;
const NO_TOOLS: ToolRegistry = {
  definitions: () => [],
  get: () => null,
};

export class ScopeGuardApplication {
  readonly #store: WorkspaceStore;
  readonly #secrets: SecretVault;
  readonly #providerFactory: ProviderAdapterFactory;
  readonly #tools: ToolRegistry;
  readonly #cliRunner: CliAgentRunner | null;
  readonly #remoteClientFactory: RemoteRuntimeClientFactory | null;
  readonly #publish: RunEventPublisher;
  readonly #activeRuns = new Map<Id, ActiveRun>();
  readonly #approvals = new ApprovalWaiters();
  readonly #inputs = new InputWaiters();

  constructor(options: {
    store: WorkspaceStore;
    secrets: SecretVault;
    providerFactory: ProviderAdapterFactory;
    tools: ToolRegistry;
    cliRunner?: CliAgentRunner;
    remoteClientFactory?: RemoteRuntimeClientFactory;
    publish?: RunEventPublisher;
  }) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#providerFactory = options.providerFactory;
    this.#tools = options.tools;
    this.#cliRunner = options.cliRunner ?? null;
    this.#remoteClientFactory = options.remoteClientFactory ?? null;
    this.#publish = options.publish ?? (() => {});
  }

  initialize(): { interruptedRuns: number } {
    const localRunIds = this.#store.listActiveRuns()
      .filter((run) => !this.#store.getRemoteRunBinding(run.id))
      .map((run) => run.id);
    const interruptedRuns = this.#store.interruptNonTerminalRuns();
    this.#store.expirePendingApprovalsForTerminalRuns();
    this.#store.cancelUnfinishedToolCallsForTerminalRuns();
    const interruptedRunIds = new Set(localRunIds);
    for (const item of this.#store.listInboxItems()) {
      if (
        item.status !== "resolved" &&
        item.runId &&
        interruptedRunIds.has(item.runId) &&
        (item.kind === "approval" || item.kind === "input-required")
      ) {
        this.#store.resolveInboxItem(item.id);
      }
    }
    for (const runId of localRunIds) {
      const run = this.#store.getRun(runId);
      if (run?.status === "interrupted") {
        this.emitStatus(run);
      }
    }
    return {
      interruptedRuns,
    };
  }

  resumeRemoteRuns(): number {
    let resumed = 0;
    for (const binding of this.#store.listActiveRemoteRunBindings()) {
      if (this.#activeRuns.has(binding.runId)) {
        continue;
      }
      const run = this.#store.getRun(binding.runId);
      const thread = run ? this.#store.getThread(run.threadId) : null;
      if (!run || !thread || isTerminalStatus(run.status)) {
        continue;
      }
      const controller = new AbortController();
      const settled = this.#followRemoteRun({
        run,
        thread,
        binding,
        controller,
        allowMissingRunRetry: true,
      }).finally(() => {
        this.#activeRuns.delete(run.id);
      });
      this.#activeRuns.set(run.id, {
        controller,
        settled,
        execution: "remote",
      });
      resumed += 1;
    }
    return resumed;
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return this.#store.getWorkspaceSnapshot();
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Workspace name is required.");
    }
    assertMaximumLength(name, 200, "Workspace name");
    const localRootPath = input.localRootPath?.trim() || null;
    if (localRootPath) {
      assertMaximumLength(localRootPath, 4096, "Workspace local root path");
    }
    return this.#store.createWorkspace({ name, localRootPath });
  }

  addProject(input: CreateProjectInput): Project {
    const rootPath = input.rootPath.trim();
    if (!rootPath) {
      throw new Error("Project root path is required.");
    }
    assertMaximumLength(rootPath, 4096, "Project root path");
    if (input.name) {
      assertMaximumLength(input.name.trim(), 200, "Project name");
    }
    return this.#store.addProject({
      ...input,
      rootPath,
    });
  }

  async saveProviderProfile(
    rawInput: SaveProviderProfileInput,
  ): Promise<ProviderProfile> {
    const input = validateProviderProfileInput(rawInput);
    if (Object.keys(input.customHeaders ?? {}).length > 0) {
      throw new Error(
        "Custom headers are disabled until they can be stored in the SecretVault.",
      );
    }
    if (rawInput.clearApiKey && input.apiKey) {
      throw new Error("Cannot set and clear an API key in the same update.");
    }
    const id = rawInput.id ?? randomUUID();
    const existing = rawInput.id
      ? this.#store.getProviderProfile(rawInput.id)
      : null;
    const cleanInput = {
      ...input,
      id,
      apiKey: undefined,
      customHeaders: {},
    };

    if (rawInput.clearApiKey && existing?.apiKeyRef) {
      const saved = this.#store.saveProviderProfile(cleanInput, null);
      try {
        await this.#secrets.delete(existing.apiKeyRef);
      } catch (error) {
        this.#store.saveProviderProfile(
          providerToInput(existing),
          existing.apiKeyRef,
        );
        throw error;
      }
      return saved;
    }

    if (!input.apiKey) {
      return this.#store.saveProviderProfile(
        cleanInput,
        existing?.apiKeyRef ?? null,
      );
    }

    const newReference = await this.#secrets.put(
      `provider:${id}:${randomUUID()}`,
      input.apiKey,
    );
    let saved: ProviderProfile;
    try {
      saved = this.#store.saveProviderProfile(cleanInput, newReference);
    } catch (error) {
      await this.#secrets.delete(newReference);
      throw error;
    }

    if (existing?.apiKeyRef && existing.apiKeyRef !== newReference) {
      try {
        await this.#secrets.delete(existing.apiKeyRef);
      } catch (error) {
        try {
          this.#store.saveProviderProfile(
            providerToInput(existing),
            existing.apiKeyRef,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Provider was saved, but the previous credential could not be cleaned up.",
          );
        }
        await this.#secrets.delete(newReference);
        throw error;
      }
    }
    return saved;
  }

  async deleteProviderProfile(providerProfileId: Id): Promise<void> {
    const profile = this.requireProviderProfile(providerProfileId);
    this.#store.deleteProviderProfile(providerProfileId);
    if (!profile.apiKeyRef) {
      return;
    }
    try {
      await this.#secrets.delete(profile.apiKeyRef);
    } catch (error) {
      try {
        this.#store.saveProviderProfile(
          providerToInput(profile),
          profile.apiKeyRef,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Provider was deleted, but credential cleanup and rollback both failed.",
        );
      }
      throw error;
    }
  }

  async saveRuntimeNode(rawInput: SaveRuntimeNodeInput): Promise<RuntimeNode> {
    const name = rawInput.name.trim();
    if (!name) {
      throw new Error("Runtime name is required.");
    }
    assertMaximumLength(name, 200, "Runtime name");
    if (rawInput.clearCredential && rawInput.credential) {
      throw new Error("Cannot set and clear a Runtime credential together.");
    }
    if (rawInput.credential) {
      assertMaximumLength(rawInput.credential, 16_384, "Runtime credential");
    }
    const baseUrl = rawInput.kind === "remote"
      ? normalizeProviderBaseUrl(rawInput.baseUrl ?? "")
      : null;
    const id = rawInput.id ?? randomUUID();
    const existing = rawInput.id ? this.#store.getRuntimeNode(rawInput.id) : null;
    const existingCredentialRef = rawInput.id
      ? this.#store.getRuntimeCredentialRef(rawInput.id)
      : null;
    const capabilities: RuntimeCapabilities = rawInput.kind === "local"
      ? {
          nativeAgents: true,
          cliAgents: true,
          fileTools: true,
          commandTools: true,
          persistentRuns: false,
        }
      : {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        };
    const save = (credentialRef: string | null) => this.#store.saveRuntimeNode({
      id,
      name,
      kind: rawInput.kind,
      baseUrl,
      credentialRef,
      status: existing?.status ?? "unknown",
      capabilities,
      lastSeenAt: existing?.lastSeenAt ?? null,
    });

    if (rawInput.clearCredential) {
      const node = save(null);
      if (existingCredentialRef) {
        try {
          await this.#secrets.delete(existingCredentialRef);
        } catch (error) {
          restoreRuntimeNode(this.#store, existing, existingCredentialRef);
          throw error;
        }
      }
      return node;
    }
    if (!rawInput.credential) {
      return save(existingCredentialRef);
    }

    const newReference = await this.#secrets.put(
      `runtime:${id}:${randomUUID()}`,
      rawInput.credential.trim(),
    );
    let node: RuntimeNode;
    try {
      node = save(newReference);
    } catch (error) {
      await this.#secrets.delete(newReference);
      throw error;
    }
    if (existingCredentialRef && existingCredentialRef !== newReference) {
      try {
        await this.#secrets.delete(existingCredentialRef);
      } catch (error) {
        restoreRuntimeNode(this.#store, existing, existingCredentialRef);
        await this.#secrets.delete(newReference);
        throw error;
      }
    }
    return node;
  }

  async testRuntimeConnection(
    runtimeNodeId: Id,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<RuntimeConnectionResult> {
    const runtime = this.requireRuntimeNode(runtimeNodeId);
    if (runtime.kind !== "remote") {
      throw new Error("Only remote Runtime nodes require a connection test.");
    }
    const startedAt = Date.now();
    const credentialReference = this.#store.getRuntimeCredentialRef(runtime.id);
    const credential = credentialReference
      ? await this.#secrets.get(credentialReference)
      : null;
    let health: Awaited<ReturnType<RemoteRuntimeClient["health"]>>;
    try {
      const client = await this.#createRemoteClient(runtime.id);
      health = await client.health(signal);
    } catch (error) {
      const message = redactExactSecrets(
        error instanceof Error ? error.message : String(error),
        credential ? [credential] : [],
      );
      this.#store.saveRuntimeNode({
        id: runtime.id,
        name: runtime.name,
        kind: runtime.kind,
        baseUrl: runtime.baseUrl,
        credentialRef: credentialReference,
        status: "offline",
        capabilities: runtime.capabilities,
        lastSeenAt: runtime.lastSeenAt,
      });
      this.#recordRuntimeOffline(runtime, message);
      throw new Error(message);
    }
    const capabilities: RuntimeCapabilities = {
      nativeAgents: health.capabilities.nativeAgents,
      cliAgents: health.capabilities.cliAgents,
      fileTools: health.capabilities.fileTools,
      commandTools: health.capabilities.commandTools,
      persistentRuns: health.capabilities.persistentRuns,
    };
    this.#store.saveRuntimeNode({
      id: runtime.id,
      name: runtime.name,
      kind: runtime.kind,
      baseUrl: runtime.baseUrl,
      credentialRef: this.#store.getRuntimeCredentialRef(runtime.id),
      status: "online",
      capabilities,
      lastSeenAt: new Date().toISOString(),
    });
    this.#resolveRuntimeOffline(runtime.id);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      status: "online",
      capabilities,
      message: "Remote Runtime connection succeeded.",
    };
  }

  #recordRuntimeOffline(runtime: RuntimeNode, message: string): void {
    const instances = this.#store.listAgentInstances().filter(
      (instance) => instance.runtimeNodeId === runtime.id,
    );
    for (const instance of instances) {
      const existing = this.#store.listInboxItems(instance.workspaceId).find(
        (item) =>
          item.kind === "runtime-offline" &&
          item.status !== "resolved" &&
          item.agentInstanceId === instance.id,
      );
      if (existing) {
        continue;
      }
      this.#store.createInboxItem({
        workspaceId: instance.workspaceId,
        kind: "runtime-offline",
        title: "运行节点离线",
        summary: `${runtime.name}：${message}`,
        taskId: null,
        assignmentId: null,
        runId: null,
        approvalId: null,
        agentInstanceId: instance.id,
      });
    }
  }

  #resolveRuntimeOffline(runtimeNodeId: Id): void {
    for (const instance of this.#store.listAgentInstances().filter(
      (item) => item.runtimeNodeId === runtimeNodeId,
    )) {
      for (const inboxItem of this.#store.listInboxItems(instance.workspaceId)) {
        if (
          inboxItem.kind === "runtime-offline" &&
          inboxItem.status !== "resolved" &&
          inboxItem.agentInstanceId === instance.id
        ) {
          this.#store.resolveInboxItem(inboxItem.id);
        }
      }
    }
  }

  createAgentDefinition(input: CreateAgentDefinitionInput): AgentDefinition {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Agent name is required.");
    }
    assertMaximumLength(name, 200, "Agent name");
    assertMaximumLength(input.description ?? "", 2_000, "Agent description");
    assertMaximumLength(input.instructions, 50_000, "Agent instructions");
    if (input.providerProfileId) {
      this.requireProviderProfile(input.providerProfileId);
    }
    return this.#store.createAgentDefinition({ ...input, name });
  }

  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance {
    const workspace = this.requireWorkspace(input.workspaceId);
    const definition = this.requireAgentDefinition(input.agentDefinitionId);
    const runtime = this.requireRuntimeNode(input.runtimeNodeId);
    if (input.nameOverride) {
      assertMaximumLength(input.nameOverride.trim(), 200, "Agent instance name");
    }
    return this.#store.createAgentInstance({
      ...input,
      workspaceId: workspace.id,
      agentDefinitionId: definition.id,
      runtimeNodeId: runtime.id,
      nameOverride: input.nameOverride?.trim() || null,
    });
  }

  updateAgentInstanceRuntime(
    agentInstanceId: Id,
    runtimeNodeId: Id,
  ): AgentInstance {
    const instance = this.requireAgentInstance(agentInstanceId);
    const runtime = this.requireRuntimeNode(runtimeNodeId);
    return this.#store.updateAgentInstanceRuntime(instance.id, runtime.id);
  }

  createTask(input: CreateTaskInput): WorkspaceTask {
    const workspace = this.requireWorkspace(input.workspaceId);
    const title = input.title.trim();
    if (!title) {
      throw new Error("Task title is required.");
    }
    assertMaximumLength(title, 300, "Task title");
    assertMaximumLength(input.description ?? "", 100_000, "Task description");
    return this.#store.createTask({ ...input, workspaceId: workspace.id, title });
  }

  updateTaskStatus(taskId: Id, status: TaskStatus): WorkspaceTask {
    this.requireTask(taskId);
    return this.#store.updateTaskStatus(taskId, status);
  }

  assignAgentToTask(input: CreateTaskAssignmentInput): TaskAssignment {
    const task = this.requireTask(input.taskId);
    const instance = this.requireAgentInstance(input.agentInstanceId);
    if (task.workspaceId !== instance.workspaceId) {
      throw new Error("Task and Agent instance must belong to the same Workspace.");
    }
    if (input.threadId) {
      const thread = this.requireThread(input.threadId);
      if (thread.projectId !== task.workspaceId) {
        throw new Error("Assignment Thread belongs to a different Workspace.");
      }
    }
    assertMaximumLength(input.role ?? "", 500, "Assignment role");
    return this.#store.createTaskAssignment(input);
  }

  createArtifact(input: CreateArtifactInput): Artifact {
    const workspace = this.requireWorkspace(input.workspaceId);
    const task = this.requireTask(input.taskId);
    const instance = this.requireAgentInstance(input.agentInstanceId);
    if (task.workspaceId !== workspace.id || instance.workspaceId !== workspace.id) {
      throw new Error("Artifact provenance must stay inside one Workspace.");
    }
    if (input.assignmentId) {
      const assignment = this.#store.listTaskAssignments(task.id).find(
        (item) => item.id === input.assignmentId,
      );
      if (!assignment || assignment.agentInstanceId !== instance.id) {
        throw new Error("Artifact Assignment does not match its Task and Agent.");
      }
    }
    if (input.runId) {
      const run = this.requireRun(input.runId);
      const runThread = this.requireThread(run.threadId);
      const runAssignment = this.#store.listTaskAssignments().find(
        (item) => item.threadId === run.threadId,
      );
      if (
        runThread.projectId !== workspace.id ||
        !runAssignment ||
        runAssignment.taskId !== task.id ||
        runAssignment.agentInstanceId !== instance.id ||
        (input.assignmentId && input.assignmentId !== runAssignment.id)
      ) {
        throw new Error("Artifact Run does not match its Workspace, Task, and Agent.");
      }
    }
    const title = input.title.trim();
    if (!title) {
      throw new Error("Artifact title is required.");
    }
    assertMaximumLength(title, 300, "Artifact title");
    assertMaximumLength(input.mimeType, 200, "Artifact MIME type");
    if (input.kind === "file") {
      if (!input.filePath?.trim() || input.content) {
        throw new Error("File Artifacts require a file path and no inline content.");
      }
      assertMaximumLength(input.filePath, 4096, "Artifact file path");
    } else if (!input.content?.trim() || input.filePath) {
      throw new Error("Text Artifacts require inline content and no file path.");
    } else {
      assertMaximumLength(input.content, 1_000_000, "Artifact content");
    }
    return this.#store.createArtifact({
      ...input,
      workspaceId: workspace.id,
      taskId: task.id,
      agentInstanceId: instance.id,
      title,
      content: input.content ?? null,
      filePath: input.filePath?.trim() || null,
    });
  }

  createHandoff(input: CreateHandoffInput): AgentHandoff {
    const workspace = this.requireWorkspace(input.workspaceId);
    const task = this.requireTask(input.taskId);
    const from = this.requireAgentInstance(input.fromAgentInstanceId);
    const to = this.requireAgentInstance(input.toAgentInstanceId);
    if (from.id === to.id) {
      throw new Error("A Handoff requires two different Agent instances.");
    }
    if (
      task.workspaceId !== workspace.id ||
      from.workspaceId !== workspace.id ||
      to.workspaceId !== workspace.id
    ) {
      throw new Error("Handoff participants must belong to one Workspace.");
    }
    const context = this.#store.getContextRevision(input.contextRevisionId);
    if (
      !context ||
      context.workspaceId !== workspace.id ||
      (context.taskId !== null && context.taskId !== task.id)
    ) {
      throw new Error("Handoff Context belongs to a different Workspace or Task.");
    }
    if (input.sourceRunId) {
      const sourceRun = this.requireRun(input.sourceRunId);
      const sourceAssignment = this.#store.listTaskAssignments().find(
        (item) => item.threadId === sourceRun.threadId,
      );
      if (
        !sourceAssignment ||
        sourceAssignment.taskId !== task.id ||
        sourceAssignment.agentInstanceId !== from.id
      ) {
        throw new Error("Handoff source Run does not match its Task and source Agent.");
      }
    }
    const summary = input.summary.trim();
    if (!summary) {
      throw new Error("Handoff summary is required.");
    }
    assertMaximumLength(summary, 20_000, "Handoff summary");
    return this.#store.createHandoff({ ...input, summary });
  }

  createSchedule(input: CreateScheduleInput): WorkspaceSchedule {
    const workspace = this.requireWorkspace(input.workspaceId);
    const instance = this.requireAgentInstance(input.agentInstanceId);
    if (instance.workspaceId !== workspace.id) {
      throw new Error("Schedule Agent belongs to a different Workspace.");
    }
    for (const [value, maximum, field] of [
      [input.title.trim(), 300, "Schedule title"],
      [input.prompt.trim(), 100_000, "Schedule prompt"],
      [input.cronExpression.trim(), 200, "Cron expression"],
      [input.timeZone.trim(), 200, "Schedule time zone"],
    ] as const) {
      if (!value) {
        throw new Error(`${field} is required.`);
      }
      assertMaximumLength(value, maximum, field);
    }
    return this.#store.createSchedule(input);
  }

  resolveInboxItem(inboxItemId: Id): InboxItem {
    const item = this.#store.listInboxItems().find(
      (candidate) => candidate.id === inboxItemId,
    );
    if (
      item?.kind === "input-required" &&
      item.runId &&
      this.#store.getRun(item.runId)?.status === "waiting-input"
    ) {
      throw new Error("Reply in the Agent conversation before resolving this item.");
    }
    return this.#store.resolveInboxItem(inboxItemId);
  }

  async testProviderConnection(
    rawInput: SaveProviderProfileInput,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<ProviderConnectionResult> {
    const input = validateProviderProfileInput(rawInput);
    if (Object.keys(input.customHeaders ?? {}).length > 0) {
      throw new Error(
        "Custom headers are disabled until they can be stored in the SecretVault.",
      );
    }
    const existing = rawInput.id
      ? this.#store.getProviderProfile(rawInput.id)
      : null;
    const apiKey = input.apiKey
      ?? (existing?.apiKeyRef ? await this.#secrets.get(existing.apiKeyRef) : null);
    return this.#providerFactory(input.protocol).testConnection(
      {
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey,
        model: input.defaultModel,
        customHeaders: {},
      },
      signal,
    );
  }

  createAgentProfile(input: CreateAgentProfileInput): AgentProfile {
    const project = this.requireProject(input.projectId);
    const workspace = this.requireWorkspace(project.id);
    const runtimeKind = input.runtimeKind ?? "native";
    const runtimeNode = input.runtimeNodeId
      ? this.requireRuntimeNode(input.runtimeNodeId)
      : this.requireRuntimeNode("local-runtime");
    if (!input.name.trim()) {
      throw new Error("Agent name is required.");
    }
    assertMaximumLength(input.name.trim(), 200, "Agent name");
    assertMaximumLength(input.instructions, 50_000, "Agent instructions");
    if (runtimeKind === "native") {
      if (!input.providerProfileId) {
        throw new Error("A native Agent Profile requires a provider.");
      }
      this.requireProviderProfile(input.providerProfileId);
    } else if (runtimeNode.kind !== "local") {
      throw new Error("Local CLI Agent Profiles require a local Runtime.");
    } else if (!workspace.localRootPath) {
      throw new Error(
        "Local CLI Agent Profiles require a Workspace with a local folder.",
      );
    } else if (!input.cliConfig?.command.trim()) {
      throw new Error("A local CLI Agent Profile requires a command.");
    } else if (
      input.cliConfig.cwd !== null ||
      Object.keys(input.cliConfig.env).length > 0
    ) {
      throw new Error(
        "Custom CLI working directories and environment variables are disabled in this build.",
      );
    } else {
      assertMaximumLength(input.cliConfig.command, 4096, "CLI command");
      if (input.cliConfig.args.length > 128) {
        throw new Error("CLI configuration must not contain more than 128 arguments.");
      }
      for (const argument of input.cliConfig.args) {
        assertMaximumLength(argument, 32_768, "CLI argument");
      }
    }

    return this.#store.createAgentProfile({
      ...input,
      projectId: project.id,
      runtimeKind,
      runtimeNodeId: runtimeNode.id,
    });
  }

  createThread(input: CreateThreadInput): AgentThread {
    const project = this.requireProject(input.projectId);
    const profile = this.requireAgentProfile(input.agentProfileId);
    if (profile.projectId !== project.id) {
      throw new Error("Agent Profile and Thread must belong to the same Project.");
    }
    if (input.title) {
      assertMaximumLength(input.title.trim(), 300, "Thread title");
    }
    return this.#store.createThread(input);
  }

  updateThreadSettings(input: UpdateThreadSettingsInput): AgentThread {
    const thread = this.requireThread(input.threadId);
    const profile = this.requireAgentProfile(thread.agentProfileId);
    if (input.modelOverride !== undefined && profile.runtimeKind !== "native") {
      throw new Error("Local CLI Conversations do not support model selection.");
    }
    const modelOverride = input.modelOverride === undefined
      ? undefined
      : input.modelOverride?.trim() || null;
    if (modelOverride) {
      assertMaximumLength(modelOverride, 512, "Model");
    }
    if (input.executionProfile === undefined && modelOverride === undefined) {
      throw new Error("No Conversation settings were provided.");
    }
    return this.#store.updateThreadSettings({
      threadId: thread.id,
      modelOverride,
      executionProfile: input.executionProfile,
    });
  }

  listThreadMessages(threadId: Id): ThreadMessage[] {
    this.requireThread(threadId);
    return this.#store.listThreadMessages(threadId);
  }

  async startRun(input: StartRunInput): Promise<AgentRun> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("Message cannot be empty.");
    }
    assertMaximumLength(prompt, 100_000, "Message");
    const thread = this.requireThread(input.threadId);
    const activeThreadRun = this.#store.listActiveRuns().find(
      (run) => run.threadId === thread.id,
    );
    if (activeThreadRun?.status === "waiting-input") {
      return this.#provideRunInput(activeThreadRun, thread, prompt);
    }
    if (activeThreadRun) {
      throw new Error("This Thread already has an active Run.");
    }
    this.#resolveStaleInputRequests(thread);
    const profile = this.requireAgentProfile(thread.agentProfileId);
    const project = this.requireProject(thread.projectId);
    const workspace = this.requireWorkspace(thread.projectId);
    const assignment = this.#store.listTaskAssignments().find(
      (item) => item.threadId === thread.id,
    ) ?? null;
    const agentInstance = assignment
      ? this.requireAgentInstance(assignment.agentInstanceId)
      : null;
    const pendingHandoff = assignment && agentInstance
      ? this.#store.listHandoffs(workspace.id)
        .filter((handoff) =>
          handoff.status === "pending" &&
          handoff.toAgentInstanceId === agentInstance.id
        )
        .at(-1) ?? null
      : null;
    const context = pendingHandoff
      ? this.#store.getContextRevision(pendingHandoff.contextRevisionId)
      : this.#store.getWorkspaceContext(workspace.id);
    if (pendingHandoff && !context) {
      throw new Error("Handoff Context revision is no longer available.");
    }
    const runtimeNode = agentInstance
      ? this.requireRuntimeNode(agentInstance.runtimeNodeId)
      : null;
    const useRemoteRuntime = runtimeNode?.kind === "remote";
    const provider = profile.runtimeKind === "native"
      ? profile.providerProfileId
        ? this.requireProviderProfile(profile.providerProfileId)
        : null
      : null;
    if (profile.runtimeKind === "native" && !provider) {
      throw new Error("Native Agent Profile has no provider.");
    }
    if (useRemoteRuntime && profile.runtimeKind !== "native") {
      throw new Error("Remote Runtime currently supports native Agents only.");
    }
    if (useRemoteRuntime && (!this.#remoteClientFactory || !assignment || !agentInstance)) {
      throw new Error("Remote Runtime is not available for this Agent assignment.");
    }
    if (
      profile.runtimeKind === "local-cli" &&
      (!this.#cliRunner || !profile.cliConfig)
    ) {
      throw new Error("Local CLI Runs are not available in this build.");
    }
    if (profile.runtimeKind === "local-cli" && !workspace.localRootPath) {
      throw new Error("Local CLI Agents require a Workspace with a local folder.");
    }

    const toolPolicy = !useRemoteRuntime && workspace.localRootPath
      ? effectiveToolPolicy(thread.executionProfile, profile.toolPolicy)
      : {
          readFiles: "deny" as const,
          writeFiles: "deny" as const,
          runCommands: "deny" as const,
        };

    const trigger = this.#store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: prompt }],
      metadata: {},
    });
    const snapshot: RunConfigSnapshot = {
      agentProfileId: profile.id,
      runtimeKind: profile.runtimeKind,
      providerProfileId: provider?.id ?? null,
      providerProtocol: provider?.protocol ?? null,
      providerBaseUrl: provider?.baseUrl ?? null,
      model: provider
        ? thread.modelOverride ?? provider.defaultModel
        : null,
      instructions: profile.instructions,
      executionProfile: thread.executionProfile,
      toolPolicy,
      cliConfig: profile.cliConfig,
    };
    const run = this.#store.createRun(
      thread.id,
      trigger.id,
      context?.id ?? null,
      snapshot,
    );
    if (pendingHandoff) {
      this.#store.resolveHandoff(pendingHandoff.id, "accepted");
    }
    this.emitStatus(run);
    this.emitMessage(run, thread, trigger);

    const controller = new AbortController();
    const execution = useRemoteRuntime
      ? this.#executeRemoteRun({
          run,
          thread,
          project,
          workspace,
          profile,
          provider: provider!,
          context,
          assignment: assignment!,
          agentInstance: agentInstance!,
          runtimeNode: runtimeNode!,
          controller,
        })
      : profile.runtimeKind === "native"
        ? this.#executeNativeRun({
          run,
          thread,
          project,
          workspace,
          profile,
          provider: provider!,
          context,
          controller,
        })
        : this.#executeCliRun({
            run,
            thread,
            project,
            workspace,
            profile,
            context,
            controller,
          });
    const settled = execution.finally(() => {
      this.#approvals.cancelRun(run.id);
      this.#inputs.cancelRun(run.id);
      this.#store.expirePendingApprovalsForRun(run.id);
      if (!useRemoteRuntime) {
        this.finalizeCancelledToolCalls(run, thread);
      }
      this.#activeRuns.delete(run.id);
    });
    this.#activeRuns.set(run.id, {
      controller,
      settled,
      execution: useRemoteRuntime ? "remote" : "local",
    });
    return run;
  }

  async cancelRun(runId: Id): Promise<void> {
    const active = this.#activeRuns.get(runId);
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (!active) {
      return;
    }
    if (canTransitionRun(run.status, "cancelling")) {
      this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
    }
    let waitForSettlement = true;
    if (active.execution === "remote") {
      const binding = this.#store.getRemoteRunBinding(run.id);
      if (!binding) {
        active.controller.abort(
          new DOMException("Run cancelled by the user.", "AbortError"),
        );
      } else {
        waitForSettlement = false;
      }
    } else {
      active.controller.abort(new DOMException("Run cancelled by the user.", "AbortError"));
    }
    this.#approvals.cancelRun(run.id);
    this.#inputs.cancelRun(run.id);
    if (waitForSettlement) {
      await active.settled;
    }
  }

  async resolveApproval(
    approvalId: Id,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = this.#store.resolveApproval(approvalId, decision);
    this.#approvals.resolve(approval.id, decision);
    const inboxItem = this.#store.listInboxItems().find(
      (item) => item.approvalId === approval.id && item.status !== "resolved",
    );
    if (inboxItem) {
      this.#store.resolveInboxItem(inboxItem.id);
    }
  }

  #provideRunInput(
    run: AgentRun,
    thread: AgentThread,
    answer: string,
  ): AgentRun {
    if (!this.#inputs.has(run.id)) {
      throw new Error(
        "This input request can no longer resume. Retry the interrupted task instead.",
      );
    }
    const message = this.#store.appendMessage({
      threadId: thread.id,
      runId: run.id,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: answer }],
      metadata: { inputResponse: true },
    });
    const inboxItem = this.#store.listInboxItems(thread.projectId).find(
      (item) =>
        item.kind === "input-required" &&
        item.runId === run.id &&
        item.status !== "resolved",
    );
    if (inboxItem) {
      this.#store.resolveInboxItem(inboxItem.id);
    }
    this.emitMessage(run, thread, message);
    this.#inputs.resolve(run.id, answer);
    return this.requireRun(run.id);
  }

  #resolveStaleInputRequests(thread: AgentThread): void {
    for (const item of this.#store.listInboxItems(thread.projectId)) {
      if (
        item.kind !== "input-required" ||
        item.status === "resolved" ||
        !item.runId
      ) {
        continue;
      }
      const run = this.#store.getRun(item.runId);
      if (run?.threadId === thread.id && isTerminalStatus(run.status)) {
        this.#store.resolveInboxItem(item.id);
      }
    }
  }

  getProjectContext(projectId: Id): ContextRevision | null {
    this.requireProject(projectId);
    return this.#store.getProjectContext(projectId);
  }

  getWorkspaceContext(workspaceId: Id): ContextRevision | null {
    this.requireWorkspace(workspaceId);
    return this.#store.getWorkspaceContext(workspaceId);
  }

  publishWorkspaceContext(input: PublishWorkspaceContextInput): ContextRevision {
    const workspace = this.requireWorkspace(input.workspaceId);
    const scope = input.scope ?? "workspace";
    const taskId = input.taskId ?? null;
    if (scope === "task" && !taskId) {
      throw new Error("Task-scoped Context requires a Task.");
    }
    if (scope === "workspace" && taskId) {
      throw new Error("Workspace-scoped Context cannot reference a Task.");
    }
    if (taskId && this.requireTask(taskId).workspaceId !== workspace.id) {
      throw new Error("Context Task belongs to a different Workspace.");
    }
    const sourceThread = input.sourceThreadId
      ? this.requireThread(input.sourceThreadId)
      : null;
    if (sourceThread) {
      const thread = sourceThread;
      if (thread.projectId !== workspace.id) {
        throw new Error("Context source Thread belongs to a different Workspace.");
      }
    }
    let sourceRun: AgentRun | null = null;
    if (input.sourceRunId) {
      const run = this.requireRun(input.sourceRunId);
      sourceRun = run;
      const thread = this.requireThread(run.threadId);
      if (thread.projectId !== workspace.id) {
        throw new Error("Context source Run belongs to a different Workspace.");
      }
      if (input.sourceThreadId && input.sourceThreadId !== thread.id) {
        throw new Error("Context source Run belongs to a different Thread.");
      }
    }
    const sourceAgent = input.sourceAgentInstanceId
      ? this.requireAgentInstance(input.sourceAgentInstanceId)
      : null;
    if (sourceAgent) {
      const instance = sourceAgent;
      if (instance.workspaceId !== workspace.id) {
        throw new Error("Context source Agent belongs to a different Workspace.");
      }
    }
    if (input.publishedBy === "agent" && !input.sourceAgentInstanceId) {
      throw new Error("Agent-published Context requires a source Agent.");
    }
    const sourceArtifact = input.sourceArtifactId
      ? this.#store.listArtifacts(workspace.id).find(
        (item) => item.id === input.sourceArtifactId,
      ) ?? null
      : null;
    if (input.sourceArtifactId) {
      const artifact = sourceArtifact;
      if (!artifact || (taskId && artifact.taskId !== taskId)) {
        throw new Error("Context source Artifact belongs to a different scope.");
      }
    }
    if (sourceRun && sourceAgent) {
      const assignment = this.#store.listTaskAssignments().find(
        (item) => item.threadId === sourceRun!.threadId,
      );
      if (!assignment || assignment.agentInstanceId !== sourceAgent.id) {
        throw new Error("Context source Run does not belong to its source Agent.");
      }
    }
    if (sourceArtifact) {
      if (
        sourceAgent &&
        sourceArtifact.agentInstanceId !== sourceAgent.id
      ) {
        throw new Error("Context source Artifact does not belong to its source Agent.");
      }
      if (sourceRun && sourceArtifact.runId !== sourceRun.id) {
        throw new Error("Context source Artifact does not belong to its source Run.");
      }
      if (sourceThread) {
        const assignment = sourceArtifact.assignmentId
          ? this.#store.listTaskAssignments(sourceArtifact.taskId).find(
              (item) => item.id === sourceArtifact.assignmentId,
            )
          : null;
        if (!assignment || assignment.threadId !== sourceThread.id) {
          throw new Error("Context source Artifact does not belong to its source Thread.");
        }
      }
    }
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || !content) {
      throw new Error("Context title and content are required.");
    }
    assertMaximumLength(title, 300, "Context title");
    assertMaximumLength(content, 200_000, "Context content");
    return this.#store.updateWorkspaceContext({
      ...input,
      workspaceId: workspace.id,
      title,
      content,
      scope,
      taskId,
    });
  }

  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId?: Id,
    sourceRunId?: Id,
  ): ContextRevision {
    this.requireProject(projectId);
    assertMaximumLength(content, 200_000, "Project Context");
    let sourceThread: AgentThread | null = null;
    if (sourceThreadId) {
      sourceThread = this.requireThread(sourceThreadId);
      if (sourceThread.projectId !== projectId) {
        throw new Error("Context source Thread belongs to a different Project.");
      }
    }
    if (sourceRunId) {
      const run = this.requireRun(sourceRunId);
      const runThread = this.requireThread(run.threadId);
      if (runThread.projectId !== projectId) {
        throw new Error("Context source Run belongs to a different Project.");
      }
      if (sourceThread && sourceThread.id !== runThread.id) {
        throw new Error("Context source Run belongs to a different Thread.");
      }
    }
    return this.#store.updateProjectContext(
      projectId,
      content.trim(),
      sourceThreadId ?? null,
      sourceRunId ?? null,
    );
  }

  async waitForRun(runId: Id): Promise<AgentRun> {
    await this.#activeRuns.get(runId)?.settled;
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  async shutdown(): Promise<void> {
    const activeRuns = [...this.#activeRuns.entries()];
    for (const [runId, active] of activeRuns) {
      const reason = new Error(HOST_SHUTDOWN_MESSAGE);
      reason.name = active.execution === "remote"
        ? REMOTE_POLL_SHUTDOWN_ABORT_NAME
        : HOST_SHUTDOWN_ABORT_NAME;
      active.controller.abort(reason);
      this.#approvals.cancelRun(runId);
      this.#inputs.cancelRun(runId);
    }
    await Promise.allSettled(activeRuns.map(([, active]) => active.settled));
  }

  async #executeRemoteRun(input: {
    run: AgentRun;
    thread: AgentThread;
    project: Project;
    workspace: Workspace;
    profile: AgentProfile;
    provider: ProviderProfile;
    context: ContextRevision | null;
    assignment: TaskAssignment;
    agentInstance: AgentInstance;
    runtimeNode: RuntimeNode;
    controller: AbortController;
  }): Promise<void> {
    const {
      run,
      thread,
      project,
      workspace,
      profile,
      provider,
      context,
      assignment,
      agentInstance,
      runtimeNode,
      controller,
    } = input;
    const sensitiveValues: string[] = [];
    try {
      this.emitStatus(this.#store.updateRunStatus(run.id, "preparing"));
      const client = await this.#createRemoteClient(runtimeNode.id);
      const health = await client.health(controller.signal);
      if (!health.capabilities.nativeAgents || !health.capabilities.persistentRuns) {
        throw new Error("Remote Runtime does not support persistent native Runs.");
      }
      const apiKey = provider.apiKeyRef
        ? await this.#secrets.get(provider.apiKeyRef)
        : null;
      if (apiKey) {
        sensitiveValues.push(apiKey);
      }
      throwIfAborted(controller.signal);
      const task = this.requireTask(assignment.taskId);
      const remoteRunId = randomUUID();
      let binding = this.#store.createRemoteRunBinding({
        runId: run.id,
        runtimeNodeId: runtimeNode.id,
        remoteRunId,
      });
      const submission = {
        clientRunId: run.id,
        remoteRunId,
        workspaceId: workspace.id,
        taskId: task.id,
        threadId: thread.id,
        agentInstanceId: agentInstance.id,
        artifactTitle: task.title,
        provider: {
          protocol: provider.protocol,
          baseUrl: normalizeProviderBaseUrl(provider.baseUrl),
          apiKey,
          model: profile.modelOverride ?? provider.defaultModel,
          customHeaders: {},
        },
        messages: toModelMessages(
          this.#store.listThreadMessages(thread.id),
          profile,
          workspace,
          context,
        ),
      };
      let submitDelay = REMOTE_POLL_INTERVAL_MS;
      let submissionAttempted = false;
      let submissionConfirmed = false;
      while (!controller.signal.aborted) {
        if (this.requireRun(run.id).status === "cancelling") {
          break;
        }
        try {
          submissionAttempted = true;
          const submitted = await client.submitRun(
            submission,
            controller.signal,
          );
          binding = this.#store.createRemoteRunBinding({
            runId: run.id,
            runtimeNodeId: runtimeNode.id,
            remoteRunId: submitted.id,
          });
          submissionConfirmed = true;
          break;
        } catch (error) {
          if (this.requireRun(run.id).status === "cancelling") {
            break;
          }
          if (
            !(error instanceof RemoteRuntimeRequestError) ||
            !error.retryable
          ) {
            throw error;
          }
          await delayWithSignal(submitDelay, controller.signal);
          submitDelay = Math.min(
            submitDelay * 2,
            REMOTE_RECONNECT_MAX_DELAY_MS,
          );
        }
      }
      throwIfAborted(controller.signal);
      if (
        !submissionAttempted &&
        this.requireRun(run.id).status === "cancelling"
      ) {
        this.#transitionRemoteRun(run.id, "cancelled");
        return;
      }
      await this.#followRemoteRun({
        run,
        thread,
        binding,
        controller,
        allowMissingRunRetry: !submissionConfirmed,
      });
    } catch (error) {
      if (isRemotePollShutdown(controller.signal)) {
        return;
      }
      const current = this.#store.getRun(run.id);
      if (!current || isTerminalStatus(current.status)) {
        return;
      }
      if (controller.signal.aborted) {
        if (canTransitionRun(current.status, "cancelling")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
        }
        const cancelling = this.#store.getRun(run.id);
        if (cancelling && canTransitionRun(cancelling.status, "cancelled")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelled"));
        }
        return;
      }
      const message = redactExactSecrets(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      );
      if (canTransitionRun(current.status, "failed")) {
        this.emitStatus(this.#store.updateRunStatus(run.id, "failed", message));
      }
    }
  }

  async #followRemoteRun(input: {
    run: AgentRun;
    thread: AgentThread;
    binding: RemoteRunBinding;
    controller: AbortController;
    allowMissingRunRetry: boolean;
  }): Promise<void> {
    const { run, thread, controller, allowMissingRunRetry } = input;
    let binding = input.binding;
    const recoveredPartial = this.#store.getRunPartial(run.id) ?? "";
    const partial: PartialOutputState = {
      text: recoveredPartial,
      checkpointedLength: recoveredPartial.length,
      checkpointedAt: Date.now(),
    };
    let reconnectDelay = REMOTE_POLL_INTERVAL_MS;
    let missingRunRetries = 0;
    let cancellationRetries = 0;

    while (!controller.signal.aborted) {
      try {
        const client = await this.#createRemoteClient(binding.runtimeNodeId);
        const current = this.requireRun(run.id);
        if (isTerminalStatus(current.status)) {
          return;
        }
        if (current.status === "cancelling") {
          const cancellation = await client.cancelRun(
            binding.remoteRunId,
            controller.signal,
          );
          if (
            this.#reconcileRemoteTerminal(
              run,
              thread,
              binding,
              cancellation,
              partial,
            )
          ) {
            return;
          }
        }
        const result = await client.getRun(
          binding.remoteRunId,
          binding.lastSequence,
          controller.signal,
        );
        reconnectDelay = REMOTE_POLL_INTERVAL_MS;
        missingRunRetries = 0;
        cancellationRetries = 0;
        for (const event of result.events) {
          this.#applyRemoteEvent(run, thread, event, partial);
          binding = this.#store.updateRemoteRunCursor(run.id, event.sequence);
        }

        if (
          this.#reconcileRemoteTerminal(
            run,
            thread,
            binding,
            result.run,
            partial,
          )
        ) {
          return;
        }
        await delayWithSignal(REMOTE_POLL_INTERVAL_MS, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          if (isRemotePollShutdown(controller.signal)) {
            return;
          }
          throw error;
        }
        if (
          allowMissingRunRetry &&
          error instanceof RemoteRuntimeRequestError &&
          error.status === 404 &&
          missingRunRetries < REMOTE_MISSING_RUN_RETRY_LIMIT
        ) {
          missingRunRetries += 1;
          await delayWithSignal(reconnectDelay, controller.signal);
          reconnectDelay = Math.min(
            reconnectDelay * 2,
            REMOTE_RECONNECT_MAX_DELAY_MS,
          );
          continue;
        }
        const current = this.requireRun(run.id);
        if (
          current.status === "cancelling" &&
          error instanceof RemoteRuntimeRequestError &&
          error.status === 404
        ) {
          this.persistInterruptedText(run, thread, partial.text);
          this.#transitionRemoteRun(run.id, "cancelled");
          return;
        }
        if (
          current.status === "cancelling" &&
          error instanceof RemoteRuntimeRequestError &&
          error.retryable
        ) {
          cancellationRetries += 1;
          if (cancellationRetries >= REMOTE_CANCELLATION_RETRY_LIMIT) {
            this.persistInterruptedText(run, thread, partial.text);
            this.#transitionRemoteRun(
              run.id,
              "interrupted",
              "Remote cancellation could not be confirmed after repeated connection failures.",
            );
            return;
          }
        }
        if (
          !(error instanceof RemoteRuntimeRequestError) ||
          !error.retryable
        ) {
          this.persistInterruptedText(run, thread, partial.text);
          const message = error instanceof Error
            ? error.message
            : "Remote Runtime returned an invalid response.";
          this.#transitionRemoteRun(
            run.id,
            current.status === "cancelling" ? "interrupted" : "failed",
            message.slice(0, 4_000),
          );
          return;
        }
        await delayWithSignal(reconnectDelay, controller.signal);
        reconnectDelay = Math.min(
          reconnectDelay * 2,
          REMOTE_RECONNECT_MAX_DELAY_MS,
        );
      }
    }
  }

  #reconcileRemoteTerminal(
    run: AgentRun,
    thread: AgentThread,
    binding: RemoteRunBinding,
    remoteRun: RemoteRunRecord,
    partial: PartialOutputState,
  ): boolean {
    if (remoteRun.status === "completed") {
      if (!remoteRun.artifact) {
        this.persistInterruptedText(run, thread, partial.text);
        this.#transitionRemoteRun(
          run.id,
          "failed",
          "Remote Runtime completed without an Artifact.",
        );
        return true;
      }
      this.#importRemoteArtifact(run, thread, binding, remoteRun.artifact);
      this.#store.clearRunPartial(run.id);
      this.#transitionRemoteRun(run.id, "completed");
      return true;
    }
    if (remoteRun.status === "failed") {
      this.persistInterruptedText(run, thread, partial.text);
      this.#transitionRemoteRun(
        run.id,
        "failed",
        (remoteRun.error ?? "Remote Runtime failed the Run.").slice(0, 4_000),
      );
      return true;
    }
    if (remoteRun.status === "cancelled") {
      this.persistInterruptedText(run, thread, partial.text);
      this.#transitionRemoteRun(run.id, "cancelled");
      return true;
    }
    return false;
  }

  #applyRemoteEvent(
    run: AgentRun,
    thread: AgentThread,
    event: RemoteRunEvent,
    partial: PartialOutputState,
  ): void {
    if (event.type === "text-delta") {
      partial.text += event.delta;
      this.checkpointPartial(run.id, partial);
      this.#publish({
        type: "assistant-delta",
        runId: run.id,
        threadId: thread.id,
        delta: event.delta,
        at: event.at,
      });
      return;
    }
    if (event.type !== "status") {
      return;
    }
    if (event.status === "running") {
      this.#transitionRemoteRun(run.id, "running");
    } else if (event.status === "cancelling") {
      this.#transitionRemoteRun(run.id, "cancelling");
    }
  }

  #transitionRemoteRun(runId: Id, status: RunStatus, error?: string): void {
    let current = this.requireRun(runId);
    if (
      (status === "completed" || status === "failed") &&
      current.status === "preparing"
    ) {
      this.emitStatus(this.#store.updateRunStatus(runId, "running"));
      current = this.requireRun(runId);
    }
    if (status === "cancelled" && canTransitionRun(current.status, "cancelling")) {
      this.emitStatus(this.#store.updateRunStatus(runId, "cancelling"));
      current = this.requireRun(runId);
    }
    if (current.status !== status && canTransitionRun(current.status, status)) {
      this.emitStatus(this.#store.updateRunStatus(runId, status, error));
    }
  }

  #importRemoteArtifact(
    run: AgentRun,
    thread: AgentThread,
    binding: RemoteRunBinding,
    remoteArtifact: RemoteArtifact,
  ): void {
    if (binding.resultImportedAt) {
      return;
    }
    const existingMessage = this.#store.listThreadMessages(thread.id).find(
      (message) => message.runId === run.id && message.role === "assistant",
    );
    if (!existingMessage) {
      const message = this.#store.appendMessage({
        threadId: thread.id,
        runId: run.id,
        role: "assistant",
        status: "committed",
        content: [{ type: "text", text: remoteArtifact.content }],
        metadata: {
          runtime: "remote",
          remoteRunId: binding.remoteRunId,
          remoteArtifactId: remoteArtifact.id,
        },
      });
      this.emitMessage(run, thread, message);
    }

    const assignment = this.#store.listTaskAssignments().find(
      (item) => item.threadId === thread.id,
    );
    if (assignment) {
      const task = this.#store.getTask(assignment.taskId);
      const instance = this.#store.getAgentInstance(assignment.agentInstanceId);
      const existingArtifact = this.#store.listArtifacts(thread.projectId).find(
        (artifact) => artifact.runId === run.id,
      );
      if (task && instance && !existingArtifact) {
        this.#store.createArtifact({
          workspaceId: task.workspaceId,
          taskId: task.id,
          assignmentId: assignment.id,
          runId: run.id,
          agentInstanceId: instance.id,
          kind: "report",
          title: remoteArtifact.title,
          mimeType: remoteArtifact.mimeType,
          content: remoteArtifact.content,
          filePath: null,
        });
      }
    }
    this.#store.markRemoteRunResultImported(run.id);
  }

  async #createRemoteClient(runtimeNodeId: Id): Promise<RemoteRuntimeClient> {
    if (!this.#remoteClientFactory) {
      throw new Error("Remote Runtime client is unavailable in this build.");
    }
    const runtime = this.requireRuntimeNode(runtimeNodeId);
    if (runtime.kind !== "remote" || !runtime.baseUrl) {
      throw new Error("Remote Runtime configuration is invalid.");
    }
    const credentialRef = this.#store.getRuntimeCredentialRef(runtime.id);
    const token = credentialRef ? await this.#secrets.get(credentialRef) : null;
    if (!token) {
      throw new Error("Remote Runtime credential is missing.");
    }
    return this.#remoteClientFactory({ baseUrl: runtime.baseUrl, token });
  }

  async #executeNativeRun(input: {
    run: AgentRun;
    thread: AgentThread;
    project: Project;
    workspace: Workspace;
    profile: AgentProfile;
    provider: ProviderProfile;
    context: ContextRevision | null;
    controller: AbortController;
  }): Promise<void> {
    const {
      run,
      thread,
      project,
      workspace,
      profile,
      provider,
      context,
      controller,
    } = input;
    const sensitiveValues: string[] = [];
    const partial: PartialOutputState = {
      text: "",
      checkpointedLength: 0,
      checkpointedAt: 0,
    };
    try {
      this.emitStatus(this.#store.updateRunStatus(run.id, "preparing"));
      const apiKey = provider.apiKeyRef
        ? await this.#secrets.get(provider.apiKeyRef)
        : null;
      if (apiKey) {
        sensitiveValues.push(apiKey);
      }
      throwIfAborted(controller.signal);
      const credentials: ProviderCredentials = {
        protocol: provider.protocol,
        baseUrl: normalizeProviderBaseUrl(provider.baseUrl),
        apiKey,
        model: profile.modelOverride ?? provider.defaultModel,
        customHeaders: {},
      };
      const history = toModelMessages(
        this.#store.listThreadMessages(thread.id),
        profile,
        workspace,
        context,
      );
      this.emitStatus(this.#store.updateRunStatus(run.id, "running"));

      const runtime = new NativeAgentRuntime(
        this.#providerFactory(provider.protocol),
        workspace.localRootPath ? this.#tools : NO_TOOLS,
      );
      await runtime.run(
        {
          projectId: project.id,
          projectRoot: workspace.localRootPath ?? "",
          threadId: thread.id,
          runId: run.id,
          credentials,
          messages: history,
          executionProfile: run.configSnapshot.executionProfile,
          toolPolicy: run.configSnapshot.toolPolicy,
          onManagedExecutionEvent: (progress) => {
            this.emitManagedExecution(run, thread, progress);
          },
          signal: controller.signal,
        },
        this.createObserver(run, thread, controller.signal, partial),
      );
      throwIfAborted(controller.signal);
      this.emitStatus(this.#store.updateRunStatus(run.id, "completed"));
    } catch (error) {
      this.persistInterruptedText(run, thread, partial.text);
      const current = this.#store.getRun(run.id);
      if (!current || isTerminalStatus(current.status)) {
        return;
      }
      if (isHostShutdown(controller.signal)) {
        if (canTransitionRun(current.status, "interrupted")) {
          this.emitStatus(
            this.#store.updateRunStatus(
              run.id,
              "interrupted",
              HOST_SHUTDOWN_MESSAGE,
            ),
          );
        }
        return;
      }
      if (controller.signal.aborted) {
        if (canTransitionRun(current.status, "cancelling")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
        }
        const cancelling = this.#store.getRun(run.id);
        if (cancelling && canTransitionRun(cancelling.status, "cancelled")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelled"));
        }
        return;
      }
      const message = redactExactSecrets(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      );
      if (canTransitionRun(current.status, "failed")) {
        this.emitStatus(this.#store.updateRunStatus(run.id, "failed", message));
      }
    }
  }

  async #executeCliRun(input: {
    run: AgentRun;
    thread: AgentThread;
    project: Project;
    workspace: Workspace;
    profile: AgentProfile;
    context: ContextRevision | null;
    controller: AbortController;
  }): Promise<void> {
    const { run, thread, workspace, profile, context, controller } = input;
    const cliRunner = this.#cliRunner;
    const cliConfig = profile.cliConfig;
    if (!cliRunner || !cliConfig) {
      throw new Error("Local CLI Runs are not available in this build.");
    }
    if (!workspace.localRootPath) {
      throw new Error("Local CLI Agents require a Workspace with a local folder.");
    }

    const partial: PartialOutputState = {
      text: "",
      checkpointedLength: 0,
      checkpointedAt: 0,
    };
    try {
      this.emitStatus(this.#store.updateRunStatus(run.id, "preparing"));
      const prompt = buildCliPrompt(
        this.#store.listThreadMessages(thread.id),
        profile,
        workspace,
        context,
      );
      this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
      const result = await cliRunner.run({
        config: {
          ...cliConfig,
          cwd: null,
          env: {},
        },
        prompt,
        projectRoot: workspace.localRootPath,
        signal: controller.signal,
        onOutput: (output) => {
          if (output.stream !== "stdout") {
            return;
          }
          partial.text += output.chunk;
          this.checkpointPartial(run.id, partial);
          this.#publish({
            type: "assistant-delta",
            runId: run.id,
            threadId: thread.id,
            delta: output.chunk,
            at: new Date().toISOString(),
          });
        },
      });
      throwIfAborted(controller.signal);
      const text = result.stdout.trim()
        || "CLI Agent completed without text output.";
      const message = this.#store.appendMessage({
        threadId: thread.id,
        runId: run.id,
        role: "assistant",
        status: "committed",
        content: [{ type: "text", text }],
        metadata: { runtime: "local-cli" },
      });
      this.#store.clearRunPartial(run.id);
      resetPartialOutput(partial);
      this.#createRunArtifact(run, text);
      this.emitMessage(run, thread, message);
      this.emitStatus(this.#store.updateRunStatus(run.id, "completed"));
    } catch (error) {
      this.persistInterruptedText(run, thread, partial.text);
      const current = this.#store.getRun(run.id);
      if (!current || isTerminalStatus(current.status)) {
        return;
      }
      if (isHostShutdown(controller.signal)) {
        if (canTransitionRun(current.status, "interrupted")) {
          this.emitStatus(
            this.#store.updateRunStatus(
              run.id,
              "interrupted",
              HOST_SHUTDOWN_MESSAGE,
            ),
          );
        }
        return;
      }
      if (controller.signal.aborted || isCliAbort(error)) {
        if (canTransitionRun(current.status, "cancelling")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
        }
        const cancelling = this.#store.getRun(run.id);
        if (cancelling && canTransitionRun(cancelling.status, "cancelled")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelled"));
        }
        return;
      }
      const message = cliRunErrorMessage(error);
      if (canTransitionRun(current.status, "failed")) {
        this.emitStatus(this.#store.updateRunStatus(run.id, "failed", message));
      }
    }
  }

  createObserver(
    run: AgentRun,
    thread: AgentThread,
    signal: AbortSignal,
    partial: PartialOutputState,
  ): NativeAgentRunObserver {
    return {
      onTextDelta: (delta) => {
        partial.text += delta;
        this.checkpointPartial(run.id, partial);
        this.#publish({
          type: "assistant-delta",
          runId: run.id,
          threadId: thread.id,
          delta,
          at: new Date().toISOString(),
        });
      },
      onUsage: () => {},
      onAssistantTurn: async (turn) => {
        const callIds: Record<string, Id> = {};
        const blocks: MessageContentBlock[] = [];
        if (turn.content) {
          blocks.push({ type: "text", text: turn.content });
        }
        for (const call of turn.toolCalls) {
          const stored = this.#store.createToolCall(run.id, call);
          callIds[call.providerCallId] = stored.id;
          blocks.push({
            type: "tool-call",
            toolCallId: stored.id,
            providerCallId: call.providerCallId,
            name: call.name,
            arguments: call.arguments,
          });
          this.emitToolCall(run, thread, stored);
        }
        const message = this.#store.appendMessage({
          threadId: thread.id,
          runId: run.id,
          role: "assistant",
          status: "committed",
          content: blocks,
          metadata: { finishReason: turn.finishReason },
        });
        this.#store.clearRunPartial(run.id);
        resetPartialOutput(partial);
        if (turn.toolCalls.length === 0) {
          this.#createRunArtifact(run, turn.content);
        }
        this.emitMessage(run, thread, message);
        return callIds;
      },
      onToolCallStatus: (toolCallId, status, result) => {
        const toolCall = this.#store.updateToolCallStatus(
          toolCallId,
          status,
          result,
        );
        this.emitToolCall(run, thread, toolCall);
      },
      requestApproval: async ({ toolCallId, description }) => {
        throwIfAborted(signal);
        const approval = this.#store.createApproval(
          run.id,
          toolCallId,
          description,
        );
        this.#createRunInboxItem(run, "approval", {
          title: "等待工具审批",
          summary: description,
          approvalId: approval.id,
        });
        this.emitStatus(this.#store.updateRunStatus(run.id, "waiting-approval"));
        this.emitApproval(run, thread, approval, this.requireToolCall(toolCallId));
        const decision = await this.#approvals.wait(approval, signal);
        throwIfAborted(signal);
        const current = this.#store.getRun(run.id);
        if (current?.status === "waiting-approval") {
          this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
        }
        return decision;
      },
      requestInput: async ({ question }) => {
        throwIfAborted(signal);
        const inboxItem = this.#createRunInboxItem(run, "input-required", {
          title: "Agent 需要补充信息",
          summary: question,
        });
        if (!inboxItem) {
          throw new Error("Input requests require a Task assignment.");
        }
        this.emitStatus(this.#store.updateRunStatus(run.id, "waiting-input"));
        const answer = await this.#inputs.wait(run.id, signal);
        throwIfAborted(signal);
        const current = this.#store.getRun(run.id);
        if (current?.status === "waiting-input") {
          this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
        }
        return answer;
      },
      onToolResult: ({ toolCallId, providerCallId, name, result }) => {
        this.#createFileArtifactFromToolResult(run, toolCallId, name, result);
        const message = this.#store.appendMessage({
          threadId: thread.id,
          runId: run.id,
          role: "tool",
          status: "committed",
          content: [{
            type: "tool-result",
            toolCallId,
            providerCallId,
            name,
            output: result.output,
            isError: result.isError,
          }],
          metadata: {},
        });
        this.emitMessage(run, thread, message);
      },
    };
  }

  #createRunArtifact(run: AgentRun, content: string): Artifact | null {
    if (!content.trim()) {
      return null;
    }
    const assignment = this.#store.listTaskAssignments().find(
      (item) => item.threadId === run.threadId,
    );
    if (!assignment) {
      return null;
    }
    const task = this.#store.getTask(assignment.taskId);
    const instance = this.#store.getAgentInstance(assignment.agentInstanceId);
    if (!task || !instance) {
      return null;
    }
    const existing = this.#store.listArtifacts(task.workspaceId).find(
      (artifact) => artifact.runId === run.id,
    );
    if (existing) {
      return existing;
    }
    return this.#store.createArtifact({
      workspaceId: task.workspaceId,
      taskId: task.id,
      assignmentId: assignment.id,
      runId: run.id,
      agentInstanceId: instance.id,
      kind: "report",
      title: task.title,
      mimeType: "text/markdown",
      content,
      filePath: null,
    });
  }

  #createFileArtifactFromToolResult(
    run: AgentRun,
    toolCallId: Id,
    name: string,
    result: ToolExecutionResult,
  ): Artifact | null {
    if (name !== "write_file" || result.isError) {
      return null;
    }
    const toolCall = this.#store.getToolCall(toolCallId);
    const requestedPath = typeof toolCall?.arguments.path === "string"
      ? toolCall.arguments.path.trim()
      : "";
    const thread = this.#store.getThread(run.threadId);
    const workspace = thread ? this.#store.getWorkspace(thread.projectId) : null;
    const assignment = this.#store.listTaskAssignments().find(
      (item) => item.threadId === run.threadId,
    );
    if (!requestedPath || !thread || !workspace?.localRootPath || !assignment) {
      return null;
    }
    const rootPath = resolve(workspace.localRootPath);
    const filePath = resolve(rootPath, requestedPath);
    const workspaceRelativePath = relative(rootPath, filePath);
    if (
      !workspaceRelativePath ||
      /^\.\.(?:[\\/]|$)/.test(workspaceRelativePath) ||
      isAbsolute(workspaceRelativePath)
    ) {
      return null;
    }
    const existing = this.#store.listArtifacts(workspace.id).find(
      (artifact) =>
        artifact.runId === run.id &&
        artifact.kind === "file" &&
        artifact.filePath === filePath,
    );
    if (existing) {
      return existing;
    }
    return this.createArtifact({
      workspaceId: workspace.id,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      runId: run.id,
      agentInstanceId: assignment.agentInstanceId,
      kind: "file",
      title: basename(filePath),
      mimeType: mimeTypeForFile(filePath),
      content: null,
      filePath,
    });
  }

  #createRunInboxItem(
    run: AgentRun,
    kind: InboxItem["kind"],
    input: {
      title: string;
      summary: string;
      approvalId?: Id | null;
    },
  ): InboxItem | null {
    const assignment = this.#store.listTaskAssignments().find(
      (item) => item.threadId === run.threadId,
    );
    if (!assignment) {
      return null;
    }
    const task = this.#store.getTask(assignment.taskId);
    const instance = this.#store.getAgentInstance(assignment.agentInstanceId);
    if (!task || !instance) {
      return null;
    }
    const existing = this.#store.listInboxItems(task.workspaceId).find(
      (item) =>
        item.runId === run.id &&
        item.kind === kind &&
        item.approvalId === (input.approvalId ?? null),
    );
    if (existing) {
      return existing;
    }
    return this.#store.createInboxItem({
      workspaceId: task.workspaceId,
      kind,
      title: input.title,
      summary: input.summary,
      taskId: task.id,
      assignmentId: assignment.id,
      runId: run.id,
      approvalId: input.approvalId ?? null,
      agentInstanceId: instance.id,
    });
  }

  #syncCanonicalRunState(run: AgentRun): void {
    const assignment = this.#store.listTaskAssignments().find(
      (item) => item.threadId === run.threadId,
    );
    if (!assignment) {
      return;
    }
    let task = this.#store.getTask(assignment.taskId);
    if (!task) {
      return;
    }

    if (run.status === "waiting-input") {
      if (task.status === "running") {
        task = this.#store.updateTaskStatus(task.id, "waiting-input");
      }
      if (assignment.status !== "waiting-input") {
        this.#store.updateTaskAssignmentStatus(assignment.id, "waiting-input");
      }
      return;
    }

    if (["queued", "preparing", "running", "waiting-approval"].includes(run.status)) {
      if (task.status === "waiting-input") {
        task = this.#store.updateTaskStatus(task.id, "running");
      } else if (
        ["draft", "failed", "cancelled", "blocked", "completed"].includes(
          task.status,
        )
      ) {
        task = this.#store.updateTaskStatus(task.id, "ready");
      }
      if (task.status === "ready") {
        task = this.#store.updateTaskStatus(task.id, "running");
      }
      if (assignment.status !== "running") {
        this.#store.updateTaskAssignmentStatus(assignment.id, "running");
      }
      return;
    }

    const terminal = {
      completed: ["completed", "completed"],
      failed: ["failed", "failed"],
      cancelled: ["cancelled", "cancelled"],
      interrupted: ["blocked", "failed"],
    } as const;
    const target = terminal[run.status as keyof typeof terminal];
    if (!target) {
      return;
    }
    if (task.status !== target[0] && canTransitionTask(task.status, target[0])) {
      task = this.#store.updateTaskStatus(task.id, target[0]);
    }
    if (assignment.status !== target[1]) {
      this.#store.updateTaskAssignmentStatus(assignment.id, target[1]);
    }
    if (run.status === "completed") {
      this.#createRunInboxItem(run, "task-completed", {
        title: "任务已完成",
        summary: task.title,
      });
    } else if (run.status === "failed" || run.status === "interrupted") {
      this.#createRunInboxItem(run, "task-failed", {
        title: "任务需要处理",
        summary: run.error ?? task.title,
      });
    }
  }

  requireProject(projectId: Id): Project {
    const project = this.#store.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  requireWorkspace(workspaceId: Id): Workspace {
    const workspace = this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace;
  }

  requireRuntimeNode(runtimeNodeId: Id): RuntimeNode {
    const runtime = this.#store.getRuntimeNode(runtimeNodeId);
    if (!runtime) {
      throw new Error(`Runtime not found: ${runtimeNodeId}`);
    }
    return runtime;
  }

  requireAgentDefinition(agentDefinitionId: Id): AgentDefinition {
    const definition = this.#store.getAgentDefinition(agentDefinitionId);
    if (!definition) {
      throw new Error(`Agent definition not found: ${agentDefinitionId}`);
    }
    return definition;
  }

  requireAgentInstance(agentInstanceId: Id): AgentInstance {
    const instance = this.#store.getAgentInstance(agentInstanceId);
    if (!instance) {
      throw new Error(`Agent instance not found: ${agentInstanceId}`);
    }
    return instance;
  }

  requireTask(taskId: Id): WorkspaceTask {
    const task = this.#store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  requireProviderProfile(providerProfileId: Id): ProviderProfile {
    const provider = this.#store.getProviderProfile(providerProfileId);
    if (!provider) {
      throw new Error(`Provider Profile not found: ${providerProfileId}`);
    }
    return provider;
  }

  requireAgentProfile(agentProfileId: Id): AgentProfile {
    const profile = this.#store.getAgentProfile(agentProfileId);
    if (!profile) {
      throw new Error(`Agent Profile not found: ${agentProfileId}`);
    }
    return profile;
  }

  requireThread(threadId: Id): AgentThread {
    const thread = this.#store.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  requireRun(runId: Id): AgentRun {
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  requireToolCall(toolCallId: Id): ToolCallRecord {
    const toolCall = this.#store.getToolCall(toolCallId);
    if (!toolCall) {
      throw new Error(`Tool call not found: ${toolCallId}`);
    }
    return toolCall;
  }

  finalizeCancelledToolCalls(run: AgentRun, thread: AgentThread): void {
    const toolCalls = this.#store.cancelUnfinishedToolCallsForRun(run.id);
    const resultIds = new Set(
      this.#store.listThreadMessages(thread.id)
        .filter((message) => message.runId === run.id)
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool-result")
        .map((block) => block.toolCallId),
    );
    for (const toolCall of toolCalls) {
      if (toolCall.status !== "cancelled" || resultIds.has(toolCall.id)) {
        continue;
      }
      const message = this.#store.appendMessage({
        threadId: thread.id,
        runId: run.id,
        role: "tool",
        status: "interrupted",
        content: [{
          type: "tool-result",
          toolCallId: toolCall.id,
          providerCallId: toolCall.providerCallId,
          name: toolCall.name,
          output: "Tool call cancelled before completion.",
          isError: true,
        }],
        metadata: { synthetic: true },
      });
      this.emitMessage(run, thread, message);
    }
  }

  persistInterruptedText(
    run: AgentRun,
    thread: AgentThread,
    text: string,
  ): void {
    if (!text.trim()) {
      this.#store.clearRunPartial(run.id);
      return;
    }
    const message = this.#store.appendMessage({
      threadId: thread.id,
      runId: run.id,
      role: "assistant",
      status: "interrupted",
      content: [{ type: "text", text }],
      metadata: { partial: true },
    });
    this.#store.clearRunPartial(run.id);
    this.emitMessage(run, thread, message);
  }

  checkpointPartial(runId: Id, partial: PartialOutputState): void {
    const now = Date.now();
    if (
      !partial.text ||
      (
        partial.checkpointedLength > 0 &&
        now - partial.checkpointedAt < PARTIAL_CHECKPOINT_INTERVAL_MS &&
        partial.text.length - partial.checkpointedLength <
          PARTIAL_CHECKPOINT_CHARACTERS
      )
    ) {
      return;
    }
    this.#store.saveRunPartial(runId, partial.text);
    partial.checkpointedLength = partial.text.length;
    partial.checkpointedAt = now;
  }

  emitStatus(run: AgentRun): void {
    const event: RunEvent = {
      type: "run-status",
      runId: run.id,
      threadId: run.threadId,
      status: run.status,
      at: new Date().toISOString(),
      error: run.error ?? undefined,
    };
    this.#store.appendRunEvent(event);
    this.#syncCanonicalRunState(run);
    this.#publish(event);
  }

  emitMessage(run: AgentRun, thread: AgentThread, message: ThreadMessage): void {
    const event: RunEvent = {
      type: "message-created",
      runId: run.id,
      threadId: thread.id,
      message,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitToolCall(run: AgentRun, thread: AgentThread, toolCall: ToolCallRecord): void {
    const event: RunEvent = {
      type: "tool-call",
      runId: run.id,
      threadId: thread.id,
      toolCall,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitApproval(
    run: AgentRun,
    thread: AgentThread,
    approval: ToolApproval,
    toolCall: ToolCallRecord,
  ): void {
    const event: RunEvent = {
      type: "approval-required",
      runId: run.id,
      threadId: thread.id,
      approval,
      toolCall,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitManagedExecution(
    run: AgentRun,
    thread: AgentThread,
    progress: ManagedExecutionProgress,
  ): void {
    const event: RunEvent = {
      type: "managed-execution",
      runId: run.id,
      threadId: thread.id,
      progress,
      at: progress.at,
    };
    if (!progress.chunk) {
      this.#store.appendRunEvent(event);
    }
    this.#publish(event);
  }
}

class ApprovalWaiters {
  readonly #waiters = new Map<
    Id,
    {
      runId: Id;
      resolve: (decision: ApprovalDecision) => void;
      reject: (error: unknown) => void;
      removeAbortListener: () => void;
    }
  >();

  wait(approval: ToolApproval, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiters.delete(approval.id);
        reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.set(approval.id, {
        runId: approval.runId,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      });
      if (signal.aborted) {
        abort();
      }
    });
  }

  resolve(approvalId: Id, decision: ApprovalDecision): void {
    const waiter = this.#waiters.get(approvalId);
    if (!waiter) {
      return;
    }
    this.#waiters.delete(approvalId);
    waiter.removeAbortListener();
    waiter.resolve(decision);
  }

  cancelRun(runId: Id): void {
    for (const [approvalId, waiter] of this.#waiters) {
      if (waiter.runId === runId) {
        this.#waiters.delete(approvalId);
        waiter.removeAbortListener();
        waiter.reject(new DOMException("Run cancelled.", "AbortError"));
      }
    }
  }
}

class InputWaiters {
  readonly #waiters = new Map<
    Id,
    {
      resolve: (answer: string) => void;
      reject: (error: unknown) => void;
      removeAbortListener: () => void;
    }
  >();

  wait(runId: Id, signal: AbortSignal): Promise<string> {
    if (this.#waiters.has(runId)) {
      throw new Error("This Run already has an active input request.");
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiters.delete(runId);
        reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.set(runId, {
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      });
      if (signal.aborted) {
        abort();
      }
    });
  }

  has(runId: Id): boolean {
    return this.#waiters.has(runId);
  }

  resolve(runId: Id, answer: string): void {
    const waiter = this.#waiters.get(runId);
    if (!waiter) {
      throw new Error("This Run is not waiting for user input.");
    }
    this.#waiters.delete(runId);
    waiter.removeAbortListener();
    waiter.resolve(answer);
  }

  cancelRun(runId: Id): void {
    const waiter = this.#waiters.get(runId);
    if (!waiter) {
      return;
    }
    this.#waiters.delete(runId);
    waiter.removeAbortListener();
    waiter.reject(new DOMException("Run cancelled.", "AbortError"));
  }
}

function toModelMessages(
  messages: ThreadMessage[],
  profile: AgentProfile,
  workspace: Workspace,
  context: ContextRevision | null,
): ModelMessage[] {
  const systemSections = [
    profile.instructions.trim(),
    workspace.localRootPath
      ? `Local workspace folder: ${workspace.localRootPath}`
      : "",
    context
      ? `# Shared Workspace Context (revision ${context.version})\n${context.content}`
      : "",
    "Treat every other Thread as isolated. Use only the shared context shown above.",
  ].filter(Boolean);
  const result: ModelMessage[] = [{
    role: "system",
    content: systemSections.join("\n\n"),
  }];
  const pendingToolCalls = new Map<
    string,
    { name: string }
  >();

  const closePendingToolCalls = () => {
    for (const [providerCallId, call] of pendingToolCalls) {
      result.push({
        role: "tool",
        toolCallId: providerCallId,
        name: call.name,
        content: "Tool call cancelled before completion.",
        isError: true,
      });
    }
    pendingToolCalls.clear();
  };

  for (const message of takeRecentMessages(messages, 300_000, 50)) {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (message.role === "assistant") {
      closePendingToolCalls();
      const toolCalls = message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => ({
          id: block.providerCallId,
          name: block.name,
          arguments: block.arguments,
        }));
      result.push({
        role: "assistant",
        content: text,
        toolCalls,
      });
      for (const call of toolCalls) {
        pendingToolCalls.set(call.id, { name: call.name });
      }
    } else if (message.role === "tool") {
      for (const block of message.content) {
        if (
          block.type === "tool-result" &&
          pendingToolCalls.has(block.providerCallId)
        ) {
          result.push({
            role: "tool",
            toolCallId: block.providerCallId,
            name: block.name,
            content: block.output,
            isError: block.isError,
          });
          pendingToolCalls.delete(block.providerCallId);
        }
      }
    } else if (message.role === "system" || message.role === "user") {
      closePendingToolCalls();
      result.push({ role: message.role, content: text });
    }
  }
  closePendingToolCalls();
  return result;
}

function takeRecentMessages(
  messages: ThreadMessage[],
  characterBudget: number,
  countLimit: number,
): ThreadMessage[] {
  const selected: ThreadMessage[] = [];
  let characters = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < countLimit;
    index -= 1
  ) {
    const message = messages[index]!;
    const size = JSON.stringify(message.content).length;
    if (selected.length > 0 && characters + size > characterBudget) {
      break;
    }
    selected.push(message);
    characters += size;
  }
  return selected.reverse();
}

function buildCliPrompt(
  messages: ThreadMessage[],
  profile: AgentProfile,
  workspace: Workspace,
  context: ContextRevision | null,
): string {
  const transcript = messages.slice(-20).flatMap((message) => {
    const content = message.content.flatMap((block) => {
      if (block.type === "text") {
        return [block.text];
      }
      if (block.type === "tool-result") {
        return [`${block.name}: ${block.output}`];
      }
      return [];
    }).join("\n");
    if (!content.trim()) {
      return [];
    }
    const label = message.role === "assistant"
      ? "Agent"
      : message.role === "user"
        ? "User"
        : "Tool";
    return [`${label}: ${content}`];
  }).join("\n\n");
  const header = [
    profile.instructions.trim().slice(0, 30_000),
    workspace.localRootPath
      ? `Local workspace folder: ${workspace.localRootPath}`
      : "",
    context
      ? `# Shared Workspace Context (revision ${context.version})\n${
          context.content.slice(0, 40_000)
        }`
      : "",
  ].filter(Boolean);
  const headerText = header.join("\n\n");
  const transcriptBudget = Math.max(0, 100_000 - headerText.length - 18);
  const boundedTranscript = transcript.length > transcriptBudget
    ? transcript.slice(transcript.length - transcriptBudget)
    : transcript;
  return `${headerText}\n\n# Conversation\n${boundedTranscript}`;
}

function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function mimeTypeForFile(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function resetPartialOutput(partial: PartialOutputState): void {
  partial.text = "";
  partial.checkpointedLength = 0;
  partial.checkpointedAt = 0;
}

function isCliAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CLI_AGENT_ABORTED"
  );
}

function isHostShutdown(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    reason instanceof Error &&
    reason.name === HOST_SHUTDOWN_ABORT_NAME
  );
}

function isRemotePollShutdown(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    reason instanceof Error &&
    reason.name === REMOTE_POLL_SHUTDOWN_ABORT_NAME
  );
}

function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function cliRunErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "CLI_AGENT_PROCESS_FAILED"
  ) {
    const exitCode = "exitCode" in error && typeof error.exitCode === "number"
      ? error.exitCode
      : null;
    return exitCode === null
      ? "Local CLI Agent process failed."
      : `Local CLI Agent exited with code ${exitCode}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function providerToInput(
  provider: ProviderProfile,
): ProviderProfileInput & { id: Id } {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    customHeaders: {},
  };
}

function restoreRuntimeNode(
  store: WorkspaceStore,
  runtime: RuntimeNode | null,
  credentialRef: string | null,
): void {
  if (!runtime) {
    return;
  }
  store.saveRuntimeNode({
    id: runtime.id,
    name: runtime.name,
    kind: runtime.kind,
    baseUrl: runtime.baseUrl,
    credentialRef,
    status: runtime.status,
    capabilities: runtime.capabilities,
    lastSeenAt: runtime.lastSeenAt,
  });
}

function redactExactSecrets(value: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      value,
    );
}

function assertMaximumLength(
  value: string,
  maximum: number,
  field: string,
): void {
  if (value.length > maximum) {
    throw new Error(`${field} must not exceed ${maximum} characters.`);
  }
}

function effectiveToolPolicy(
  profile: AgentProfile["executionProfile"],
  configured: AgentToolPolicy,
): AgentToolPolicy {
  const permission = (value: AgentToolPolicy["writeFiles"]) => {
    if (value === "deny") return "deny" as const;
    return profile === "request-approval" ? "ask" as const : "allow" as const;
  };
  return {
    readFiles: configured.readFiles,
    writeFiles: permission(configured.writeFiles),
    runCommands: permission(configured.runCommands),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Run cancelled.", "AbortError");
  }
}
