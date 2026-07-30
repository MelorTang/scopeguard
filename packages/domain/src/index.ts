export const SCOPEGUARD_SCHEMA_VERSION = 3;

export type Id = string;
export type IsoDateTime = string;

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
  toolPolicy: AgentToolPolicy;
  cliConfig: CliAgentConfig | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type AgentThread = {
  id: Id;
  projectId: Id;
  agentProfileId: Id;
  title: string;
  status: "active" | "archived";
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
  toolPolicy: AgentToolPolicy;
  cliConfig: CliAgentConfig | null;
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
  projectId: Id;
  version: number;
  parentId: Id | null;
  content: string;
  sourceThreadId: Id | null;
  sourceRunId: Id | null;
  createdAt: IsoDateTime;
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
    };

export type WorkspaceSnapshot = {
  projects: Project[];
  providerProfiles: ProviderProfile[];
  agentProfiles: AgentProfile[];
  threads: AgentThread[];
  activeRuns: AgentRun[];
  recentRuns: AgentRun[];
  pendingApprovals: PendingApprovalItem[];
};

export type CreateProjectInput = {
  name?: string;
  rootPath: string;
};

export type CreateAgentProfileInput = {
  projectId: Id;
  name: string;
  runtimeKind?: AgentRuntimeKind;
  instructions: string;
  providerProfileId?: Id | null;
  modelOverride?: string | null;
  toolPolicy?: Partial<AgentToolPolicy>;
  cliConfig?: CliAgentConfig | null;
};

export type CreateThreadInput = {
  projectId: Id;
  agentProfileId: Id;
  title?: string;
};

export type StartRunInput = {
  threadId: Id;
  prompt: string;
};

const RUN_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["preparing", "cancelling", "cancelled", "failed", "interrupted"]),
  preparing: new Set(["running", "cancelling", "failed", "interrupted"]),
  running: new Set([
    "waiting-approval",
    "cancelling",
    "completed",
    "failed",
    "interrupted",
  ]),
  "waiting-approval": new Set(["running", "cancelling", "failed", "interrupted"]),
  cancelling: new Set(["cancelled", "failed", "interrupted"]),
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
