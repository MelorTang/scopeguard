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

export const MAX_WORKBENCH_PANES = 4;

export type WorkspaceLayout = {
  workspaceId: Id;
  openConversationIds: Id[];
  paneConversationIds: Id[];
  activeConversationId: Id | null;
  requestedPaneCount: 1 | 2 | 3 | 4;
};

export function parseWorkspaceLayout(
  value: unknown,
  workspaceConversationIds?: ReadonlySet<Id>,
): WorkspaceLayout {
  const record = exactRecord(value, [
    "activeConversationId",
    "openConversationIds",
    "paneConversationIds",
    "requestedPaneCount",
    "workspaceId",
  ], "Workspace Layout");
  const workspaceId = requiredId(record.workspaceId, "Layout workspaceId");
  const openConversationIds = uniqueIds(
    record.openConversationIds,
    "Layout openConversationIds",
  );
  const paneConversationIds = uniqueIds(
    record.paneConversationIds,
    "Layout paneConversationIds",
  );
  const requestedPaneCount = record.requestedPaneCount;
  if (
    !Number.isInteger(requestedPaneCount) ||
    Number(requestedPaneCount) < 1 ||
    Number(requestedPaneCount) > MAX_WORKBENCH_PANES
  ) {
    throw new Error("Layout requestedPaneCount must be an integer from 1 to 4.");
  }
  if (paneConversationIds.length > Number(requestedPaneCount)) {
    throw new Error("Layout has more panes than requestedPaneCount.");
  }
  if (paneConversationIds.some((id) => !openConversationIds.includes(id))) {
    throw new Error("Every pane Conversation must also be open.");
  }
  if (
    workspaceConversationIds &&
    openConversationIds.some((id) => !workspaceConversationIds.has(id))
  ) {
    throw new Error("Layout contains a Conversation outside its Workspace.");
  }
  const activeConversationId = record.activeConversationId === null
    ? null
    : requiredId(record.activeConversationId, "Layout activeConversationId");
  if (paneConversationIds.length === 0 && activeConversationId !== null) {
    throw new Error("An empty Layout cannot have an active Conversation.");
  }
  if (
    paneConversationIds.length > 0 &&
    (!activeConversationId || !paneConversationIds.includes(activeConversationId))
  ) {
    throw new Error("Layout activeConversationId must identify a visible pane.");
  }
  return {
    workspaceId,
    openConversationIds,
    paneConversationIds,
    activeConversationId,
    requestedPaneCount: requestedPaneCount as WorkspaceLayout["requestedPaneCount"],
  };
}

export function projectWorkspaceLayout(
  value: WorkspaceLayout,
  maximumVisiblePanes: number,
): WorkspaceLayout {
  const layout = parseWorkspaceLayout(value);
  if (
    !Number.isInteger(maximumVisiblePanes) ||
    maximumVisiblePanes < 1 ||
    maximumVisiblePanes > MAX_WORKBENCH_PANES
  ) {
    throw new Error("Maximum visible panes must be an integer from 1 to 4.");
  }
  const paneConversationIds = layout.paneConversationIds.slice(
    0,
    maximumVisiblePanes,
  );
  if (
    layout.activeConversationId &&
    layout.paneConversationIds.includes(layout.activeConversationId) &&
    !paneConversationIds.includes(layout.activeConversationId)
  ) {
    paneConversationIds[paneConversationIds.length - 1] = layout.activeConversationId;
  }
  return { ...layout, paneConversationIds };
}

export function activateConversationInLayout(
  value: WorkspaceLayout,
  conversationId: Id,
): WorkspaceLayout {
  const layout = parseWorkspaceLayout(value);
  const id = requiredId(conversationId, "Conversation id");
  const openConversationIds = layout.openConversationIds.includes(id)
    ? layout.openConversationIds
    : [...layout.openConversationIds, id];
  if (layout.paneConversationIds.includes(id)) {
    return { ...layout, openConversationIds, activeConversationId: id };
  }

  const paneConversationIds = [...layout.paneConversationIds];
  if (paneConversationIds.length < layout.requestedPaneCount) {
    paneConversationIds.push(id);
  } else {
    const activeIndex = paneConversationIds.indexOf(layout.activeConversationId ?? "");
    paneConversationIds[Math.max(0, activeIndex)] = id;
  }
  return parseWorkspaceLayout({
    ...layout,
    openConversationIds,
    paneConversationIds,
    activeConversationId: id,
  });
}

export const MAX_DISPATCH_PROMPT_BYTES = 16 * 1024;

export type DispatchStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Dispatch = {
  id: Id;
  workspaceId: Id;
  sourceConversationId: Id;
  targetConversationId: Id;
  prompt: string;
  status: DispatchStatus;
  sourceRunId: Id | null;
  targetRunId: Id | null;
  error: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type CreateDispatchInput = {
  workspaceId: Id;
  sourceConversationId: Id;
  targetConversationId: Id;
  prompt: string;
  sourceRunId?: Id | null;
};

export function parseDispatchPrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Dispatch prompt must be text.");
  }
  const prompt = value.trim();
  if (!prompt) {
    throw new Error("Dispatch prompt cannot be empty.");
  }
  if (new TextEncoder().encode(prompt).byteLength > MAX_DISPATCH_PROMPT_BYTES) {
    throw new Error("Dispatch prompt must not exceed 16 KiB of UTF-8 text.");
  }
  return prompt;
}

export function parseDispatchStatus(value: unknown): DispatchStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  ) {
    return value;
  }
  throw new Error("Dispatch status is invalid.");
}

export function parseDispatch(value: unknown): Dispatch {
  const record = exactRecord(value, [
    "createdAt",
    "error",
    "id",
    "prompt",
    "sourceConversationId",
    "sourceRunId",
    "status",
    "targetConversationId",
    "targetRunId",
    "updatedAt",
    "workspaceId",
  ], "Dispatch");
  return {
    id: requiredId(record.id, "Dispatch id"),
    workspaceId: requiredId(record.workspaceId, "Dispatch workspaceId"),
    sourceConversationId: requiredId(
      record.sourceConversationId,
      "Dispatch sourceConversationId",
    ),
    targetConversationId: requiredId(
      record.targetConversationId,
      "Dispatch targetConversationId",
    ),
    prompt: parseDispatchPrompt(record.prompt),
    status: parseDispatchStatus(record.status),
    sourceRunId: nullableId(record.sourceRunId, "Dispatch sourceRunId"),
    targetRunId: nullableId(record.targetRunId, "Dispatch targetRunId"),
    error: nullableString(record.error, "Dispatch error"),
    createdAt: isoDateTime(record.createdAt, "Dispatch createdAt"),
    updatedAt: isoDateTime(record.updatedAt, "Dispatch updatedAt"),
  };
}

const DISPATCH_TRANSITIONS: Record<DispatchStatus, ReadonlySet<DispatchStatus>> = {
  pending: new Set(["running", "failed", "cancelled", "interrupted"]),
  running: new Set(["completed", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

export function canTransitionDispatch(
  from: DispatchStatus,
  to: DispatchStatus,
): boolean {
  return DISPATCH_TRANSITIONS[from].has(to);
}

export function assertDispatchTransition(
  from: DispatchStatus,
  to: DispatchStatus,
): void {
  if (!canTransitionDispatch(from, to)) {
    throw new Error(`Invalid Dispatch status transition: ${from} -> ${to}`);
  }
}

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
  layouts: WorkspaceLayout[];
  dispatches: Dispatch[];
};

export type HandoffPromptRequest = {
  workspaceId: Id;
  sourceConversationId: Id;
  targetConversationId: Id;
  workRequest: string;
};

export type HandoffPrompt = {
  text: string;
  sourceConversationId: Id;
  targetConversationId: Id;
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

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...fields].sort().join(",")) {
    throw new Error(`${label} must contain exactly the supported fields.`);
  }
  return record;
}

function requiredId(value: unknown, label: string): Id {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty ID.`);
  }
  return value;
}

function nullableId(value: unknown, label: string): Id | null {
  return value === null ? null : requiredId(value, label);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text or null.`);
  return value;
}

function isoDateTime(value: unknown, label: string): IsoDateTime {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp.`);
  try {
    if (new Date(value).toISOString() === value) return value;
  } catch {
    // Fall through to the stable domain error below.
  }
  throw new Error(`${label} must be an ISO timestamp.`);
}

function uniqueIds(value: unknown, label: string): Id[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const ids = value.map((id) => requiredId(id, label));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} must not contain duplicate Conversation IDs.`);
  }
  return ids;
}
