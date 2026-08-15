export const SCOPEGUARD_SCHEMA_VERSION = 9;

export type Id = string;
export type IsoDateTime = string;

export type Workspace = {
  id: Id;
  name: string;
  localRootPath: string | null;
  currentContextRevisionId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  lastOpenedAt: IsoDateTime;
};

export type CreateWorkspaceInput = {
  name: string;
  localRootPath?: string | null;
};

export type ProviderProtocol = "openai-compatible" | "anthropic-compatible";

export type Project = {
  id: Id;
  name: string;
  rootPath: string;
  currentContextRevisionId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  lastOpenedAt: IsoDateTime;
};

export type ProviderProfile = {
  id: Id;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  apiKeyRef: string | null;
  customHeaders: Record<string, string>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type ProviderProfileInput = {
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
};

export type ProviderConnectionResult = {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
};

export type ToolPermission = "allow" | "ask" | "deny";

export type ConversationExecutionProfile =
  | "request-approval"
  | "auto-approve"
  | "full-access";

export type ManagedExecutionStage =
  | "accepted"
  | "provisioning"
  | "running"
  | "stopping"
  | "cleaning"
  | "completed"
  | "failed";

export type ManagedExecutionProgress = {
  executionId: Id;
  stage: ManagedExecutionStage;
  at: IsoDateTime;
  stream?: "stdout" | "stderr";
  chunk?: string;
};

export type AgentToolPolicy = {
  readFiles: ToolPermission;
  writeFiles: ToolPermission;
  runCommands: ToolPermission;
};

export const DEFAULT_AGENT_TOOL_POLICY: AgentToolPolicy = {
  readFiles: "allow",
  writeFiles: "ask",
  runCommands: "ask",
};

export type AgentRuntimeKind = "native" | "local-cli";

export type CliAgentConfig = {
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
};

export type AgentProfile = {
  id: Id;
  projectId: Id;
  name: string;
  runtimeKind: AgentRuntimeKind;
  instructions: string;
  providerProfileId: Id | null;
  modelOverride: string | null;
  executionProfile: ConversationExecutionProfile;
  toolPolicy: AgentToolPolicy;
  cliConfig: CliAgentConfig | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type AgentDefinition = {
  id: Id;
  name: string;
  description: string;
  instructions: string;
  providerProfileId: Id | null;
  modelOverride: string | null;
  toolPolicy: AgentToolPolicy;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateAgentDefinitionInput = {
  name: string;
  description?: string;
  instructions: string;
  providerProfileId?: Id | null;
  modelOverride?: string | null;
  toolPolicy?: Partial<AgentToolPolicy>;
};

export type AgentInstanceStatus =
  | "idle"
  | "running"
  | "waiting"
  | "offline"
  | "disabled";

export type AgentInstance = {
  id: Id;
  workspaceId: Id;
  agentDefinitionId: Id;
  runtimeNodeId: Id;
  nameOverride: string | null;
  status: AgentInstanceStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateAgentInstanceInput = {
  workspaceId: Id;
  agentDefinitionId: Id;
  runtimeNodeId: Id;
  nameOverride?: string | null;
};

export type RuntimeNodeKind = "local" | "remote";
export type RuntimeNodeStatus = "online" | "offline" | "unknown";

export type RuntimeCapabilities = {
  nativeAgents: boolean;
  cliAgents: boolean;
  fileTools: boolean;
  commandTools: boolean;
  persistentRuns: boolean;
};

export type RuntimeNode = {
  id: Id;
  name: string;
  kind: RuntimeNodeKind;
  baseUrl: string | null;
  hasCredential: boolean;
  status: RuntimeNodeStatus;
  capabilities: RuntimeCapabilities;
  lastSeenAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type SaveRuntimeNodeInput = {
  id?: Id;
  name: string;
  kind: RuntimeNodeKind;
  baseUrl?: string | null;
  credential?: string;
  clearCredential?: boolean;
};

export type RuntimeConnectionResult = {
  ok: true;
  latencyMs: number;
  status: "online";
  capabilities: RuntimeCapabilities;
  message: string;
};

export type TaskStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting-input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type WorkspaceTask = {
  id: Id;
  workspaceId: Id;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
};

export type CreateTaskInput = {
  workspaceId: Id;
  title: string;
  description?: string;
  priority?: TaskPriority;
};

export type AssignmentStatus =
  | "pending"
  | "running"
  | "waiting-input"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskAssignment = {
  id: Id;
  taskId: Id;
  agentInstanceId: Id;
  threadId: Id | null;
  role: string;
  position: number;
  status: AssignmentStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateTaskAssignmentInput = {
  taskId: Id;
  agentInstanceId: Id;
  threadId?: Id | null;
  role?: string;
  position?: number;
};

export type ArtifactKind = "text" | "markdown" | "report" | "file";

export type Artifact = {
  id: Id;
  workspaceId: Id;
  taskId: Id;
  assignmentId: Id | null;
  runId: Id | null;
  agentInstanceId: Id;
  kind: ArtifactKind;
  title: string;
  mimeType: string;
  content: string | null;
  filePath: string | null;
  version: number;
  createdAt: IsoDateTime;
};

export type CreateArtifactInput = {
  workspaceId: Id;
  taskId: Id;
  assignmentId?: Id | null;
  runId?: Id | null;
  agentInstanceId: Id;
  kind: ArtifactKind;
  title: string;
  mimeType: string;
  content?: string | null;
  filePath?: string | null;
};

export type HandoffStatus = "pending" | "accepted" | "rejected";

export type AgentHandoff = {
  id: Id;
  workspaceId: Id;
  taskId: Id;
  fromAgentInstanceId: Id;
  toAgentInstanceId: Id;
  sourceRunId: Id | null;
  contextRevisionId: Id;
  summary: string;
  status: HandoffStatus;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
};

export type CreateHandoffInput = {
  workspaceId: Id;
  taskId: Id;
  fromAgentInstanceId: Id;
  toAgentInstanceId: Id;
  sourceRunId?: Id | null;
  contextRevisionId: Id;
  summary: string;
};

export type WorkspaceSchedule = {
  id: Id;
  workspaceId: Id;
  agentInstanceId: Id;
  title: string;
  prompt: string;
  cronExpression: string;
  timeZone: string;
  enabled: boolean;
  nextRunAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateScheduleInput = {
  workspaceId: Id;
  agentInstanceId: Id;
  title: string;
  prompt: string;
  cronExpression: string;
  timeZone: string;
  enabled?: boolean;
};

export type InboxItemKind =
  | "approval"
  | "task-failed"
  | "task-completed"
  | "input-required"
  | "runtime-offline";

export type InboxItemStatus = "unread" | "read" | "resolved";

export type InboxItem = {
  id: Id;
  workspaceId: Id;
  kind: InboxItemKind;
  status: InboxItemStatus;
  title: string;
  summary: string;
  taskId: Id | null;
  assignmentId: Id | null;
  runId: Id | null;
  approvalId: Id | null;
  agentInstanceId: Id | null;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
};

export type CreateInboxItemInput = Omit<
  InboxItem,
  "id" | "status" | "createdAt" | "resolvedAt"
>;

export type AgentThread = {
  id: Id;
  projectId: Id;
  agentProfileId: Id;
  title: string;
  status: "active" | "archived";
  modelOverride: string | null;
  executionProfile: ConversationExecutionProfile;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool-call";
      toolCallId: Id;
      providerCallId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      toolCallId: Id;
      providerCallId: string;
      name: string;
      output: string;
      isError: boolean;
    };

export type ThreadMessage = {
  id: Id;
  threadId: Id;
  runId: Id | null;
  sequence: number;
  role: MessageRole;
  status: "committed" | "interrupted";
  content: MessageContentBlock[];
  metadata: Record<string, unknown>;
  createdAt: IsoDateTime;
};

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting-approval"
  | "waiting-input"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunConfigSnapshot = {
  agentProfileId: Id;
  runtimeKind: AgentRuntimeKind;
  providerProfileId: Id | null;
  providerProtocol: ProviderProtocol | null;
  providerBaseUrl: string | null;
  model: string | null;
  instructions: string;
  executionProfile: ConversationExecutionProfile;
  toolPolicy: AgentToolPolicy;
  cliConfig: CliAgentConfig | null;
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ModelToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
    };

export type RunRequestManifest = {
  runId: Id;
  stepSequence: number;
  providerProtocol: ProviderProtocol;
  model: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  maxOutputTokens: number | null;
  requestHash: string;
  createdAt: IsoDateTime;
};

export type RunUsageRecord = {
  runId: Id;
  sequence: number;
  stepSequence: number;
  source: "provider";
  status: "reported" | "unavailable";
  inputTokens: number | null;
  outputTokens: number | null;
  receivedAt: IsoDateTime;
};

export type AgentRun = {
  id: Id;
  threadId: Id;
  triggerMessageId: Id;
  contextRevisionId: Id | null;
  configSnapshot: RunConfigSnapshot;
  status: RunStatus;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  error: string | null;
  createdAt: IsoDateTime;
};

export type RemoteRunBinding = {
  runId: Id;
  runtimeNodeId: Id;
  remoteRunId: Id;
  lastSequence: number;
  resultImportedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type ToolCallStatus =
  | "proposed"
  | "awaiting-approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

export type ToolCallRecord = {
  id: Id;
  runId: Id;
  sequence: number;
  providerCallId: string;
  name: string;
  description: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  output: string | null;
  error: string | null;
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
};

export type ApprovalDecision = "approved-once" | "denied";

export type ToolApproval = {
  id: Id;
  toolCallId: Id;
  runId: Id;
  status: "pending" | "approved" | "denied" | "expired";
  reason: string;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
};

export type PendingApprovalItem = {
  approval: ToolApproval;
  toolCall: ToolCallRecord;
};

export type ContextRevision = {
  id: Id;
  workspaceId: Id;
  /** Temporary v2 compatibility alias. */
  projectId: Id;
  version: number;
  parentId: Id | null;
  scope: "workspace" | "task";
  taskId: Id | null;
  title: string;
  content: string;
  sourceThreadId: Id | null;
  sourceRunId: Id | null;
  sourceAgentInstanceId: Id | null;
  sourceArtifactId: Id | null;
  publishedBy: "user" | "agent";
  createdAt: IsoDateTime;
};

export type ContextRevisionUse = {
  contextRevisionId: Id;
  runId: Id;
  usedAt: IsoDateTime;
};

export type RunEvent =
  | {
      type: "run-status";
      runId: Id;
      threadId: Id;
      status: RunStatus;
      at: IsoDateTime;
      error?: string;
    }
  | {
      type: "assistant-delta";
      runId: Id;
      threadId: Id;
      delta: string;
      at: IsoDateTime;
    }
  | {
      type: "message-created";
      runId: Id;
      threadId: Id;
      message: ThreadMessage;
      at: IsoDateTime;
    }
  | {
      type: "tool-call";
      runId: Id;
      threadId: Id;
      toolCall: ToolCallRecord;
      at: IsoDateTime;
    }
  | {
      type: "approval-required";
      runId: Id;
      threadId: Id;
      approval: ToolApproval;
      toolCall: ToolCallRecord;
      at: IsoDateTime;
    }
  | {
      type: "managed-execution";
      runId: Id;
      threadId: Id;
      progress: ManagedExecutionProgress;
      at: IsoDateTime;
    };

export type WorkspaceSnapshot = {
  workspaces: Workspace[];
  runtimeNodes: RuntimeNode[];
  agentDefinitions: AgentDefinition[];
  agentInstances: AgentInstance[];
  tasks: WorkspaceTask[];
  assignments: TaskAssignment[];
  artifacts: Artifact[];
  handoffs: AgentHandoff[];
  schedules: WorkspaceSchedule[];
  inboxItems: InboxItem[];
  /** Temporary v2 compatibility collections used by the current renderer. */
  projects: Project[];
  providerProfiles: ProviderProfile[];
  agentProfiles: AgentProfile[];
  threads: AgentThread[];
  activeRuns: AgentRun[];
  recentRuns: AgentRun[];
  pendingApprovals: PendingApprovalItem[];
};

export function countWorkspacePendingAttention(input: {
  workspaceId: Id | null;
  threads: ReadonlyArray<Pick<AgentThread, "id" | "projectId">>;
  runs: ReadonlyArray<Pick<AgentRun, "id" | "threadId">>;
  approvals: ReadonlyArray<{
    approval: Pick<ToolApproval, "runId">;
  }>;
  inboxItems: ReadonlyArray<
    Pick<InboxItem, "workspaceId" | "status" | "kind">
  >;
}): number {
  if (!input.workspaceId) {
    return 0;
  }
  const threadIds = new Set(
    input.threads
      .filter((thread) => thread.projectId === input.workspaceId)
      .map((thread) => thread.id),
  );
  const runIds = new Set(
    input.runs
      .filter((run) => threadIds.has(run.threadId))
      .map((run) => run.id),
  );
  const approvals = input.approvals.filter(
    (item) => runIds.has(item.approval.runId),
  ).length;
  const inboxItems = input.inboxItems.filter(
    (item) =>
      item.workspaceId === input.workspaceId &&
      item.status !== "resolved" &&
      item.kind !== "approval",
  ).length;
  return approvals + inboxItems;
}

export type CreateProjectInput = {
  name?: string;
  rootPath: string;
};

export type CreateAgentProfileInput = {
  projectId: Id;
  name: string;
  runtimeKind?: AgentRuntimeKind;
  runtimeNodeId?: Id;
  instructions: string;
  providerProfileId?: Id | null;
  modelOverride?: string | null;
  executionProfile?: ConversationExecutionProfile;
  toolPolicy?: Partial<AgentToolPolicy>;
  cliConfig?: CliAgentConfig | null;
};

export type CreateThreadInput = {
  projectId: Id;
  agentProfileId: Id;
  title?: string;
};

export type UpdateThreadSettingsInput = {
  threadId: Id;
  modelOverride?: string | null;
  executionProfile?: ConversationExecutionProfile;
};

export type StartRunInput = {
  threadId: Id;
  prompt: string;
};

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(["ready", "cancelled", "archived"]),
  ready: new Set(["running", "cancelled", "archived"]),
  running: new Set([
    "waiting-input",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ]),
  "waiting-input": new Set(["running", "blocked", "cancelled"]),
  blocked: new Set(["ready", "running", "cancelled", "archived"]),
  completed: new Set(["ready", "archived"]),
  failed: new Set(["ready", "archived"]),
  cancelled: new Set(["ready", "archived"]),
  archived: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].has(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
  }
}

const RUN_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["preparing", "cancelling", "cancelled", "failed", "interrupted"]),
  preparing: new Set(["running", "cancelling", "failed", "interrupted"]),
  running: new Set([
    "waiting-approval",
    "waiting-input",
    "cancelling",
    "completed",
    "failed",
    "interrupted",
  ]),
  "waiting-approval": new Set(["running", "cancelling", "failed", "interrupted"]),
  "waiting-input": new Set(["running", "cancelling", "failed", "interrupted"]),
  cancelling: new Set(["completed", "cancelled", "failed", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].has(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}

export function normalizeProviderBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Base URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a valid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "Base URL must not contain credentials; use the API key field instead.",
    );
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function validateProviderProfileInput(input: ProviderProfileInput): ProviderProfileInput {
  const name = input.name.trim();
  const defaultModel = input.defaultModel.trim();
  if (!name) {
    throw new Error("Provider name is required.");
  }
  if (!defaultModel) {
    throw new Error("Model is required.");
  }
  assertMaximumLength(name, 200, "Provider name");
  assertMaximumLength(input.baseUrl, 4096, "Provider Base URL");
  assertMaximumLength(defaultModel, 512, "Model");
  if (input.apiKey) {
    assertMaximumLength(input.apiKey, 16_384, "API key");
  }

  const customHeaders = Object.fromEntries(
    Object.entries(input.customHeaders ?? {})
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );

  return {
    ...input,
    name,
    baseUrl: normalizeProviderBaseUrl(input.baseUrl),
    defaultModel,
    apiKey: input.apiKey?.trim() || undefined,
    customHeaders,
  };
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

export function mergeToolPolicy(
  overrides: Partial<AgentToolPolicy> | undefined,
): AgentToolPolicy {
  return {
    ...DEFAULT_AGENT_TOOL_POLICY,
    ...overrides,
  };
}
