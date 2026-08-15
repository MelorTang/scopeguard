import type {
  AgentToolPolicy,
  ConversationExecutionProfile,
  Id,
  ManagedExecutionProgress,
  ProviderConnectionResult,
  ProviderProtocol,
} from "@scopeguard/domain";

export type ProviderCredentials = {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  customHeaders: Record<string, string>;
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

export type ProviderTurnRequest = {
  credentials: ProviderCredentials;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  maxOutputTokens?: number;
  signal: AbortSignal;
};

export type ProviderFinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"
  | "cancelled"
  | "unknown";

export type ProviderStreamEvent =
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "tool-call";
      toolCall: ModelToolCall;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "completed";
      finishReason: ProviderFinishReason;
    };

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  testConnection(
    credentials: ProviderCredentials,
    signal: AbortSignal,
  ): Promise<ProviderConnectionResult>;
  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderStreamEvent>;
}

export type ToolExecutionContext = {
  projectId: Id;
  projectRoot: string;
  threadId: Id;
  runId: Id;
  executionProfile: ConversationExecutionProfile;
  toolPolicy: AgentToolPolicy;
  onManagedExecutionEvent?: (event: ManagedExecutionProgress) => void;
  signal: AbortSignal;
};

export type ToolExecutionResult = {
  output: string;
  isError: boolean;
};

export interface AgentTool {
  readonly definition: ModelToolDefinition;
  readonly permission: keyof AgentToolPolicy;
  describe(input: Record<string, unknown>, context: ToolExecutionContext): string;
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export interface ToolRegistry {
  definitions(policy: AgentToolPolicy): ModelToolDefinition[];
  get(name: string): AgentTool | null;
}

export {
  NativeAgentRuntime,
  type NativeAgentRunInput,
  type NativeAgentRunObserver,
  type NativeAgentRunResult,
  type ObservedToolCall,
} from "./native-agent-runtime.js";
