import type {
  ModelMessage,
  ProviderCredentials,
} from "@scopeguard/agent-runtime";
import type { ProviderProtocol } from "@scopeguard/domain";

export const REMOTE_RUNTIME_PROTOCOL_VERSION = 1;

export type RemoteRunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type RemoteRuntimeCapabilities = {
  nativeAgents: true;
  cliAgents: false;
  fileTools: false;
  commandTools: false;
  persistentRuns: true;
};

export type RemoteRuntimeHealth = {
  service: "scopeguard-runtime";
  protocolVersion: typeof REMOTE_RUNTIME_PROTOCOL_VERSION;
  status: "online";
  capabilities: RemoteRuntimeCapabilities;
  serverTime: string;
};

export type RemoteRunSubmission = {
  clientRunId: string;
  remoteRunId: string;
  workspaceId: string;
  taskId: string | null;
  threadId: string;
  agentInstanceId: string;
  artifactTitle: string;
  provider: ProviderCredentials;
  messages: ModelMessage[];
};

export type RemoteArtifact = {
  id: string;
  runId: string;
  title: string;
  mimeType: "text/markdown";
  content: string;
  version: 1;
  createdAt: string;
};

export type RemoteRunRecord = {
  id: string;
  clientRunId: string;
  workspaceId: string;
  taskId: string | null;
  threadId: string;
  agentInstanceId: string;
  status: RemoteRunStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastSequence: number;
  artifact: RemoteArtifact | null;
};

export type RemoteRunEvent =
  | {
      sequence: number;
      runId: string;
      type: "status";
      status: RemoteRunStatus;
      error?: string;
      at: string;
    }
  | {
      sequence: number;
      runId: string;
      type: "text-delta";
      delta: string;
      at: string;
    }
  | {
      sequence: number;
      runId: string;
      type: "artifact";
      artifact: RemoteArtifact;
      at: string;
    };

export type RemoteRunPollResult = {
  run: RemoteRunRecord;
  events: RemoteRunEvent[];
};

export interface RemoteRuntimeClient {
  health(signal?: AbortSignal): Promise<RemoteRuntimeHealth>;
  submitRun(
    input: RemoteRunSubmission,
    signal?: AbortSignal,
  ): Promise<RemoteRunRecord>;
  getRun(
    runId: string,
    afterSequence?: number,
    signal?: AbortSignal,
  ): Promise<RemoteRunPollResult>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<RemoteRunRecord>;
}

const REMOTE_RUN_STATUSES = new Set<RemoteRunStatus>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export function parseRemoteRuntimeHealth(value: unknown): RemoteRuntimeHealth {
  const input = requireObject(value, "Remote Runtime health response");
  const capabilities = requireObject(
    input.capabilities,
    "Remote Runtime capabilities",
  );
  if (
    input.service !== "scopeguard-runtime" ||
    input.protocolVersion !== REMOTE_RUNTIME_PROTOCOL_VERSION ||
    input.status !== "online" ||
    capabilities.nativeAgents !== true ||
    capabilities.cliAgents !== false ||
    capabilities.fileTools !== false ||
    capabilities.commandTools !== false ||
    capabilities.persistentRuns !== true
  ) {
    throw new Error("Remote Runtime health response is incompatible.");
  }
  return {
    service: "scopeguard-runtime",
    protocolVersion: REMOTE_RUNTIME_PROTOCOL_VERSION,
    status: "online",
    capabilities: {
      nativeAgents: true,
      cliAgents: false,
      fileTools: false,
      commandTools: false,
      persistentRuns: true,
    },
    serverTime: boundedString(input.serverTime, "Server time", 100),
  };
}

export function parseRemoteRunRecord(value: unknown): RemoteRunRecord {
  const input = requireObject(value, "Remote Run response");
  const status = parseRemoteRunStatus(input.status);
  const id = boundedString(input.id, "Remote Run ID", 200);
  const artifact = input.artifact === null
    ? null
    : parseRemoteArtifact(input.artifact);
  if (artifact && artifact.runId !== id) {
    throw new Error("Remote Artifact belongs to a different Run.");
  }
  return {
    id,
    clientRunId: boundedString(input.clientRunId, "Client Run ID", 200),
    workspaceId: boundedString(input.workspaceId, "Workspace ID", 200),
    taskId: nullableBoundedString(input.taskId, "Task ID", 200),
    threadId: boundedString(input.threadId, "Thread ID", 200),
    agentInstanceId: boundedString(
      input.agentInstanceId,
      "Agent instance ID",
      200,
    ),
    status,
    error: nullableBoundedString(input.error, "Remote Run error", 4_000),
    createdAt: boundedString(input.createdAt, "Created time", 100),
    startedAt: nullableBoundedString(input.startedAt, "Started time", 100),
    completedAt: nullableBoundedString(input.completedAt, "Completed time", 100),
    lastSequence: nonNegativeInteger(input.lastSequence, "Last sequence"),
    artifact,
  };
}

export function parseRemoteRunPollResult(value: unknown): RemoteRunPollResult {
  const input = requireObject(value, "Remote Run poll response");
  const run = parseRemoteRunRecord(input.run);
  if (!Array.isArray(input.events) || input.events.length > 10_000) {
    throw new Error("Remote Run events must be a bounded array.");
  }
  let previousSequence = 0;
  const events = input.events.map((value) => {
    const event = parseRemoteRunEvent(value);
    if (event.runId !== run.id || event.sequence <= previousSequence) {
      throw new Error("Remote Run events are inconsistent.");
    }
    previousSequence = event.sequence;
    return event;
  });
  return { run, events };
}

export function parseRemoteRunSubmission(value: unknown): RemoteRunSubmission {
  const input = requireObject(value, "Run request");
  const provider = requireObject(input.provider, "Provider");
  const protocol = requireString(provider.protocol, "Provider protocol") as ProviderProtocol;
  if (protocol !== "openai-compatible" && protocol !== "anthropic-compatible") {
    throw new Error("Provider protocol is not supported.");
  }
  const customHeaders = requireObject(
    provider.customHeaders ?? {},
    "Provider custom headers",
  );
  if (Object.keys(customHeaders).length > 0) {
    throw new Error("Remote Runtime does not accept custom Provider headers.");
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error("Run messages are required.");
  }
  if (input.messages.length > 1_000) {
    throw new Error("Run message count exceeds the limit.");
  }
  const messages = input.messages.map(parseModelMessage);
  return {
    clientRunId: boundedString(input.clientRunId, "Client Run ID", 200),
    remoteRunId: boundedString(input.remoteRunId, "Remote Run ID", 200),
    workspaceId: boundedString(input.workspaceId, "Workspace ID", 200),
    taskId: nullableBoundedString(input.taskId, "Task ID", 200),
    threadId: boundedString(input.threadId, "Thread ID", 200),
    agentInstanceId: boundedString(input.agentInstanceId, "Agent instance ID", 200),
    artifactTitle: boundedString(input.artifactTitle, "Artifact title", 300),
    provider: {
      protocol,
      baseUrl: boundedString(provider.baseUrl, "Provider base URL", 4_096),
      apiKey: provider.apiKey === null
        ? null
        : boundedString(provider.apiKey, "Provider API key", 16_384),
      model: boundedString(provider.model, "Provider model", 500),
      customHeaders: {},
    },
    messages,
  };
}

function parseRemoteRunEvent(value: unknown): RemoteRunEvent {
  const input = requireObject(value, "Remote Run event");
  const sequence = nonNegativeInteger(input.sequence, "Event sequence");
  if (sequence === 0) {
    throw new Error("Remote Run event sequence must be positive.");
  }
  const runId = boundedString(input.runId, "Event Run ID", 200);
  const at = boundedString(input.at, "Event time", 100);
  if (input.type === "status") {
    return {
      sequence,
      runId,
      type: "status",
      status: parseRemoteRunStatus(input.status),
      ...(input.error === undefined
        ? {}
        : { error: boundedString(input.error, "Event error", 4_000, true) }),
      at,
    };
  }
  if (input.type === "text-delta") {
    return {
      sequence,
      runId,
      type: "text-delta",
      delta: boundedString(input.delta, "Text delta", 1_000_000, true),
      at,
    };
  }
  if (input.type === "artifact") {
    const artifact = parseRemoteArtifact(input.artifact);
    if (artifact.runId !== runId) {
      throw new Error("Remote Artifact event belongs to a different Run.");
    }
    return { sequence, runId, type: "artifact", artifact, at };
  }
  throw new Error("Remote Run event type is not supported.");
}

function parseRemoteArtifact(value: unknown): RemoteArtifact {
  const input = requireObject(value, "Remote Artifact");
  if (input.mimeType !== "text/markdown" || input.version !== 1) {
    throw new Error("Remote Artifact format is not supported.");
  }
  return {
    id: boundedString(input.id, "Remote Artifact ID", 200),
    runId: boundedString(input.runId, "Remote Artifact Run ID", 200),
    title: boundedString(input.title, "Remote Artifact title", 300),
    mimeType: "text/markdown",
    content: boundedString(
      input.content,
      "Remote Artifact content",
      1_000_000,
      true,
    ),
    version: 1,
    createdAt: boundedString(input.createdAt, "Remote Artifact time", 100),
  };
}

function parseRemoteRunStatus(value: unknown): RemoteRunStatus {
  if (typeof value !== "string" || !REMOTE_RUN_STATUSES.has(value as RemoteRunStatus)) {
    throw new Error("Remote Run status is not supported.");
  }
  return value as RemoteRunStatus;
}

function parseModelMessage(value: unknown): ModelMessage {
  const message = requireObject(value, "Model message");
  const role = requireString(message.role, "Model message role");
  const content = boundedString(message.content ?? "", "Model message content", 1_000_000, true);
  if (role === "system" || role === "user") {
    return { role, content };
  }
  if (role === "assistant") {
    if (
      message.toolCalls !== undefined &&
      message.toolCalls !== null &&
      (!Array.isArray(message.toolCalls) || message.toolCalls.length > 0)
    ) {
      throw new Error("Remote Runtime does not accept historical tool calls yet.");
    }
    return { role, content, toolCalls: [] };
  }
  if (role === "tool") {
    return {
      role,
      content,
      toolCallId: boundedString(message.toolCallId, "Tool call ID", 200),
      name: boundedString(message.name, "Tool name", 200),
      isError: Boolean(message.isError),
    };
  }
  throw new Error("Model message role is not supported.");
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
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

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  const text = requireString(value, field);
  if (!allowEmpty && !text.trim()) {
    throw new Error(`${field} is required.`);
  }
  if (text.length > maximum) {
    throw new Error(`${field} exceeds the ${maximum} character limit.`);
  }
  return text;
}

function nullableBoundedString(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return boundedString(value, field, maximum);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return Number(value);
}
