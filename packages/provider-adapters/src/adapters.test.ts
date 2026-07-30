import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderCredentials,
  ProviderStreamEvent,
} from "@scopeguard/agent-runtime";

import {
  AnthropicCompatibleAdapter,
  OpenAICompatibleAdapter,
  ProviderRequestError,
} from "./index.js";

const openAICredentials: ProviderCredentials = {
  protocol: "openai-compatible",
  baseUrl: "https://relay.example.com/v1/",
  apiKey: "sk-private-test-value",
  model: "test-model",
  customHeaders: {
    "X-Workspace": "scopeguard",
    Authorization: "must-not-win",
  },
};

test("tests an OpenAI-compatible endpoint without exposing its key", async () => {
  const captured: { url?: string; headers?: Headers } = {};
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input);
    captured.headers = new Headers(init?.headers);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    });
  }) as typeof fetch;

  const result = await new OpenAICompatibleAdapter(fakeFetch).testConnection(
    openAICredentials,
    AbortSignal.timeout(1_000),
  );

  assert.equal(captured.url, "https://relay.example.com/v1/chat/completions");
  assert.equal(captured.headers?.get("authorization"), "Bearer sk-private-test-value");
  assert.equal(captured.headers?.get("x-workspace"), "scopeguard");
  assert.equal(result.ok, true);
});

test("normalizes chunked OpenAI text, usage, and tool calls", async () => {
  const fakeFetch = (async () => sseResponse([
    {
      choices: [{ delta: { content: "Inspecting " }, finish_reason: null }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-1",
            function: { name: "read_file", arguments: "{\"pa" },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: "th\":\"README.md\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
    "[DONE]",
  ])) as typeof fetch;

  const events = await collect(
    new OpenAICompatibleAdapter(fakeFetch).streamTurn({
      credentials: openAICredentials,
      messages: [{ role: "user", content: "Inspect the README." }],
      tools: [{
        name: "read_file",
        description: "Read a project file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      signal: AbortSignal.timeout(1_000),
    }),
  );

  assert.deepEqual(events, [
    { type: "text-delta", delta: "Inspecting " },
    { type: "usage", inputTokens: 12, outputTokens: 7 },
    {
      type: "tool-call",
      toolCall: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    },
    { type: "completed", finishReason: "tool-calls" },
  ]);
});

test("normalizes Anthropic tool-use streaming", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    protocol: "anthropic-compatible",
    baseUrl: "https://anthropic-relay.example.com/v1",
  };
  const fakeFetch = (async () => sseResponse([
    {
      type: "message_start",
      message: { usage: { input_tokens: 10 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"path\":" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "\"README.md\"}" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    },
    {
      type: "message_stop",
    },
  ])) as typeof fetch;

  const events = await collect(
    new AnthropicCompatibleAdapter(fakeFetch).streamTurn({
      credentials,
      messages: [{ role: "user", content: "Read the README." }],
      tools: [],
      signal: AbortSignal.timeout(1_000),
    }),
  );

  assert.deepEqual(events, [
    { type: "usage", inputTokens: 10 },
    { type: "usage", outputTokens: 4 },
    {
      type: "tool-call",
      toolCall: {
        id: "tool-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    },
    { type: "completed", finishReason: "tool-calls" },
  ]);
});

test("groups consecutive Anthropic tool results into one user turn", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    protocol: "anthropic-compatible",
  };
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([{ type: "message_stop" }]);
  }) as typeof fetch;

  await collect(new AnthropicCompatibleAdapter(fakeFetch).streamTurn({
    credentials,
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "one", name: "read_file", arguments: { path: "a" } },
          { id: "two", name: "read_file", arguments: { path: "b" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "one",
        name: "read_file",
        content: "A",
      },
      {
        role: "tool",
        toolCallId: "two",
        name: "read_file",
        content: "B",
      },
    ],
    tools: [],
    signal: AbortSignal.timeout(1_000),
  }));

  const messages = body?.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.role, "user");
  assert.equal(
    Array.isArray(messages[1]?.content) ? messages[1].content.length : 0,
    2,
  );
});

test("returns structured provider errors with redacted messages", async () => {
  const fakeFetch = (async () => Response.json(
    {
      error: {
        message: "Bad Bearer sk-private-test-value",
      },
    },
    { status: 401 },
  )) as typeof fetch;

  await assert.rejects(
    () => new OpenAICompatibleAdapter(fakeFetch).testConnection(
      openAICredentials,
      AbortSignal.timeout(1_000),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 401);
      assert.equal(error.message.includes("sk-private-test-value"), false);
      return true;
    },
  );
});

test("throws a redacted OpenAI SSE error payload", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    apiKey: "relay-key-without-openai-prefix",
    customHeaders: {
      "X-Relay-Token": "custom-header-secret",
    },
  };
  const fakeFetch = (async () => sseResponse([{
    error: {
      message:
        "Rejected relay-key-without-openai-prefix and custom-header-secret",
    },
  }])) as typeof fetch;

  await assert.rejects(
    () => collect(new OpenAICompatibleAdapter(fakeFetch).streamTurn(
      turnRequest(credentials),
    )),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.message.includes(credentials.apiKey!), false);
      assert.equal(error.message.includes("custom-header-secret"), false);
      assert.match(error.message, /Rejected/);
      return true;
    },
  );
});

test("throws a redacted Anthropic event:error payload", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    protocol: "anthropic-compatible",
    apiKey: "anthropic-relay-token",
    customHeaders: {
      "X-Organization-Secret": "organization-secret",
    },
  };
  const fakeFetch = (async () => sseResponse([{
    type: "error",
    error: {
      type: "authentication_error",
      message: "Bad anthropic-relay-token and organization-secret",
    },
  }], "error")) as typeof fetch;

  await assert.rejects(
    () => collect(new AnthropicCompatibleAdapter(fakeFetch).streamTurn(
      turnRequest(credentials),
    )),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.message.includes(credentials.apiKey!), false);
      assert.equal(error.message.includes("organization-secret"), false);
      assert.match(error.message, /Bad/);
      return true;
    },
  );
});

test("fails closed when an OpenAI stream ends without DONE", async () => {
  const fakeFetch = (async () => sseResponse([{
    choices: [{
      delta: { content: "partial" },
      finish_reason: "stop",
    }],
  }])) as typeof fetch;

  await assert.rejects(
    () => collect(new OpenAICompatibleAdapter(fakeFetch).streamTurn(
      turnRequest(openAICredentials),
    )),
    /before the \[DONE\] marker/,
  );
});

test("fails closed when an Anthropic stream ends without message_stop", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    protocol: "anthropic-compatible",
  };
  const fakeFetch = (async () => sseResponse([{
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
  }])) as typeof fetch;

  await assert.rejects(
    () => collect(new AnthropicCompatibleAdapter(fakeFetch).streamTurn(
      turnRequest(credentials),
    )),
    /before the message_stop event/,
  );
});

test("groups streamed OpenAI tool calls by array position when index is absent", async () => {
  const fakeFetch = (async () => sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [
            {
              id: "call-1",
              function: { name: "read_file", arguments: "{\"path\":" },
            },
            {
              id: "call-2",
              function: { name: "run_command", arguments: "{\"command\":" },
            },
          ],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [
            { function: { arguments: "\"README.md\"}" } },
            { function: { arguments: "\"pwd\"}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    },
    "[DONE]",
  ])) as typeof fetch;

  const events = await collect(new OpenAICompatibleAdapter(fakeFetch).streamTurn(
    turnRequest(openAICredentials),
  ));

  assert.deepEqual(events.filter((event) => event.type === "tool-call"), [
    {
      type: "tool-call",
      toolCall: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    },
    {
      type: "tool-call",
      toolCall: {
        id: "call-2",
        name: "run_command",
        arguments: { command: "pwd" },
      },
    },
  ]);
});

test("groups non-streaming OpenAI tool calls by array position when index is absent", async () => {
  const fakeFetch = (async () => Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          },
          {
            id: "call-2",
            function: {
              name: "run_command",
              arguments: "{\"command\":\"pwd\"}",
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    }],
  })) as typeof fetch;

  const events = await collect(new OpenAICompatibleAdapter(fakeFetch).streamTurn(
    turnRequest(openAICredentials),
  ));

  assert.deepEqual(events.filter((event) => event.type === "tool-call"), [
    {
      type: "tool-call",
      toolCall: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    },
    {
      type: "tool-call",
      toolCall: {
        id: "call-2",
        name: "run_command",
        arguments: { command: "pwd" },
      },
    },
  ]);
});

test("redacts arbitrary request credentials from HTTP provider errors", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    apiKey: "domestic-provider-token",
    customHeaders: {
      "X-Relay-Secret": "relay-header-value",
    },
  };
  const fakeFetch = (async () => Response.json({
    error: {
      message: "domestic-provider-token relay-header-value",
    },
  }, { status: 401 })) as typeof fetch;

  await assert.rejects(
    () => new OpenAICompatibleAdapter(fakeFetch).testConnection(
      credentials,
      AbortSignal.timeout(1_000),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.message.includes("domestic-provider-token"), false);
      assert.equal(error.message.includes("relay-header-value"), false);
      return true;
    },
  );
});

test("redacts request credentials from provider-controlled stream results", async () => {
  const credentials: ProviderCredentials = {
    ...openAICredentials,
    apiKey: "result-api-token",
    customHeaders: {
      "X-Relay-Secret": "result-header-token",
    },
  };
  const fakeFetch = (async () => sseResponse([
    {
      choices: [{
        delta: {
          content: "result-api-token",
          tool_calls: [{
            id: "result-header-token",
            function: {
              name: "read_file",
              arguments:
                "{\"result-header-token\":\"result-api-token\"}",
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
    "[DONE]",
  ])) as typeof fetch;

  const events = await collect(new OpenAICompatibleAdapter(fakeFetch).streamTurn(
    turnRequest(credentials),
  ));
  const serialized = JSON.stringify(events);

  assert.equal(serialized.includes("result-api-token"), false);
  assert.equal(serialized.includes("result-header-token"), false);
  assert.match(serialized, /\[REDACTED\]/);
});

function sseResponse(
  values: Array<Record<string, unknown> | "[DONE]">,
  eventName?: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const serialized = values
        .map((value) => [
          eventName ? `event: ${eventName}\n` : "",
          `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`,
        ].join(""))
        .join("");
      const midpoint = Math.floor(serialized.length / 2);
      controller.enqueue(encoder.encode(serialized.slice(0, midpoint)));
      controller.enqueue(encoder.encode(serialized.slice(midpoint)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function turnRequest(credentials: ProviderCredentials) {
  return {
    credentials,
    messages: [{ role: "user" as const, content: "Test the provider." }],
    tools: [],
    signal: AbortSignal.timeout(1_000),
  };
}

async function collect(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
