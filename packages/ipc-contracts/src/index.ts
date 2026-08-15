import type {
  AgentDefinition,
  AgentHandoff,
  AgentInstance,
  AgentProfile,
  AgentRun,
  AgentThread,
  AgentToolPolicy,
  ApprovalDecision,
  Artifact,
  CliAgentConfig,
  ContextRevision,
  CreateAgentDefinitionInput,
  CreateAgentInstanceInput,
  CreateAgentProfileInput,
  CreateArtifactInput,
  CreateHandoffInput,
  CreateProjectInput,
  CreateScheduleInput,
  CreateTaskAssignmentInput,
  CreateTaskInput,
  CreateThreadInput,
  CreateWorkspaceInput,
  Id,
  InboxItem,
  Project,
  ProviderConnectionResult,
  ProviderProfile,
  ProviderProfileInput,
  ProviderProtocol,
  RuntimeConnectionResult,
  RuntimeNode,
  SaveRuntimeNodeInput,
  RunEvent,
  StartRunInput,
  TaskAssignment,
  TaskStatus,
  ThreadMessage,
  Workspace,
  WorkspaceSchedule,
  WorkspaceSnapshot,
  WorkspaceTask,
} from "@scopeguard/domain";
import type {
  ManagedExecutionEvent,
  ManagedExecutionRequest,
  ManagedExecutionResult,
} from "@scopeguard/managed-execution";

export const IPC_CHANNELS = {
  getWorkspaceSnapshot: "scopeguard:workspace:get-snapshot",
  createWorkspace: "scopeguard:workspace:create",
  saveRuntimeNode: "scopeguard:runtime:save",
  testRuntimeConnection: "scopeguard:runtime:test",
  createAgentDefinition: "scopeguard:agent-definition:create",
  createAgentInstance: "scopeguard:agent-instance:create",
  updateAgentInstanceRuntime: "scopeguard:agent-instance:update-runtime",
  createTask: "scopeguard:task:create",
  updateTaskStatus: "scopeguard:task:update-status",
  assignAgentToTask: "scopeguard:task:assign-agent",
  createArtifact: "scopeguard:artifact:create",
  getWorkspaceContext: "scopeguard:workspace-context:get",
  publishWorkspaceContext: "scopeguard:workspace-context:publish",
  createHandoff: "scopeguard:handoff:create",
  createSchedule: "scopeguard:schedule:create",
  resolveInboxItem: "scopeguard:inbox:resolve",
  chooseProjectDirectory: "scopeguard:project:choose-directory",
  addProject: "scopeguard:project:add",
  saveProviderProfile: "scopeguard:provider:save",
  deleteProviderProfile: "scopeguard:provider:delete",
  testProviderConnection: "scopeguard:provider:test",
  createAgentProfile: "scopeguard:agent-profile:create",
  createThread: "scopeguard:thread:create",
  listThreadMessages: "scopeguard:thread:list-messages",
  startRun: "scopeguard:run:start",
  cancelRun: "scopeguard:run:cancel",
  resolveApproval: "scopeguard:approval:resolve",
  getProjectContext: "scopeguard:context:get",
  updateProjectContext: "scopeguard:context:update",
  runEvent: "scopeguard:event:run",
} as const;

export type AgentHostMethod =
  | "getWorkspaceSnapshot"
  | "createWorkspace"
  | "saveRuntimeNode"
  | "testRuntimeConnection"
  | "createAgentDefinition"
  | "createAgentInstance"
  | "updateAgentInstanceRuntime"
  | "createTask"
  | "updateTaskStatus"
  | "assignAgentToTask"
  | "createArtifact"
  | "getWorkspaceContext"
  | "publishWorkspaceContext"
  | "createHandoff"
  | "createSchedule"
  | "resolveInboxItem"
  | "addProject"
  | "saveProviderProfile"
  | "deleteProviderProfile"
  | "testProviderConnection"
  | "createAgentProfile"
  | "createThread"
  | "listThreadMessages"
  | "startRun"
  | "cancelRun"
  | "resolveApproval"
  | "getProjectContext"
  | "updateProjectContext";

export type AgentHostRequest = {
  type: "host-request";
  requestId: string;
  method: AgentHostMethod;
  payload: unknown;
};

export type AgentHostResponse = {
  type: "host-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    name: string;
    message: string;
  };
};

export type AgentHostRunEvent = {
  type: "host-run-event";
  event: RunEvent;
};

export type AgentHostReady = {
  type: "host-ready";
  interruptedRuns: number;
};

export type AgentHostSecretRequest = {
  type: "host-secret-request";
  requestId: string;
  operation: "put" | "get" | "delete";
  reference: string;
  secret?: string;
};

export type AgentHostSecretResponse = {
  type: "host-secret-response";
  requestId: string;
  ok: boolean;
  reference?: string;
  secret?: string | null;
  error?: string;
};

export type AgentHostManagedExecutionRequest = {
  type: "host-managed-execution-request";
  requestId: string;
  request: ManagedExecutionRequest;
};

export type AgentHostManagedExecutionCancel = {
  type: "host-managed-execution-cancel";
  requestId: string;
};

export type AgentHostManagedExecutionEvent = {
  type: "host-managed-execution-event";
  requestId: string;
  event: ManagedExecutionEvent;
};

export type AgentHostManagedExecutionResponse = {
  type: "host-managed-execution-response";
  requestId: string;
  ok: boolean;
  result?: ManagedExecutionResult;
  error?: string;
};

export type AgentHostShutdownRequest = {
  type: "host-shutdown";
};

export type AgentHostToMainMessage =
  | AgentHostResponse
  | AgentHostRunEvent
  | AgentHostReady
  | AgentHostSecretRequest
  | AgentHostManagedExecutionRequest
  | AgentHostManagedExecutionCancel;

export type MainToAgentHostMessage =
  | AgentHostRequest
  | AgentHostSecretResponse
  | AgentHostManagedExecutionEvent
  | AgentHostManagedExecutionResponse
  | AgentHostShutdownRequest;

export type SaveProviderProfileRequest = ProviderProfileInput & {
  id?: Id;
  clearApiKey?: boolean;
};

export type UpdateTaskStatusRequest = {
  taskId: Id;
  status: TaskStatus;
};

export type UpdateAgentInstanceRuntimeRequest = {
  agentInstanceId: Id;
  runtimeNodeId: Id;
};

export type PublishWorkspaceContextRequest = {
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

export type UpdateProjectContextRequest = {
  projectId: Id;
  content: string;
  sourceThreadId?: Id;
  sourceRunId?: Id;
};

export type ResolveApprovalRequest = {
  approvalId: Id;
  decision: ApprovalDecision;
};

export type ProviderProfileView = Omit<ProviderProfile, "apiKeyRef"> & {
  hasApiKey: boolean;
};

export type DesktopWorkspaceSnapshot = Omit<
  WorkspaceSnapshot,
  "providerProfiles"
> & {
  providerProfiles: ProviderProfileView[];
};

export function toProviderProfileView(
  profile: ProviderProfile,
): ProviderProfileView {
  const { apiKeyRef, ...view } = profile;
  return {
    ...view,
    hasApiKey: Boolean(apiKeyRef),
  };
}

export function toDesktopWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
): DesktopWorkspaceSnapshot {
  return {
    ...snapshot,
    providerProfiles: snapshot.providerProfiles.map(toProviderProfileView),
  };
}

export type ScopeGuardDesktopApi = {
  getWorkspaceSnapshot: () => Promise<DesktopWorkspaceSnapshot>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
  saveRuntimeNode: (input: SaveRuntimeNodeInput) => Promise<RuntimeNode>;
  testRuntimeConnection: (
    runtimeNodeId: Id,
  ) => Promise<RuntimeConnectionResult>;
  createAgentDefinition: (
    input: CreateAgentDefinitionInput,
  ) => Promise<AgentDefinition>;
  createAgentInstance: (
    input: CreateAgentInstanceInput,
  ) => Promise<AgentInstance>;
  updateAgentInstanceRuntime: (
    input: UpdateAgentInstanceRuntimeRequest,
  ) => Promise<AgentInstance>;
  createTask: (input: CreateTaskInput) => Promise<WorkspaceTask>;
  updateTaskStatus: (
    request: UpdateTaskStatusRequest,
  ) => Promise<WorkspaceTask>;
  assignAgentToTask: (
    input: CreateTaskAssignmentInput,
  ) => Promise<TaskAssignment>;
  createArtifact: (input: CreateArtifactInput) => Promise<Artifact>;
  getWorkspaceContext: (workspaceId: Id) => Promise<ContextRevision | null>;
  publishWorkspaceContext: (
    input: PublishWorkspaceContextRequest,
  ) => Promise<ContextRevision>;
  createHandoff: (input: CreateHandoffInput) => Promise<AgentHandoff>;
  createSchedule: (input: CreateScheduleInput) => Promise<WorkspaceSchedule>;
  resolveInboxItem: (inboxItemId: Id) => Promise<InboxItem>;
  chooseProjectDirectory: () => Promise<{ canceled: boolean; rootPath?: string }>;
  addProject: (input: CreateProjectInput) => Promise<Project>;
  saveProviderProfile: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderProfileView>;
  deleteProviderProfile: (providerProfileId: Id) => Promise<void>;
  testProviderConnection: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderConnectionResult>;
  createAgentProfile: (input: CreateAgentProfileInput) => Promise<AgentProfile>;
  createThread: (input: CreateThreadInput) => Promise<AgentThread>;
  listThreadMessages: (threadId: Id) => Promise<ThreadMessage[]>;
  startRun: (input: StartRunInput) => Promise<AgentRun>;
  cancelRun: (runId: Id) => Promise<void>;
  resolveApproval: (
    approvalId: Id,
    decision: ApprovalDecision,
  ) => Promise<void>;
  getProjectContext: (projectId: Id) => Promise<ContextRevision | null>;
  updateProjectContext: (
    request: UpdateProjectContextRequest,
  ) => Promise<ContextRevision>;
  subscribeRunEvents: (listener: (event: RunEvent) => void) => () => void;
};

export function parseCreateWorkspaceInput(value: unknown): CreateWorkspaceInput {
  const record = requireRecord(value, "Workspace input");
  return {
    name: requireString(record.name, "name"),
    localRootPath: optionalNullableString(
      record.localRootPath,
      "localRootPath",
    ),
  };
}

export function parseSaveRuntimeNodeInput(value: unknown): SaveRuntimeNodeInput {
  const record = requireRecord(value, "Runtime input");
  const kind = record.kind;
  if (kind !== "local" && kind !== "remote") {
    throw new Error("kind must be local or remote.");
  }
  return {
    id: optionalString(record.id, "id"),
    name: requireString(record.name, "name"),
    kind,
    baseUrl: optionalNullableString(record.baseUrl, "baseUrl"),
    credential: optionalString(record.credential, "credential"),
    clearCredential: optionalBoolean(record.clearCredential, "clearCredential"),
  };
}

export function parseCreateAgentDefinitionInput(
  value: unknown,
): CreateAgentDefinitionInput {
  const record = requireRecord(value, "Agent definition input");
  return {
    name: requireString(record.name, "name"),
    description: optionalString(record.description, "description"),
    instructions: requireString(record.instructions, "instructions"),
    providerProfileId: optionalNullableString(
      record.providerProfileId,
      "providerProfileId",
    ),
    modelOverride: optionalNullableString(record.modelOverride, "modelOverride"),
    toolPolicy: parsePartialToolPolicy(record.toolPolicy),
  };
}

function parseExecutionProfile(
  value: unknown,
): CreateAgentProfileInput["executionProfile"] {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "request-approval" ||
    value === "auto-approve" ||
    value === "full-access"
  ) {
    return value;
  }
  return invalid(
    "executionProfile must be request-approval, auto-approve, or full-access.",
  );
}

export function parseCreateAgentInstanceInput(
  value: unknown,
): CreateAgentInstanceInput {
  const record = requireRecord(value, "Agent instance input");
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    agentDefinitionId: requireString(
      record.agentDefinitionId,
      "agentDefinitionId",
    ),
    runtimeNodeId: requireString(record.runtimeNodeId, "runtimeNodeId"),
    nameOverride: optionalNullableString(record.nameOverride, "nameOverride"),
  };
}

export function parseUpdateAgentInstanceRuntimeRequest(
  value: unknown,
): UpdateAgentInstanceRuntimeRequest {
  const record = requireRecord(value, "Agent Runtime input");
  return {
    agentInstanceId: requireNonEmptyString(
      record.agentInstanceId,
      "agentInstanceId",
    ),
    runtimeNodeId: requireNonEmptyString(record.runtimeNodeId, "runtimeNodeId"),
  };
}

export function parseCreateTaskInput(value: unknown): CreateTaskInput {
  const record = requireRecord(value, "Task input");
  const priority = record.priority;
  if (
    priority !== undefined &&
    priority !== "low" &&
    priority !== "normal" &&
    priority !== "high" &&
    priority !== "urgent"
  ) {
    throw new Error("priority must be low, normal, high, or urgent.");
  }
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    title: requireString(record.title, "title"),
    description: optionalString(record.description, "description"),
    priority,
  };
}

export function parseUpdateTaskStatusRequest(
  value: unknown,
): UpdateTaskStatusRequest {
  const record = requireRecord(value, "Task status input");
  return {
    taskId: requireString(record.taskId, "taskId"),
    status: parseTaskStatus(record.status),
  };
}

export function parseCreateTaskAssignmentInput(
  value: unknown,
): CreateTaskAssignmentInput {
  const record = requireRecord(value, "Task assignment input");
  const position = optionalInteger(record.position, "position");
  if (position !== undefined && position < 0) {
    throw new Error("position must not be negative.");
  }
  return {
    taskId: requireString(record.taskId, "taskId"),
    agentInstanceId: requireString(record.agentInstanceId, "agentInstanceId"),
    threadId: optionalNullableString(record.threadId, "threadId"),
    role: optionalString(record.role, "role"),
    position,
  };
}

export function parseCreateArtifactInput(value: unknown): CreateArtifactInput {
  const record = requireRecord(value, "Artifact input");
  const kind = record.kind;
  if (
    kind !== "text" &&
    kind !== "markdown" &&
    kind !== "report" &&
    kind !== "file"
  ) {
    throw new Error("kind must be text, markdown, report, or file.");
  }
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    taskId: requireString(record.taskId, "taskId"),
    assignmentId: optionalNullableString(record.assignmentId, "assignmentId"),
    runId: optionalNullableString(record.runId, "runId"),
    agentInstanceId: requireString(record.agentInstanceId, "agentInstanceId"),
    kind,
    title: requireString(record.title, "title"),
    mimeType: requireString(record.mimeType, "mimeType"),
    content: optionalNullableString(record.content, "content"),
    filePath: optionalNullableString(record.filePath, "filePath"),
  };
}

export function parsePublishWorkspaceContextRequest(
  value: unknown,
): PublishWorkspaceContextRequest {
  const record = requireRecord(value, "Workspace Context input");
  const scope = record.scope;
  if (scope !== undefined && scope !== "workspace" && scope !== "task") {
    throw new Error("scope must be workspace or task.");
  }
  const publishedBy = record.publishedBy;
  if (publishedBy !== "user" && publishedBy !== "agent") {
    throw new Error("publishedBy must be user or agent.");
  }
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    title: requireString(record.title, "title"),
    content: requireString(record.content, "content"),
    scope,
    taskId: optionalNullableString(record.taskId, "taskId"),
    sourceThreadId: optionalNullableString(record.sourceThreadId, "sourceThreadId"),
    sourceRunId: optionalNullableString(record.sourceRunId, "sourceRunId"),
    sourceAgentInstanceId: optionalNullableString(
      record.sourceAgentInstanceId,
      "sourceAgentInstanceId",
    ),
    sourceArtifactId: optionalNullableString(
      record.sourceArtifactId,
      "sourceArtifactId",
    ),
    publishedBy,
  };
}

export function parseCreateHandoffInput(value: unknown): CreateHandoffInput {
  const record = requireRecord(value, "Handoff input");
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    taskId: requireString(record.taskId, "taskId"),
    fromAgentInstanceId: requireString(
      record.fromAgentInstanceId,
      "fromAgentInstanceId",
    ),
    toAgentInstanceId: requireString(
      record.toAgentInstanceId,
      "toAgentInstanceId",
    ),
    sourceRunId: optionalNullableString(record.sourceRunId, "sourceRunId"),
    contextRevisionId: requireString(
      record.contextRevisionId,
      "contextRevisionId",
    ),
    summary: requireString(record.summary, "summary"),
  };
}

export function parseCreateScheduleInput(value: unknown): CreateScheduleInput {
  const record = requireRecord(value, "Schedule input");
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    agentInstanceId: requireString(record.agentInstanceId, "agentInstanceId"),
    title: requireString(record.title, "title"),
    prompt: requireString(record.prompt, "prompt"),
    cronExpression: requireString(record.cronExpression, "cronExpression"),
    timeZone: requireString(record.timeZone, "timeZone"),
    enabled: optionalBoolean(record.enabled, "enabled"),
  };
}

export function parseCreateProjectInput(value: unknown): CreateProjectInput {
  const record = requireRecord(value, "Project input");
  return {
    name: optionalString(record.name, "name"),
    rootPath: requireString(record.rootPath, "rootPath"),
  };
}

export function parseSaveProviderProfileRequest(
  value: unknown,
): SaveProviderProfileRequest {
  const record = requireRecord(value, "Provider input");
  return {
    id: optionalString(record.id, "id"),
    name: requireString(record.name, "name"),
    protocol: parseProviderProtocol(record.protocol),
    baseUrl: requireString(record.baseUrl, "baseUrl"),
    defaultModel: requireString(record.defaultModel, "defaultModel"),
    apiKey: optionalString(record.apiKey, "apiKey"),
    clearApiKey: optionalBoolean(record.clearApiKey, "clearApiKey"),
    customHeaders: parseStringRecord(record.customHeaders, "customHeaders"),
  };
}

export function parseCreateAgentProfileInput(
  value: unknown,
): CreateAgentProfileInput {
  const record = requireRecord(value, "Agent Profile input");
  const runtimeKind = record.runtimeKind === undefined
    ? undefined
    : record.runtimeKind === "native" || record.runtimeKind === "local-cli"
      ? record.runtimeKind
      : invalid("runtimeKind must be native or local-cli.");
  return {
    projectId: requireString(record.projectId, "projectId"),
    name: requireString(record.name, "name"),
    runtimeKind,
    runtimeNodeId: optionalString(record.runtimeNodeId, "runtimeNodeId"),
    instructions: requireString(record.instructions, "instructions"),
    providerProfileId: optionalNullableString(
      record.providerProfileId,
      "providerProfileId",
    ),
    modelOverride: optionalNullableString(record.modelOverride, "modelOverride"),
    executionProfile: parseExecutionProfile(record.executionProfile),
    toolPolicy: parsePartialToolPolicy(record.toolPolicy),
    cliConfig: parseCliConfig(record.cliConfig),
  };
}

export function parseCreateThreadInput(value: unknown): CreateThreadInput {
  const record = requireRecord(value, "Thread input");
  return {
    projectId: requireString(record.projectId, "projectId"),
    agentProfileId: requireString(record.agentProfileId, "agentProfileId"),
    title: optionalString(record.title, "title"),
  };
}

export function parseStartRunInput(value: unknown): StartRunInput {
  const record = requireRecord(value, "Run input");
  return {
    threadId: requireString(record.threadId, "threadId"),
    prompt: requireString(record.prompt, "prompt"),
  };
}

export function parseResolveApprovalRequest(
  value: unknown,
): ResolveApprovalRequest {
  const record = requireRecord(value, "Approval input");
  const decision = record.decision;
  if (decision !== "approved-once" && decision !== "denied") {
    throw new Error("decision must be approved-once or denied.");
  }
  return {
    approvalId: requireString(record.approvalId, "approvalId"),
    decision,
  };
}

export function parseUpdateProjectContextRequest(
  value: unknown,
): UpdateProjectContextRequest {
  const record = requireRecord(value, "Context input");
  return {
    projectId: requireString(record.projectId, "projectId"),
    content: requireString(record.content, "content"),
    sourceThreadId: optionalString(record.sourceThreadId, "sourceThreadId"),
    sourceRunId: optionalString(record.sourceRunId, "sourceRunId"),
  };
}

export function parseId(value: unknown, field = "id"): Id {
  return requireNonEmptyString(value, field);
}

export function parseManagedExecutionRequest(
  value: unknown,
): ManagedExecutionRequest {
  const record = requireRecord(value, "Managed execution request");
  const timeoutMs = record.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 300_000
  ) {
    throw new Error("timeoutMs must be an integer between 1000 and 300000.");
  }
  const command = requireNonEmptyString(record.command, "command");
  if (command.length > 100_000) {
    throw new Error("command exceeds 100000 characters.");
  }
  const environment = parseStringRecord(record.environment, "environment") ?? {};
  if (Object.keys(environment).length > 64) {
    throw new Error("environment exceeds 64 entries.");
  }
  return {
    executionId: requireNonEmptyString(record.executionId, "executionId"),
    projectId: requireNonEmptyString(record.projectId, "projectId"),
    threadId: requireNonEmptyString(record.threadId, "threadId"),
    runId: requireNonEmptyString(record.runId, "runId"),
    workspaceRoot: requireNonEmptyString(record.workspaceRoot, "workspaceRoot"),
    command,
    timeoutMs,
    environment,
  };
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === "string" &&
    [
      "run-status",
      "assistant-delta",
      "message-created",
      "tool-call",
      "approval-required",
      "managed-execution",
    ].includes(record.type) &&
    typeof record.runId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.at === "string"
  );
}

function parseProviderProtocol(value: unknown): ProviderProtocol {
  if (value === "openai-compatible" || value === "anthropic-compatible") {
    return value;
  }
  throw new Error(
    "protocol must be openai-compatible or anthropic-compatible.",
  );
}

function parseTaskStatus(value: unknown): TaskStatus {
  if (
    value === "draft" ||
    value === "ready" ||
    value === "running" ||
    value === "waiting-input" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "archived"
  ) {
    return value;
  }
  throw new Error("status is not a valid Task status.");
}

function parsePartialToolPolicy(
  value: unknown,
): Partial<AgentToolPolicy> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, "toolPolicy");
  return Object.fromEntries(
    (["readFiles", "writeFiles", "runCommands"] as const).flatMap((key) => {
      const permission = record[key];
      if (permission === undefined) {
        return [];
      }
      if (permission !== "allow" && permission !== "ask" && permission !== "deny") {
        throw new Error(`${key} must be allow, ask, or deny.`);
      }
      return [[key, permission]];
    }),
  );
}

function parseCliConfig(value: unknown): CliAgentConfig | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, "cliConfig");
  const rawArgs = record.args;
  if (!Array.isArray(rawArgs) || rawArgs.some((item) => typeof item !== "string")) {
    throw new Error("cliConfig.args must be an array of strings.");
  }
  return {
    command: requireString(record.command, "cliConfig.command"),
    args: rawArgs,
    cwd: optionalNullableString(record.cwd, "cliConfig.cwd") ?? null,
    env: parseStringRecord(record.env, "cliConfig.env") ?? {},
  };
}

function parseStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, field);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new Error(`${field}.${key} must be a string.`);
    }
  }
  return record as Record<string, string>;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!result.trim()) {
    throw new Error(`${field} must not be empty.`);
  }
  return result;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function optionalNullableString(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return requireString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(message);
}
