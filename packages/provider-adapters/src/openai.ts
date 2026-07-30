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

type ToolAccumulator = {
  id: string;
  name: string;
  argumentsJson: string;
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;
  readonly #fetch: FetchImplementation;

  constructor(fetchImplementation: FetchImplementation = fetch) {
    this.#fetch = fetchImplementation;
  }

  async testConnection(
    credentials: ProviderCredentials,
    signal: AbortSignal,
  ) {
    const startedAt = performance.now();
    const response = await this.#fetch(
      appendEndpoint(credentials.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: buildHeaders(credentials, {
          authorization: credentials.apiKey ? `Bearer ${credentials.apiKey}` : "",
        }),
        body: JSON.stringify({
          model: credentials.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          stream: false,
        }),
        signal,
      },
    );
    await assertSuccessfulResponse(response, credentials);
    const payload = await response.json() as Record<string, unknown>;
    if (!Array.isArray(payload.choices)) {
      throw new Error("Provider response did not contain a choices array.");
    }
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      model: credentials.model,
      message: "Connection succeeded.",
    };
  }

  async *streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderStreamEvent> {
    const response = await this.#fetch(
      appendEndpoint(request.credentials.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: buildHeaders(request.credentials, {
          authorization: request.credentials.apiKey
            ? `Bearer ${request.credentials.apiKey}`
            : "",
        }),
        body: JSON.stringify({
          model: request.credentials.model,
          messages: request.messages.map(toOpenAIMessage),
          tools: request.tools.length > 0
            ? request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              }))
            : undefined,
          tool_choice: request.tools.length > 0 ? "auto" : undefined,
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: request.signal,
      },
    );
    await assertSuccessfulResponse(response, request.credentials);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      yield* parseOpenAIJsonResponse(await response.json(), request.credentials);
      return;
    }
    if (!response.body) {
      throw new Error("Provider returned an empty streaming response.");
    }

    const toolCalls = new Map<number, ToolAccumulator>();
    let finishReason: ReturnType<typeof mapFinishReason> = "unknown";
    let receivedDone = false;

    for await (const event of parseServerSentEvents(response.body, request.signal)) {
      if (event.data === "[DONE]") {
        receivedDone = true;
        break;
      }
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      if (payload.error !== undefined || event.event === "error") {
        throw providerPayloadError(
          payload,
          request.credentials,
          "Provider returned a streaming error.",
        );
      }
      const usage = asRecord(payload.usage);
      if (usage) {
        yield {
          type: "usage",
          inputTokens: asOptionalNumber(usage.prompt_tokens),
          outputTokens: asOptionalNumber(usage.completion_tokens),
        };
      }

      const choice = Array.isArray(payload.choices)
        ? asRecord(payload.choices[0])
        : null;
      if (!choice) {
        continue;
      }
      const delta = asRecord(choice.delta);
      if (delta && typeof delta.content === "string" && delta.content) {
        yield {
          type: "text-delta",
          delta: redactCredentialText(delta.content, request.credentials),
        };
      }
      if (delta && Array.isArray(delta.tool_calls)) {
        collectToolCallDeltas(toolCalls, delta.tool_calls);
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = mapFinishReason(choice.finish_reason);
      }
    }

    if (!receivedDone) {
      throw new ProviderRequestError(
        "Provider stream ended before the [DONE] marker.",
      );
    }

    for (const toolCall of finalizeToolCalls(toolCalls, request.credentials)) {
      yield { type: "tool-call", toolCall };
    }
    yield { type: "completed", finishReason };
  }
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function collectToolCallDeltas(
  accumulators: Map<number, ToolAccumulator>,
  values: unknown[],
): void {
  for (const [position, value] of values.entries()) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }
    const index = typeof record.index === "number" ? record.index : position;
    const existing = accumulators.get(index) ?? {
      id: "",
      name: "",
      argumentsJson: "",
    };
    const fn = asRecord(record.function);
    if (typeof record.id === "string") {
      existing.id = record.id;
    }
    if (fn && typeof fn.name === "string") {
      existing.name += fn.name;
    }
    if (fn && typeof fn.arguments === "string") {
      existing.argumentsJson += fn.arguments;
    }
    accumulators.set(index, existing);
  }
}

function finalizeToolCalls(
  accumulators: Map<number, ToolAccumulator>,
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

async function* parseOpenAIJsonResponse(
  payloadPromise: Promise<unknown> | unknown,
  credentials: ProviderCredentials,
): AsyncGenerator<ProviderStreamEvent> {
  const payload = asRecord(await payloadPromise);
  if (payload?.error !== undefined) {
    throw providerPayloadError(
      payload,
      credentials,
      "Provider returned an error response.",
    );
  }
  const choice = payload && Array.isArray(payload.choices)
    ? asRecord(payload.choices[0])
    : null;
  const message = choice ? asRecord(choice.message) : null;
  if (message && typeof message.content === "string" && message.content) {
    yield {
      type: "text-delta",
      delta: redactCredentialText(message.content, credentials),
    };
  }
  if (message && Array.isArray(message.tool_calls)) {
    const accumulators = new Map<number, ToolAccumulator>();
    collectToolCallDeltas(accumulators, message.tool_calls);
    for (const toolCall of finalizeToolCalls(accumulators, credentials)) {
      yield { type: "tool-call", toolCall };
    }
  }
  const usage = payload ? asRecord(payload.usage) : null;
  if (usage) {
    yield {
      type: "usage",
      inputTokens: asOptionalNumber(usage.prompt_tokens),
      outputTokens: asOptionalNumber(usage.completion_tokens),
    };
  }
  yield {
    type: "completed",
    finishReason: mapFinishReason(choice?.finish_reason),
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
