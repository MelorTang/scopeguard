import type {
  AgentProfile,
  AgentRun,
  AgentThread,
  AgentToolPolicy,
  ApprovalDecision,
  CliAgentConfig,
  ContextRevision,
  CreateAgentProfileInput,
  CreateProjectInput,
  CreateThreadInput,
  Id,
  Project,
  ProviderConnectionResult,
  ProviderProfile,
  ProviderProfileInput,
  ProviderProtocol,
  RunEvent,
  StartRunInput,
  ThreadMessage,
  WorkspaceSnapshot,
} from "@scopeguard/domain";

export const IPC_CHANNELS = {
  getWorkspaceSnapshot: "scopeguard:workspace:get-snapshot",
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

export type AgentHostShutdownRequest = {
  type: "host-shutdown";
};

export type AgentHostToMainMessage =
  | AgentHostResponse
  | AgentHostRunEvent
  | AgentHostReady
  | AgentHostSecretRequest;

export type MainToAgentHostMessage =
  | AgentHostRequest
  | AgentHostSecretResponse
  | AgentHostShutdownRequest;

export type SaveProviderProfileRequest = ProviderProfileInput & {
  id?: Id;
  clearApiKey?: boolean;
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

export type ScopeGuardDesktopApi = {
  getWorkspaceSnapshot: () => Promise<WorkspaceSnapshot>;
  chooseProjectDirectory: () => Promise<{ canceled: boolean; rootPath?: string }>;
  addProject: (input: CreateProjectInput) => Promise<Project>;
  saveProviderProfile: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderProfile>;
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
    instructions: requireString(record.instructions, "instructions"),
    providerProfileId: optionalNullableString(
      record.providerProfileId,
      "providerProfileId",
    ),
    modelOverride: optionalNullableString(record.modelOverride, "modelOverride"),
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
  return requireString(value, field);
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

function invalid(message: string): never {
  throw new Error(message);
}
