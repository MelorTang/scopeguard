import type {
  AgentToolPolicy,
  ApprovalDecision,
  ConversationExecutionProfile,
  Id,
  ManagedExecutionProgress,
  ToolCallStatus,
} from "@scopeguard/domain";

import type {
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  ProviderAdapter,
  ProviderCredentials,
  ProviderFinishReason,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./index.js";

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const MAX_ASSISTANT_TEXT_CHARACTERS = 1_000_000;
const MAX_INPUT_QUESTION_CHARACTERS = 4_000;
const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
const REQUEST_USER_INPUT_TOOL = {
  name: REQUEST_USER_INPUT_TOOL_NAME,
  description:
    "Pause the current run and ask the user for information that is required to continue.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        description: "A concise, specific question for the user.",
        maxLength: MAX_INPUT_QUESTION_CHARACTERS,
      },
    },
    required: ["question"],
  },
};

export type NativeAgentRunInput = {
  workspaceId: Id;
  workspaceRoot: string;
  conversationId: Id;
  runId: Id;
  credentials: ProviderCredentials;
  messages: ModelMessage[];
  executionProfile: ConversationExecutionProfile;
  toolPolicy: AgentToolPolicy;
  onManagedExecutionEvent?: (event: ManagedExecutionProgress) => void;
  signal: AbortSignal;
  maxToolRounds?: number;
  maxOutputTokens?: number;
  allowUserInput?: boolean;
};

export type ObservedToolCall = {
  providerCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  description: string;
};

export interface NativeAgentRunObserver {
  onRequestManifest(input: {
    stepSequence: number;
    providerProtocol: ProviderCredentials["protocol"];
    model: string;
    messages: ModelMessage[];
    tools: ModelToolDefinition[];
    maxOutputTokens: number | null;
  }): void | Promise<void>;
  onTextDelta(delta: string): void | Promise<void>;
  onUsage(usage: {
    stepSequence: number;
    status: "reported" | "unavailable";
    inputTokens?: number;
    outputTokens?: number;
  }): void | Promise<void>;
  onAssistantTurn(turn: {
    content: string;
    toolCalls: ObservedToolCall[];
    finishReason: ProviderFinishReason;
  }): Promise<Record<string, Id>>;
  onToolCallStatus(
    toolCallId: Id,
    status: ToolCallStatus,
    result?: ToolExecutionResult,
  ): void | Promise<void>;
  requestApproval(input: {
    toolCallId: Id;
    description: string;
  }): Promise<ApprovalDecision>;
  requestInput(input: {
    toolCallId: Id;
    question: string;
  }): Promise<string>;
  onToolResult(input: {
    toolCallId: Id;
    providerCallId: string;
    name: string;
    result: ToolExecutionResult;
  }): void | Promise<void>;
}

export type NativeAgentRunResult = {
  finalText: string;
  toolRounds: number;
  finishReason: ProviderFinishReason;
};

export class NativeAgentRuntime {
  readonly #provider: ProviderAdapter;
  readonly #tools: ToolRegistry;

  constructor(provider: ProviderAdapter, tools: ToolRegistry) {
    this.#provider = provider;
    this.#tools = tools;
  }

  async run(
    input: NativeAgentRunInput,
    observer: NativeAgentRunObserver,
  ): Promise<NativeAgentRunResult> {
    const messages = [...input.messages];
    const maxToolRounds = input.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const seenProviderToolCallIds = new Set<string>();

    for (let toolRound = 0; toolRound <= maxToolRounds; toolRound += 1) {
      throwIfAborted(input.signal);
      const stepSequence = toolRound + 1;
      let text = "";
      let finishReason: ProviderFinishReason = "unknown";
      const toolCalls: ModelToolCall[] = [];
      const requestMessages = structuredClone(messages);
      const requestTools = structuredClone([
        ...this.#tools.definitions(input.toolPolicy),
        ...(input.allowUserInput === false ? [] : [REQUEST_USER_INPUT_TOOL]),
      ]);
      await observer.onRequestManifest({
        stepSequence,
        providerProtocol: input.credentials.protocol,
        model: input.credentials.model,
        messages: structuredClone(requestMessages),
        tools: structuredClone(requestTools),
        maxOutputTokens: input.maxOutputTokens ?? null,
      });

      let usageReported = false;
      let providerFailed = false;
      let providerError: unknown;
      try {
        for await (const event of this.#provider.streamTurn({
          credentials: input.credentials,
          messages: requestMessages,
          tools: requestTools,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal,
        })) {
          throwIfAborted(input.signal);
          if (event.type === "text-delta") {
            if (text.length + event.delta.length > MAX_ASSISTANT_TEXT_CHARACTERS) {
              throw new Error(
                `Provider response exceeded ${MAX_ASSISTANT_TEXT_CHARACTERS} characters.`,
              );
            }
            text += event.delta;
            await observer.onTextDelta(event.delta);
          } else if (event.type === "tool-call") {
            toolCalls.push(event.toolCall);
          } else if (event.type === "usage") {
            usageReported = true;
            await observer.onUsage({
              stepSequence,
              status: "reported",
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            });
          } else if (event.type === "completed") {
            finishReason = event.finishReason;
          }
        }
      } catch (error) {
        providerFailed = true;
        providerError = error;
      }
      if (!usageReported) {
        await observer.onUsage({
          stepSequence,
          status: "unavailable",
        });
      }
      if (providerFailed) {
        throw providerError;
      }

      for (const toolCall of toolCalls) {
        const providerCallId = toolCall.id.trim();
        if (!providerCallId) {
          throw new Error("Provider returned a tool call without an ID.");
        }
        if (seenProviderToolCallIds.has(providerCallId)) {
          throw new Error(
            `Provider returned a duplicate tool call ID: ${providerCallId}`,
          );
        }
        seenProviderToolCallIds.add(providerCallId);
        toolCall.id = providerCallId;
      }

      const observedToolCalls = toolCalls.map((providerCall) => {
        const tool = this.#tools.get(providerCall.name);
        return {
          providerCallId: providerCall.id,
          name: providerCall.name,
          arguments: providerCall.arguments,
          description: providerCall.name === REQUEST_USER_INPUT_TOOL_NAME
            ? describeInputRequest(providerCall.arguments)
            : tool
              ? tool.describe(providerCall.arguments, toolContext(input))
              : `Unknown tool: ${providerCall.name}`,
        };
      });
      const storedToolCallIds = await observer.onAssistantTurn({
        content: text,
        toolCalls: observedToolCalls,
        finishReason,
      });
      messages.push({
        role: "assistant",
        content: text,
        toolCalls,
      });

      if (toolCalls.length === 0) {
        return {
          finalText: text,
          toolRounds: toolRound,
          finishReason,
        };
      }
      if (toolRound === maxToolRounds) {
        throw new Error(`Agent exceeded the ${maxToolRounds} tool-round limit.`);
      }

      for (const providerCall of toolCalls) {
        throwIfAborted(input.signal);
        if (
          providerCall.name === REQUEST_USER_INPUT_TOOL_NAME &&
          input.allowUserInput !== false
        ) {
          const toolCallId = storedToolCallIds[providerCall.id];
          if (!toolCallId) {
            throw new Error(
              `Run observer did not persist provider tool call ${providerCall.id}.`,
            );
          }
          let result: ToolExecutionResult;
          try {
            const question = requireInputQuestion(providerCall.arguments);
            await observer.onToolCallStatus(toolCallId, "running");
            const answer = await observer.requestInput({ toolCallId, question });
            throwIfAborted(input.signal);
            result = { output: answer, isError: false };
            await observer.onToolCallStatus(toolCallId, "succeeded", result);
          } catch (error) {
            if (input.signal.aborted) {
              await observer.onToolCallStatus(toolCallId, "cancelled");
              throw input.signal.reason ?? error;
            }
            result = {
              output: error instanceof Error ? error.message : String(error),
              isError: true,
            };
            await observer.onToolCallStatus(toolCallId, "failed", result);
          }
          await observer.onToolResult({
            toolCallId,
            providerCallId: providerCall.id,
            name: providerCall.name,
            result,
          });
          messages.push({
            role: "tool",
            toolCallId: providerCall.id,
            name: providerCall.name,
            content: result.output,
            isError: result.isError,
          });
          continue;
        }
        const tool = this.#tools.get(providerCall.name);
        const observedCall = observedToolCalls.find(
          (candidate) => candidate.providerCallId === providerCall.id,
        );
        const description = observedCall?.description ?? `Tool: ${providerCall.name}`;
        const toolCallId = storedToolCallIds[providerCall.id];
        if (!toolCallId) {
          throw new Error(
            `Run observer did not persist provider tool call ${providerCall.id}.`,
          );
        }

        let result: ToolExecutionResult;
        if (!tool) {
          result = {
            output: `Tool is not available: ${providerCall.name}`,
            isError: true,
          };
          await observer.onToolCallStatus(toolCallId, "failed", result);
        } else {
          const permission = input.toolPolicy[tool.permission];
          if (permission === "deny") {
            result = {
              output: `Tool permission denied: ${providerCall.name}`,
              isError: true,
            };
            await observer.onToolCallStatus(toolCallId, "denied", result);
          } else {
            if (permission === "ask") {
              await observer.onToolCallStatus(toolCallId, "awaiting-approval");
              const decision = await observer.requestApproval({
                toolCallId,
                description,
              });
              throwIfAborted(input.signal);
              if (decision === "denied") {
                result = {
                  output: "The user denied this tool call.",
                  isError: true,
                };
                await observer.onToolCallStatus(toolCallId, "denied", result);
                await observer.onToolResult({
                  toolCallId,
                  providerCallId: providerCall.id,
                  name: providerCall.name,
                  result,
                });
                messages.push({
                  role: "tool",
                  toolCallId: providerCall.id,
                  name: providerCall.name,
                  content: result.output,
                  isError: true,
                });
                continue;
              }
            }

            await observer.onToolCallStatus(toolCallId, "running");
            try {
              result = await tool.execute(providerCall.arguments, toolContext(input));
              await observer.onToolCallStatus(
                toolCallId,
                result.isError ? "failed" : "succeeded",
                result,
              );
            } catch (error) {
              if (input.signal.aborted) {
                await observer.onToolCallStatus(toolCallId, "cancelled");
                throw input.signal.reason ?? error;
              }
              if (isToolCancellation(error)) {
                result = {
                  output: error instanceof Error
                    ? error.message
                    : "Tool execution was cancelled.",
                  isError: true,
                };
                await observer.onToolCallStatus(toolCallId, "cancelled", result);
              } else {
                result = {
                  output: error instanceof Error ? error.message : String(error),
                  isError: true,
                };
                await observer.onToolCallStatus(toolCallId, "failed", result);
              }
            }
          }
        }

        await observer.onToolResult({
          toolCallId,
          providerCallId: providerCall.id,
          name: providerCall.name,
          result,
        });
        messages.push({
          role: "tool",
          toolCallId: providerCall.id,
          name: providerCall.name,
          content: result.output,
          isError: result.isError,
        });
      }
    }

    throw new Error("Agent run ended without a final response.");
  }
}

function toolContext(input: NativeAgentRunInput): ToolExecutionContext {
  return {
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    conversationId: input.conversationId,
    runId: input.runId,
    executionProfile: input.executionProfile,
    toolPolicy: input.toolPolicy,
    onManagedExecutionEvent: input.onManagedExecutionEvent,
    signal: input.signal,
  };
}

function describeInputRequest(input: Record<string, unknown>): string {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  return question ? `Ask the user: ${question}` : "Ask the user for input";
}

function requireInputQuestion(input: Record<string, unknown>): string {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) {
    throw new Error("request_user_input requires a question.");
  }
  if (question.length > MAX_INPUT_QUESTION_CHARACTERS) {
    throw new Error(
      `The input question exceeds ${MAX_INPUT_QUESTION_CHARACTERS} characters.`,
    );
  }
  return question;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

function isToolCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "TOOL_EXECUTION_CANCELLED"
  );
}
