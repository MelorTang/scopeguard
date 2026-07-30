import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentTool,
  ModelToolDefinition,
  NativeAgentRunObserver,
  ProviderAdapter,
  ProviderStreamEvent,
  ProviderTurnRequest,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./index.js";
import { NativeAgentRuntime } from "./index.js";

test("streams a final text response", async () => {
  const provider = new SequenceProvider([
    [
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " world" },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const observed = observer();
  const result = await new NativeAgentRuntime(provider, new FakeRegistry([])).run(
    runInput(),
    observed.value,
  );

  assert.equal(result.finalText, "Hello world");
  assert.equal(observed.deltas.join(""), "Hello world");
  assert.equal(observed.turns.length, 1);
});

test("executes an allowed tool and continues the provider loop", async () => {
  const readTool = new FakeTool("read_file", "readFiles", {
    output: "project contents",
    isError: false,
  });
  const provider = new SequenceProvider([
    [
      {
        type: "tool-call",
        toolCall: {
          id: "provider-call",
          name: "read_file",
          arguments: { path: "README.md" },
        },
      },
      { type: "completed", finishReason: "tool-calls" },
    ],
    [
      { type: "text-delta", delta: "The project is ready." },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const observed = observer();
  const result = await new NativeAgentRuntime(
    provider,
    new FakeRegistry([readTool]),
  ).run(runInput(), observed.value);

  assert.equal(result.finalText, "The project is ready.");
  assert.equal(result.toolRounds, 1);
  assert.equal(readTool.executeCount, 1);
  assert.deepEqual(observed.statuses, [
    "running",
    "succeeded",
  ]);
  assert.equal(provider.requests[1]?.messages.at(-1)?.role, "tool");
});

test("does not execute a tool after the user denies approval", async () => {
  const command = new FakeTool("run_command", "runCommands", {
    output: "should not run",
    isError: false,
  });
  const provider = new SequenceProvider([
    [
      {
        type: "tool-call",
        toolCall: {
          id: "provider-call",
          name: "run_command",
          arguments: { command: "rm -rf ." },
        },
      },
      { type: "completed", finishReason: "tool-calls" },
    ],
    [
      { type: "text-delta", delta: "The command was not run." },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const observed = observer("denied");
  const result = await new NativeAgentRuntime(
    provider,
    new FakeRegistry([command]),
  ).run(runInput(), observed.value);

  assert.equal(result.finalText, "The command was not run.");
  assert.equal(command.executeCount, 0);
  assert.deepEqual(observed.statuses, ["awaiting-approval", "denied"]);
  const toolMessage = provider.requests[1]?.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.equal(toolMessage?.content, "The user denied this tool call.");
});

test("rejects empty and duplicate provider tool-call IDs before persistence", async () => {
  for (const calls of [
    [
      { id: "", name: "read_file", arguments: { path: "README.md" } },
    ],
    [
      { id: "duplicate", name: "read_file", arguments: { path: "a" } },
      { id: "duplicate", name: "read_file", arguments: { path: "b" } },
    ],
  ]) {
    const provider = new SequenceProvider([[
      ...calls.map((toolCall) => ({
        type: "tool-call" as const,
        toolCall,
      })),
      { type: "completed", finishReason: "tool-calls" as const },
    ]]);
    const observed = observer();

    await assert.rejects(
      () => new NativeAgentRuntime(provider, new FakeRegistry([])).run(
        runInput(),
        observed.value,
      ),
      /without an ID|duplicate tool call ID/,
    );
    assert.equal(observed.turns.length, 0);
  }
});

test("records a timed-out tool as cancelled and lets the Agent continue", async () => {
  const command = new ThrowingTool("run_command", "runCommands");
  const provider = new SequenceProvider([
    [
      {
        type: "tool-call",
        toolCall: {
          id: "timed-out-command",
          name: "run_command",
          arguments: { command: "sleep 30" },
        },
      },
      { type: "completed", finishReason: "tool-calls" },
    ],
    [
      { type: "text-delta", delta: "The command timed out." },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const observed = observer();

  const result = await new NativeAgentRuntime(
    provider,
    new FakeRegistry([command]),
  ).run(runInput(), observed.value);

  assert.equal(result.finalText, "The command timed out.");
  assert.deepEqual(observed.statuses, [
    "awaiting-approval",
    "running",
    "cancelled",
  ]);
  const toolResult = provider.requests[1]?.messages.at(-1);
  assert.equal(toolResult?.role, "tool");
  assert.match(toolResult?.content ?? "", /timed out/i);
});

test("rejects an unbounded provider text response", async () => {
  const provider = new SequenceProvider([[
    { type: "text-delta", delta: "x".repeat(1_000_001) },
    { type: "completed", finishReason: "stop" },
  ]]);
  const observed = observer();

  await assert.rejects(
    () => new NativeAgentRuntime(provider, new FakeRegistry([])).run(
      runInput(),
      observed.value,
    ),
    /exceeded 1000000 characters/,
  );
  assert.equal(observed.turns.length, 0);
});

class SequenceProvider implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;
  readonly requests: ProviderTurnRequest[] = [];
  readonly #turns: ProviderStreamEvent[][];

  constructor(turns: ProviderStreamEvent[][]) {
    this.#turns = [...turns];
  }

  async testConnection() {
    return {
      ok: true,
      latencyMs: 1,
      model: "test-model",
      message: "ok",
    };
  }

  async *streamTurn(request: ProviderTurnRequest) {
    this.requests.push(request);
    const events = this.#turns.shift();
    if (!events) {
      throw new Error("Unexpected provider turn.");
    }
    for (const event of events) {
      yield event;
    }
  }
}

class FakeRegistry implements ToolRegistry {
  readonly #tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[]) {
    this.#tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  definitions(): ModelToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  get(name: string): AgentTool | null {
    return this.#tools.get(name) ?? null;
  }
}

class FakeTool implements AgentTool {
  readonly definition: ModelToolDefinition;
  readonly permission: "readFiles" | "runCommands";
  readonly #result: ToolExecutionResult;
  executeCount = 0;

  constructor(
    name: string,
    permission: "readFiles" | "runCommands",
    result: ToolExecutionResult,
  ) {
    this.permission = permission;
    this.#result = result;
    this.definition = {
      name,
      description: name,
      inputSchema: { type: "object" },
    };
  }

  describe(): string {
    return this.definition.name;
  }

  async execute(
    _input: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.executeCount += 1;
    return this.#result;
  }
}

class ThrowingTool extends FakeTool {
  constructor(
    name: string,
    permission: "readFiles" | "runCommands",
  ) {
    super(name, permission, { output: "", isError: true });
  }

  override async execute(): Promise<ToolExecutionResult> {
    const error = new Error("Command timed out.");
    Object.assign(error, { code: "TOOL_EXECUTION_CANCELLED" });
    throw error;
  }
}

function runInput() {
  return {
    projectId: "project",
    projectRoot: "/tmp/project",
    threadId: "thread",
    runId: "run",
    credentials: {
      protocol: "openai-compatible" as const,
      baseUrl: "https://provider.example.com/v1",
      apiKey: null,
      model: "test-model",
      customHeaders: {},
    },
    messages: [{ role: "user" as const, content: "Hello" }],
    toolPolicy: {
      readFiles: "allow" as const,
      writeFiles: "ask" as const,
      runCommands: "ask" as const,
    },
    signal: AbortSignal.timeout(1_000),
  };
}

function observer(decision: "approved-once" | "denied" = "approved-once"): {
  value: NativeAgentRunObserver;
  deltas: string[];
  turns: unknown[];
  statuses: string[];
} {
  const deltas: string[] = [];
  const turns: unknown[] = [];
  const statuses: string[] = [];
  return {
    deltas,
    turns,
    statuses,
    value: {
      onTextDelta(delta) {
        deltas.push(delta);
      },
      onUsage() {},
      async onAssistantTurn(turn) {
        turns.push(turn);
        return Object.fromEntries(
          turn.toolCalls.map((toolCall) => [
            toolCall.providerCallId,
            "stored-tool-call",
          ]),
        );
      },
      onToolCallStatus(_toolCallId, status) {
        statuses.push(status);
      },
      async requestApproval() {
        return decision;
      },
      onToolResult() {},
    },
  };
}
