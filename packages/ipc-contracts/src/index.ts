import { parseDispatchPrompt, parseWorkspaceLayout } from "@scopeguard/domain";
import type {
  Agent,
  AgentRun,
  AgentToolPolicy,
  ApprovalDecision,
  Conversation,
  ConversationMessage,
  CreateAgentInput,
  CreateConversationInput,
  CreateDispatchInput,
  CreateWorkspaceInput,
  Id,
  Dispatch,
  HandoffPrompt,
  HandoffPromptRequest,
  ProviderConnectionResult,
  ProviderProfile,
  ProviderProfileInput,
  ProviderProtocol,
  RunEvent,
  StartRunInput,
  UpdateConversationSettingsInput,
  Workspace,
  WorkspaceLayout,
  WorkspaceContextRevision,
  WorkspaceSnapshot,
} from "@scopeguard/domain";

export const IPC_CHANNELS = {
  getWorkspaceSnapshot: "scopeguard:workspace:get-snapshot",
  createWorkspace: "scopeguard:workspace:create",
  chooseWorkspaceDirectory: "scopeguard:workspace:choose-directory",
  chooseWorkspaceFiles: "scopeguard:workspace:choose-files",
  saveProviderProfile: "scopeguard:provider:save",
  deleteProviderProfile: "scopeguard:provider:delete",
  testProviderConnection: "scopeguard:provider:test",
  createAgent: "scopeguard:agent:create",
  createConversation: "scopeguard:conversation:create",
  updateConversationSettings: "scopeguard:conversation:update-settings",
  getWorkspaceLayout: "scopeguard:layout:get",
  stageWorkspaceLayout: "scopeguard:layout:stage",
  flushWorkspaceLayouts: "scopeguard:layout:flush",
  saveWorkspaceLayout: "scopeguard:layout:save",
  listConversationMessages: "scopeguard:conversation:list-messages",
  startRun: "scopeguard:run:start",
  cancelRun: "scopeguard:run:cancel",
  resolveApproval: "scopeguard:approval:resolve",
  createDispatch: "scopeguard:dispatch:create",
  listDispatches: "scopeguard:dispatch:list",
  executeDispatch: "scopeguard:dispatch:execute",
  generateHandoffPrompt: "scopeguard:handoff:generate",
  copyHandoffPrompt: "scopeguard:handoff:copy",
  getWorkspaceContext: "scopeguard:context:get",
  updateWorkspaceContext: "scopeguard:context:update",
  runEvent: "scopeguard:event:run",
} as const;

export type StageWorkspaceLayoutResult =
  | { accepted: true }
  | { accepted: false; reason: "quiescing" };

export type AgentHostMethod =
  | "getWorkspaceSnapshot"
  | "createWorkspace"
  | "saveProviderProfile"
  | "deleteProviderProfile"
  | "testProviderConnection"
  | "createAgent"
  | "createConversation"
  | "updateConversationSettings"
  | "getWorkspaceLayout"
  | "saveWorkspaceLayout"
  | "listConversationMessages"
  | "startRun"
  | "cancelRun"
  | "resolveApproval"
  | "createDispatch"
  | "listDispatches"
  | "executeDispatch"
  | "generateHandoffPrompt"
  | "getWorkspaceContext"
  | "updateWorkspaceContext";

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
  error?: { name: string; message: string };
};

export type AgentHostRunEvent = { type: "host-run-event"; event: RunEvent };
export type AgentHostReady = {
  type: "host-ready";
  interruptedRuns: number;
  interruptedDispatches: number;
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
export type AgentHostShutdownRequest = { type: "host-shutdown" };

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

export type ResolveApprovalRequest = {
  approvalId: Id;
  decision: ApprovalDecision;
};

export type UpdateWorkspaceContextRequest = {
  workspaceId: Id;
  content: string;
  sourceConversationId?: Id | null;
  sourceRunId?: Id | null;
};

export type WorkspaceFileSelection = { name: string; relativePath: string };
export type ChooseWorkspaceFilesResult = {
  canceled: boolean;
  files: WorkspaceFileSelection[];
};

export type ProviderProfileView = Omit<ProviderProfile, "apiKeyRef"> & {
  hasApiKey: boolean;
};
export type DesktopWorkspaceSnapshot = Omit<WorkspaceSnapshot, "providerProfiles"> & {
  providerProfiles: ProviderProfileView[];
};

export function toProviderProfileView(profile: ProviderProfile): ProviderProfileView {
  const { apiKeyRef, ...view } = profile;
  return { ...view, hasApiKey: Boolean(apiKeyRef) };
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
  chooseWorkspaceDirectory: () => Promise<{
    canceled: boolean;
    localRootPath?: string;
  }>;
  chooseWorkspaceFiles: (workspaceId: Id) => Promise<ChooseWorkspaceFilesResult>;
  saveProviderProfile: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderProfileView>;
  deleteProviderProfile: (providerProfileId: Id) => Promise<void>;
  testProviderConnection: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderConnectionResult>;
  createAgent: (input: CreateAgentInput) => Promise<Agent>;
  createConversation: (input: CreateConversationInput) => Promise<Conversation>;
  updateConversationSettings: (
    input: UpdateConversationSettingsInput,
  ) => Promise<Conversation>;
  getWorkspaceLayout: (workspaceId: Id) => Promise<WorkspaceLayout | null>;
  stageWorkspaceLayout: (layout: WorkspaceLayout) => Promise<StageWorkspaceLayoutResult>;
  flushWorkspaceLayouts: () => Promise<void>;
  saveWorkspaceLayout: (layout: WorkspaceLayout) => Promise<WorkspaceLayout>;
  listConversationMessages: (
    conversationId: Id,
  ) => Promise<ConversationMessage[]>;
  startRun: (input: StartRunInput) => Promise<AgentRun>;
  cancelRun: (runId: Id) => Promise<void>;
  resolveApproval: (
    approvalId: Id,
    decision: ApprovalDecision,
  ) => Promise<void>;
  createDispatch: (input: CreateDispatchInput) => Promise<Dispatch>;
  listDispatches: (workspaceId: Id) => Promise<Dispatch[]>;
  executeDispatch: (dispatchId: Id) => Promise<Dispatch>;
  generateHandoffPrompt: (input: HandoffPromptRequest) => Promise<HandoffPrompt>;
  copyHandoffPrompt: (text: string) => Promise<void>;
  getWorkspaceContext: (
    workspaceId: Id,
  ) => Promise<WorkspaceContextRevision | null>;
  updateWorkspaceContext: (
    request: UpdateWorkspaceContextRequest,
  ) => Promise<WorkspaceContextRevision>;
  subscribeRunEvents: (listener: (event: RunEvent) => void) => () => void;
};

export function parseCreateWorkspaceInput(value: unknown): CreateWorkspaceInput {
  const record = requireRecord(value, "Workspace input");
  return {
    name: requireString(record.name, "name"),
    localRootPath: optionalNullableString(record.localRootPath, "localRootPath"),
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

export function parseCreateAgentInput(value: unknown): CreateAgentInput {
  const record = requireRecord(value, "Agent input");
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    name: requireString(record.name, "name"),
    instructions: requireString(record.instructions, "instructions"),
    providerProfileId: requireString(record.providerProfileId, "providerProfileId"),
    modelOverride: optionalNullableString(record.modelOverride, "modelOverride"),
    executionProfile: parseExecutionProfile(record.executionProfile),
    toolPolicy: parsePartialToolPolicy(record.toolPolicy),
  };
}

export function parseCreateConversationInput(
  value: unknown,
): CreateConversationInput {
  const record = requireRecord(value, "Conversation input");
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    agentId: requireString(record.agentId, "agentId"),
    title: optionalString(record.title, "title"),
  };
}

export function parseUpdateConversationSettingsInput(
  value: unknown,
): UpdateConversationSettingsInput {
  const record = requireRecord(value, "Conversation settings input");
  return {
    conversationId: requireString(record.conversationId, "conversationId"),
    modelOverride: optionalNullableString(record.modelOverride, "modelOverride"),
    executionProfile: parseExecutionProfile(record.executionProfile),
  };
}

export function parseStartRunInput(value: unknown): StartRunInput {
  const record = requireRecord(value, "Run input");
  return {
    conversationId: requireString(record.conversationId, "conversationId"),
    prompt: requireString(record.prompt, "prompt"),
  };
}

export function parseWorkspaceLayoutRequest(value: unknown): WorkspaceLayout {
  return parseWorkspaceLayout(value);
}

export function parseStageWorkspaceLayoutResult(
  value: unknown,
): StageWorkspaceLayoutResult {
  const record = requireRecord(value, "Workspace layout stage result");
  if (record.accepted === true) {
    requireExactRecord(value, "Workspace layout stage result", ["accepted"]);
    return { accepted: true };
  }
  if (record.accepted === false) {
    const rejected = requireExactRecord(
      value,
      "Workspace layout stage result",
      ["accepted", "reason"],
    );
    if (rejected.reason !== "quiescing") {
      throw new Error("Workspace layout stage result reason must be quiescing.");
    }
    return { accepted: false, reason: "quiescing" };
  }
  throw new Error("Workspace layout stage result accepted must be a boolean.");
}

export function parseCreateDispatchRequest(value: unknown): CreateDispatchInput {
  const record = requireExactRecord(value, "Dispatch input", [
    "prompt",
    "sourceConversationId",
    "sourceRunId",
    "targetConversationId",
    "workspaceId",
  ]);
  return {
    workspaceId: requireNonEmptyString(record.workspaceId, "workspaceId"),
    sourceConversationId: requireNonEmptyString(
      record.sourceConversationId,
      "sourceConversationId",
    ),
    targetConversationId: requireNonEmptyString(
      record.targetConversationId,
      "targetConversationId",
    ),
    prompt: parseDispatchPrompt(record.prompt),
    sourceRunId: optionalNullableNonEmptyString(record.sourceRunId, "sourceRunId"),
  };
}

export function parseHandoffPromptRequest(value: unknown): HandoffPromptRequest {
  const record = requireExactRecord(value, "Handoff input", [
    "sourceConversationId",
    "targetConversationId",
    "workRequest",
    "workspaceId",
  ]);
  const workRequest = requireString(record.workRequest, "workRequest").trim();
  if (!workRequest) throw new Error("workRequest is required.");
  if (new TextEncoder().encode(workRequest).byteLength > 16 * 1024) {
    throw new Error("workRequest must not exceed 16 KiB of UTF-8 text.");
  }
  return {
    workspaceId: requireNonEmptyString(record.workspaceId, "workspaceId"),
    sourceConversationId: requireNonEmptyString(
      record.sourceConversationId,
      "sourceConversationId",
    ),
    targetConversationId: requireNonEmptyString(
      record.targetConversationId,
      "targetConversationId",
    ),
    workRequest,
  };
}

export function parseClipboardText(value: unknown): string {
  const text = requireString(value, "Clipboard text");
  if (!text) throw new Error("Clipboard text cannot be empty.");
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) {
    throw new Error("Clipboard text must not exceed 32 KiB of UTF-8 text.");
  }
  return text;
}

export function parseResolveApprovalRequest(
  value: unknown,
): ResolveApprovalRequest {
  const record = requireRecord(value, "Approval input");
  if (record.decision !== "approved-once" && record.decision !== "denied") {
    throw new Error("decision must be approved-once or denied.");
  }
  return {
    approvalId: requireString(record.approvalId, "approvalId"),
    decision: record.decision,
  };
}

export function parseUpdateWorkspaceContextRequest(
  value: unknown,
): UpdateWorkspaceContextRequest {
  const record = requireRecord(value, "Workspace Context input");
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    content: requireString(record.content, "content"),
    sourceConversationId: optionalNullableString(
      record.sourceConversationId,
      "sourceConversationId",
    ),
    sourceRunId: optionalNullableString(record.sourceRunId, "sourceRunId"),
  };
}

export function parseId(value: unknown, field = "id"): Id {
  return requireNonEmptyString(value, field);
}

function parseProviderProtocol(value: unknown): ProviderProtocol {
  if (value === "openai-compatible" || value === "anthropic-compatible") {
    return value;
  }
  return invalid("protocol must be openai-compatible or anthropic-compatible.");
}

function parseExecutionProfile(
  value: unknown,
): CreateAgentInput["executionProfile"] {
  if (value === undefined) return undefined;
  if (
    value === "request-approval" ||
    value === "auto-approve" ||
    value === "full-access"
  ) return value;
  return invalid(
    "executionProfile must be request-approval, auto-approve, or full-access.",
  );
}

function parsePartialToolPolicy(value: unknown): Partial<AgentToolPolicy> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "toolPolicy");
  return {
    readFiles: parsePermission(record.readFiles, "readFiles"),
    writeFiles: parsePermission(record.writeFiles, "writeFiles"),
    runCommands: parsePermission(record.runCommands, "runCommands"),
  };
}

function parsePermission(
  value: unknown,
  field: string,
): AgentToolPolicy["readFiles"] | undefined {
  if (value === undefined) return undefined;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return invalid(`${field} must be allow, ask, or deny.`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  label: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const extra = Object.keys(record).filter((field) => !allowedFields.includes(field));
  if (extra.length > 0) {
    throw new Error(`${label} must contain only the supported fields.`);
  }
  return record;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const result = requireString(value, field).trim();
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function optionalNullableString(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireString(value, field);
}

function optionalNullableNonEmptyString(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireNonEmptyString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function parseStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, field);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new Error(`${field}.${key} must be a string.`);
    }
  }
  return record as Record<string, string>;
}

function invalid(message: string): never { throw new Error(message); }
