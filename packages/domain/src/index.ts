export const SCOPEGUARD_SCHEMA_ID = "scopeguard-personal-pi-v1";
export const SCOPEGUARD_SCHEMA_VERSION = 1;
export const SCOPEGUARD_PI_VERSION = "0.84.2";
export const SCOPEGUARD_PI_SESSION_VERSION = 3;

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

export type PiSessionLocator = {
  sessionFile: string;
  sessionId: string;
  piVersion: typeof SCOPEGUARD_PI_VERSION;
  sessionVersion: typeof SCOPEGUARD_PI_SESSION_VERSION;
};

export type CreateWorkspaceInput = {
  name: string;
  localRootPath?: string | null;
};

export type ProviderProtocol = "openai-compatible" | "anthropic-compatible";

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

export function parseToolPermission(value: unknown, field = "Tool permission"): ToolPermission {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new Error(`${field} must be allow, ask, or deny.`);
}

export function parseConversationExecutionProfile(
  value: unknown,
  field = "Conversation execution profile",
): ConversationExecutionProfile {
  if (value === "request-approval" || value === "auto-approve" || value === "full-access") {
    return value;
  }
  throw new Error(`${field} is invalid.`);
}

export function parseAgentToolPolicy(value: unknown): AgentToolPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Tool policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "readFiles,runCommands,writeFiles"
  ) {
    throw new Error("Agent Tool policy must contain exactly the supported permissions.");
  }
  return {
    readFiles: parseToolPermission(record.readFiles, "readFiles"),
    writeFiles: parseToolPermission(record.writeFiles, "writeFiles"),
    runCommands: parseToolPermission(record.runCommands, "runCommands"),
  };
}

export type Agent = {
  id: Id;
  workspaceId: Id;
  name: string;
  instructions: string;
  providerProfileId: Id;
  modelOverride: string | null;
  defaultExecutionProfile: ConversationExecutionProfile;
  toolPolicy: AgentToolPolicy;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateAgentInput = {
  workspaceId: Id;
  name: string;
  instructions: string;
  providerProfileId: Id;
  modelOverride?: string | null;
  executionProfile?: ConversationExecutionProfile;
  toolPolicy?: Partial<AgentToolPolicy>;
};

export type Conversation = {
  id: Id;
  workspaceId: Id;
  agentId: Id;
  title: string;
  status: "active" | "archived";
  modelOverride: string | null;
  executionProfile: ConversationExecutionProfile;
  piSession: PiSessionLocator | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateConversationInput = {
  workspaceId: Id;
  agentId: Id;
  title?: string;
};

export type UpdateConversationSettingsInput = {
  conversationId: Id;
  modelOverride?: string | null;
  executionProfile?: ConversationExecutionProfile;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageContentBlock =
  | { type: "text"; text: string }
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

export type ConversationMessage = {
  id: Id;
  conversationId: Id;
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
  agentId: Id;
  providerProfileId: Id;
  providerProtocol: ProviderProtocol;
  providerBaseUrl: string;
  model: string;
  instructions: string;
  executionProfile: ConversationExecutionProfile;
  toolPolicy: AgentToolPolicy;
};

export type AgentRun = {
  id: Id;
  conversationId: Id;
  triggerMessageId: Id;
  contextRevisionId: Id | null;
  configSnapshot: RunConfigSnapshot;
  status: RunStatus;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  error: string | null;
  effect: "none" | "confirmed" | "effect_unknown";
  createdAt: IsoDateTime;
};

export type ToolCallStatus =
  | "proposed"
  | "awaiting-approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "effect_unknown";

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
  processId: string;
  requestId: string;
  piToolCallId: string;
  toolName: string;
  canonicalInput: Record<string, unknown>;
  canonicalInputSha256: string;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
};

export type PendingApprovalItem = {
  approval: ToolApproval;
  toolCall: ToolCallRecord;
};

export type WorkspaceContextRevision = {
  id: Id;
  workspaceId: Id;
  version: number;
  parentId: Id | null;
  title: string;
  content: string;
  sourceConversationId: Id | null;
  sourceRunId: Id | null;
  publishedBy: "user" | "agent";
  createdAt: IsoDateTime;
};

export type RunEvent =
  | {
      type: "run-status";
      runId: Id;
      conversationId: Id;
      status: RunStatus;
      at: IsoDateTime;
      error?: string;
    }
  | {
      type: "assistant-delta";
      runId: Id;
      conversationId: Id;
      delta: string;
      at: IsoDateTime;
    }
  | {
      type: "message-created";
      runId: Id;
      conversationId: Id;
      message: ConversationMessage;
      at: IsoDateTime;
    }
  | {
      type: "tool-call";
      runId: Id;
      conversationId: Id;
      toolCall: ToolCallRecord;
      at: IsoDateTime;
    }
  | {
      type: "approval-required";
      runId: Id;
      conversationId: Id;
      approval: ToolApproval;
      toolCall: ToolCallRecord;
      at: IsoDateTime;
    };

export type WorkspaceSnapshot = {
  workspaces: Workspace[];
  providerProfiles: ProviderProfile[];
  agents: Agent[];
  conversations: Conversation[];
  activeRuns: AgentRun[];
  recentRuns: AgentRun[];
  pendingApprovals: PendingApprovalItem[];
};

export type StartRunInput = {
  conversationId: Id;
  prompt: string;
};

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

export function validateProviderProfileInput(
  input: ProviderProfileInput,
): ProviderProfileInput {
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

export function mergeToolPolicy(
  overrides: Partial<AgentToolPolicy> | undefined,
): AgentToolPolicy {
  return parseAgentToolPolicy({
    ...DEFAULT_AGENT_TOOL_POLICY,
    ...overrides,
  });
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
