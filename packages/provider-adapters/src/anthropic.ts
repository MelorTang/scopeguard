import type {
  ModelMessage,
  ModelToolCall,
  ProviderAdapter,
  ProviderCredentials,
  ProviderStreamEvent,
  ProviderTurnRequest,
} from "@scopeguard/agent-runtime";

import { parseServerSentEvents } from "./sse.js";
import {
  appendEndpoint,
  assertSuccessfulResponse,
  buildHeaders,
  mapFinishReason,
  parseToolArguments,
  ProviderRequestError,
  providerPayloadError,
  redactCredentialText,
  redactCredentialValues,
  type FetchImplementation,
} from "./shared.js";

type AnthropicToolAccumulator = {
  id: string;
  name: string;
  argumentsJson: string;
};

export class AnthropicCompatibleAdapter implements ProviderAdapter {
  readonly protocol = "anthropic-compatible" as const;
  readonly #fetch: FetchImplementation;

  constructor(fetchImplementation: FetchImplementation = fetch) {
    this.#fetch = fetchImplementation;
  }

  async testConnection(
    credentials: ProviderCredentials,
    signal: AbortSignal,
  ) {
    const startedAt = performance.now();
    const response = await this.#fetch(appendEndpoint(credentials.baseUrl, "messages"), {
      method: "POST",
      headers: anthropicHeaders(credentials),
      body: JSON.stringify({
        model: credentials.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal,
    });
    await assertSuccessfulResponse(response, credentials);
    const payload = await response.json() as Record<string, unknown>;
    if (!Array.isArray(payload.content)) {
      throw new Error("Provider response did not contain a content array.");
    }
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      model: credentials.model,
      message: "Connection succeeded.",
    };
  }

  async *streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderStreamEvent> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const response = await this.#fetch(
      appendEndpoint(request.credentials.baseUrl, "messages"),
      {
        method: "POST",
        headers: anthropicHeaders(request.credentials),
        body: JSON.stringify({
          model: request.credentials.model,
          system: system || undefined,
          messages,
          tools: request.tools.length > 0
            ? request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              }))
            : undefined,
          max_tokens: request.maxOutputTokens ?? 4096,
          stream: true,
        }),
        signal: request.signal,
      },
    );
    await assertSuccessfulResponse(response, request.credentials);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      yield* parseAnthropicJsonResponse(await response.json(), request.credentials);
      return;
    }
    if (!response.body) {
      throw new Error("Provider returned an empty streaming response.");
    }

    const tools = new Map<number, AnthropicToolAccumulator>();
    let finishReason: ReturnType<typeof mapFinishReason> = "unknown";
    let receivedMessageStop = false;

    for await (const event of parseServerSentEvents(response.body, request.signal)) {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      const type = typeof payload.type === "string" ? payload.type : event.event;

      if (type === "error" || event.event === "error") {
        throw providerPayloadError(
          payload,
          request.credentials,
          "Provider returned a streaming error.",
        );
      } else if (type === "message_stop") {
        receivedMessageStop = true;
        break;
      } else if (type === "message_start") {
        const message = asRecord(payload.message);
        const usage = message ? asRecord(message.usage) : null;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: asOptionalNumber(usage.input_tokens),
          };
        }
      } else if (type === "content_block_start") {
        const index = asOptionalNumber(payload.index) ?? 0;
        const block = asRecord(payload.content_block);
        if (block?.type === "tool_use") {
          const initialInput = asRecord(block.input);
          tools.set(index, {
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            argumentsJson:
              initialInput && Object.keys(initialInput).length > 0
                ? JSON.stringify(initialInput)
                : "",
          });
        }
      } else if (type === "content_block_delta") {
        const index = asOptionalNumber(payload.index) ?? 0;
        const delta = asRecord(payload.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield {
            type: "text-delta",
            delta: redactCredentialText(delta.text, request.credentials),
          };
        } else if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const tool = tools.get(index);
          if (tool) {
            tool.argumentsJson += delta.partial_json;
          }
        }
      } else if (type === "message_delta") {
        const delta = asRecord(payload.delta);
        const usage = asRecord(payload.usage);
        if (delta?.stop_reason !== null && delta?.stop_reason !== undefined) {
          finishReason = mapFinishReason(delta.stop_reason);
        }
        if (usage) {
          yield {
            type: "usage",
            outputTokens: asOptionalNumber(usage.output_tokens),
          };
        }
      }
    }

    if (!receivedMessageStop) {
      throw new ProviderRequestError(
        "Provider stream ended before the message_stop event.",
      );
    }

    for (const toolCall of finalizeAnthropicTools(tools, request.credentials)) {
      yield { type: "tool-call", toolCall };
    }
    yield { type: "completed", finishReason };
  }
}

function anthropicHeaders(credentials: ProviderCredentials): Headers {
  return buildHeaders(credentials, {
    "x-api-key": credentials.apiKey ?? "",
    "anthropic-version": "2023-06-01",
  });
}

function toAnthropicMessages(messages: ModelMessage[]): {
  system: string;
  messages: Record<string, unknown>[];
} {
  const system: string[] = [];
  const converted: Record<string, unknown>[] = [];
  let toolResults: Record<string, unknown>[] = [];
  const flushToolResults = () => {
    if (toolResults.length === 0) {
      return;
    }
    converted.push({ role: "user", content: toolResults });
    toolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      flushToolResults();
      system.push(message.content);
      continue;
    }
    if (message.role === "assistant") {
      flushToolResults();
      const content: Record<string, unknown>[] = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        });
      }
      converted.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: message.isError ?? false,
      });
      continue;
    }
    flushToolResults();
    converted.push({
      role: "user",
      content: message.content,
    });
  }
  flushToolResults();

  return { system: system.join("\n\n"), messages: converted };
}

function finalizeAnthropicTools(
  accumulators: Map<number, AnthropicToolAccumulator>,
  credentials: ProviderCredentials,
): ModelToolCall[] {
  return [...accumulators.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => {
      const name = redactCredentialText(value.name, credentials);
      return {
        id: redactCredentialText(value.id, credentials),
        name,
        arguments: redactCredentialValues(
          parseToolArguments(value.argumentsJson, name),
          credentials,
        ) as Record<string, unknown>,
      };
    });
}

async function* parseAnthropicJsonResponse(
  payloadPromise: Promise<unknown> | unknown,
  credentials: ProviderCredentials,
): AsyncGenerator<ProviderStreamEvent> {
  const payload = asRecord(await payloadPromise);
  if (payload?.error !== undefined || payload?.type === "error") {
    throw providerPayloadError(
      payload,
      credentials,
      "Provider returned an error response.",
    );
  }
  const blocks = payload && Array.isArray(payload.content) ? payload.content : [];
  for (const value of blocks) {
    const block = asRecord(value);
    if (block?.type === "text" && typeof block.text === "string") {
      yield {
        type: "text-delta",
        delta: redactCredentialText(block.text, credentials),
      };
    } else if (
      block?.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      yield {
        type: "tool-call",
        toolCall: {
          id: redactCredentialText(block.id, credentials),
          name: redactCredentialText(block.name, credentials),
          arguments: redactCredentialValues(
            asRecord(block.input) ?? {},
            credentials,
          ) as Record<string, unknown>,
        },
      };
    }
  }
  const usage = payload ? asRecord(payload.usage) : null;
  if (usage) {
    yield {
      type: "usage",
      inputTokens: asOptionalNumber(usage.input_tokens),
      outputTokens: asOptionalNumber(usage.output_tokens),
    };
  }
  yield {
    type: "completed",
    finishReason: mapFinishReason(payload?.stop_reason),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
