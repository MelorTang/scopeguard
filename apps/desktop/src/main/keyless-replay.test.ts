import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@scopeguard/agent-runtime";
import {
  ScopeGuardApplication,
  type SecretVault,
} from "@scopeguard/application";
import type {
  AgentToolPolicy,
  ConversationExecutionProfile,
} from "@scopeguard/domain";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";
import { ScopeGuardToolRegistry } from "@scopeguard/tool-runtime";

import { KeylessReplayProvider } from "./keyless-replay-fixture.js";

test("replays a two-step file tool run through the production composition without a key", async () => {
  const provider = new KeylessReplayProvider([
    {
      events: [
        { type: "usage", inputTokens: 17 },
        {
          type: "tool-call",
          toolCall: {
            id: "replay-write-1",
            name: "write_file",
            arguments: {
              path: "reports/replay.md",
              content: "# Keyless replay\n",
            },
          },
        },
        { type: "completed", finishReason: "tool-calls" },
      ],
    },
    {
      events: [
        { type: "usage", outputTokens: 9 },
        { type: "text-delta", delta: "Replay file created." },
        { type: "completed", finishReason: "stop" },
      ],
    },
  ]);
  const fixture = await createReplayFixture(provider, "auto-approve");

  try {
    const run = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "Create the replay report.",
    });
    assert.equal(
      (await fixture.application.waitForRun(run.id)).status,
      "completed",
    );

    assert.equal(
      await readFile(join(fixture.workspaceRoot, "reports/replay.md"), "utf8"),
      "# Keyless replay\n",
    );
    assert.equal(provider.requests.length, 2);
    assert.equal(
      provider.requests.some((request) => Boolean(request.credentials.apiKey)),
      false,
    );

    const manifests = fixture.store.listRunRequestManifests(run.id);
    assert.equal(manifests.length, 2);
    assert.deepEqual(manifests[0]?.messages, provider.requests[0]?.messages);
    assert.deepEqual(manifests[0]?.tools, provider.requests[0]?.tools);
    assert.deepEqual(manifests[1]?.messages, provider.requests[1]?.messages);
    assert.deepEqual(manifests[1]?.tools, provider.requests[1]?.tools);
    assert.deepEqual(
      fixture.store.listRunUsageRecords(run.id).map((usage) => ({
        stepSequence: usage.stepSequence,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })),
      [
        { stepSequence: 1, inputTokens: 17, outputTokens: null },
        { stepSequence: 2, inputTokens: null, outputTokens: 9 },
      ],
    );
    assert.deepEqual(
      fixture.store.listToolCallsForRun(run.id).map((toolCall) => ({
        providerCallId: toolCall.providerCallId,
        status: toolCall.status,
      })),
      [{ providerCallId: "replay-write-1", status: "succeeded" }],
    );
    assert.deepEqual(
      fixture.store.listRunEvents(run.id)
        .filter((event) => event.type === "tool-call")
        .map((event) => event.toolCall.status),
      ["proposed", "running", "succeeded"],
    );
    assert.match(
      fixture.store.listThreadMessages(fixture.threadId)
        .flatMap((message) => message.content)
        .map((block) => block.type === "text"
          ? block.text
          : block.type === "tool-result"
            ? block.output
            : "")
        .join("\n"),
      /Wrote 17 bytes.*Replay file created/s,
    );
  } finally {
    await fixture.close();
  }
});

test("replays a pure text run without provider credentials", async () => {
  const provider = new KeylessReplayProvider([{
    events: [
      { type: "usage", inputTokens: 4, outputTokens: 3 },
      { type: "text-delta", delta: "Keyless answer." },
      { type: "completed", finishReason: "stop" },
    ],
  }]);
  const fixture = await createReplayFixture(provider, "request-approval");
  try {
    const run = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "Answer without tools.",
    });
    assert.equal(
      (await fixture.application.waitForRun(run.id)).status,
      "completed",
    );
    assert.equal(provider.requests[0]?.credentials.apiKey, null);
    assert.equal(fixture.store.listRunRequestManifests(run.id).length, 1);
    assert.equal(fixture.store.listRunUsageRecords(run.id)[0]?.status, "reported");
    assert.match(replayTranscript(fixture, run.id), /Keyless answer/);
  } finally {
    await fixture.close();
  }
});

test("replays approval denial without applying the file effect", async () => {
  const provider = new KeylessReplayProvider([
    {
      events: [
        {
          type: "tool-call",
          toolCall: {
            id: "replay-denied-1",
            name: "write_file",
            arguments: {
              path: "reports/denied.md",
              content: "must not exist",
            },
          },
        },
        { type: "completed", finishReason: "tool-calls" },
      ],
    },
    {
      events: [
        { type: "text-delta", delta: "The write was denied." },
        { type: "completed", finishReason: "stop" },
      ],
    },
  ]);
  const fixture = await createReplayFixture(provider, "request-approval");
  try {
    const run = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "Try to write the denied report.",
    });
    await waitForCondition(
      () => fixture.store.listPendingApprovals().length === 1,
      "Replay did not reach approval.",
    );
    const approval = fixture.store.listPendingApprovals()[0];
    assert.ok(approval);
    await fixture.application.resolveApproval(approval.id, "denied");
    assert.equal(
      (await fixture.application.waitForRun(run.id)).status,
      "completed",
    );
    await assert.rejects(
      readFile(join(fixture.workspaceRoot, "reports/denied.md"), "utf8"),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ENOENT",
    );
    assert.equal(
      fixture.store.listToolCallsForRun(run.id)[0]?.status,
      "denied",
    );
    const secondManifest = fixture.store.listRunRequestManifests(run.id)[1];
    assert.equal(
      secondManifest?.messages.some((message) =>
        message.role === "tool" &&
        message.isError === true &&
        /denied/i.test(message.content)
      ),
      true,
    );
    assert.equal(provider.requests.some((request) => Boolean(request.credentials.apiKey)), false);
  } finally {
    await fixture.close();
  }
});

test("replays required user input inside the same run", async () => {
  const provider = new KeylessReplayProvider([
    {
      events: [
        {
          type: "tool-call",
          toolCall: {
            id: "replay-input-1",
            name: "request_user_input",
            arguments: { question: "Which reporting period?" },
          },
        },
        { type: "completed", finishReason: "tool-calls" },
      ],
    },
    {
      events: [
        { type: "text-delta", delta: "Prepared for 2026 Q2." },
        { type: "completed", finishReason: "stop" },
      ],
    },
  ]);
  const fixture = await createReplayFixture(provider, "request-approval");
  try {
    const run = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "Prepare the report.",
    });
    await waitForCondition(
      () => fixture.store.getRun(run.id)?.status === "waiting-input",
      "Replay did not request input.",
    );
    const resumed = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "2026 Q2",
    });
    assert.equal(resumed.id, run.id);
    assert.equal(
      (await fixture.application.waitForRun(run.id)).status,
      "completed",
    );
    assert.equal(provider.requests.length, 2);
    assert.equal(
      fixture.store.listRunRequestManifests(run.id)[1]?.messages.some(
        (message) => message.role === "tool" && message.content === "2026 Q2",
      ),
      true,
    );
    assert.match(replayTranscript(fixture, run.id), /Prepared for 2026 Q2/);
  } finally {
    await fixture.close();
  }
});

test("replays cancellation with partial output and no automatic resubmission", async () => {
  const provider = new KeylessReplayProvider([{
    events: [{ type: "text-delta", delta: "Partial replay output" }],
    waitForAbort: true,
  }]);
  const fixture = await createReplayFixture(provider, "request-approval");
  try {
    const run = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "Keep running until cancelled.",
    });
    await waitForCondition(
      () => fixture.store.getRunPartial(run.id) === "Partial replay output",
      "Replay partial output was not checkpointed.",
    );
    await fixture.application.cancelRun(run.id);
    assert.equal(
      (await fixture.application.waitForRun(run.id)).status,
      "cancelled",
    );
    assert.equal(provider.requests.length, 1);
    assert.equal(fixture.store.listRunRequestManifests(run.id).length, 1);
    assert.deepEqual(
      fixture.store.listRunUsageRecords(run.id).map((usage) => usage.status),
      ["unavailable"],
    );
    assert.match(replayTranscript(fixture, run.id), /Partial replay output/);
  } finally {
    await fixture.close();
  }
});

test("replays a crash after tool start as a monotonic unknown effect", async () => {
  const provider = new KeylessReplayProvider([{
    events: [
      {
        type: "tool-call",
        toolCall: {
          id: "replay-effect-1",
          name: "irreversible_effect",
          arguments: { operation: "publish" },
        },
      },
      { type: "completed", finishReason: "tool-calls" },
    ],
  }]);
  const effectTool = new BlockingEffectTool();
  const fixture = await createReplayFixture(
    provider,
    "auto-approve",
    {
      readFiles: "deny",
      writeFiles: "allow",
      runCommands: "deny",
    },
    [effectTool],
  );
  try {
    const run = await fixture.application.startRun({
      threadId: fixture.threadId,
      prompt: "Publish once.",
    });
    await effectTool.started;
    const toolCall = fixture.store.listToolCallsForRun(run.id)[0];
    assert.equal(toolCall?.status, "running");

    const recovered = new ScopeGuardApplication({
      store: fixture.store,
      secrets: fixture.vault,
      providerFactory: () => provider,
      tools: fixture.tools,
    });
    assert.equal(recovered.initialize().interruptedRuns, 1);
    assert.equal(
      fixture.store.getToolCall(toolCall?.id ?? "")?.status,
      "effect_unknown",
    );
    assert.equal(
      fixture.store.listRunEvents(run.id).some(
        (event) =>
          event.type === "tool-call" &&
          event.toolCall.status === "effect_unknown",
      ),
      true,
    );

    await fixture.application.shutdown();
    assert.equal(
      fixture.store.getToolCall(toolCall?.id ?? "")?.status,
      "effect_unknown",
      "a late cancellation must not overwrite the recovered terminal fact",
    );
    assert.match(replayTranscript(fixture, run.id), /effect is unknown/i);
    assert.equal(provider.requests.length, 1);

    const continuationProvider = new KeylessReplayProvider([{
      events: [
        { type: "text-delta", delta: "Continued without replaying the effect." },
        { type: "completed", finishReason: "stop" },
      ],
    }]);
    const continuation = new ScopeGuardApplication({
      store: fixture.store,
      secrets: fixture.vault,
      providerFactory: () => continuationProvider,
      tools: fixture.tools,
    });
    assert.equal(continuation.initialize().interruptedRuns, 0);
    const continuedRun = await continuation.startRun({
      threadId: fixture.threadId,
      prompt: "I verified the external state. Continue safely.",
    });
    assert.equal(
      (await continuation.waitForRun(continuedRun.id)).status,
      "completed",
    );
    assert.equal(continuationProvider.requests.length, 1);
    assert.equal(
      continuationProvider.requests[0]?.messages.some(
        (message) =>
          message.role === "tool" && /effect is unknown/i.test(message.content),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

async function createReplayFixture(
  provider: KeylessReplayProvider,
  executionProfile: ConversationExecutionProfile,
  toolPolicy: AgentToolPolicy = {
    readFiles: "allow",
    writeFiles: "allow",
    runCommands: "deny",
  },
  registeredTools?: AgentTool[],
) {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-keyless-replay-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(join(workspaceRoot, "reports"), { recursive: true });
  const store = new ScopeGuardStore(join(directory, "scopeguard.db"));
  const vault = new ReplayVault();
  const tools = new ScopeGuardToolRegistry(registeredTools);
  const application = new ScopeGuardApplication({
    store,
    secrets: vault,
    providerFactory: () => provider,
    tools,
  });
  application.initialize();
  const providerProfile = await application.saveProviderProfile({
    name: "Keyless replay",
    protocol: "openai-compatible",
    baseUrl: "https://not-contacted.invalid/v1",
    defaultModel: "replay-model",
  });
  const project = application.addProject({
    name: "Replay workspace",
    rootPath: workspaceRoot,
  });
  const agent = application.createAgentProfile({
    projectId: project.id,
    name: "Replay Agent",
    instructions: "Follow the replay script.",
    providerProfileId: providerProfile.id,
    executionProfile,
    toolPolicy,
  });
  const thread = application.createThread({
    projectId: project.id,
    agentProfileId: agent.id,
    title: "Replay task",
  });
  return {
    application,
    store,
    tools,
    vault,
    threadId: thread.id,
    workspaceRoot,
    async close() {
      await application.shutdown();
      await tools.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class BlockingEffectTool implements AgentTool {
  readonly permission = "writeFiles" as const;
  readonly definition = {
    name: "irreversible_effect",
    description: "Apply one externally visible effect.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string" },
      },
      required: ["operation"],
    },
  };
  readonly started: Promise<void>;
  readonly #markStarted: () => void;

  constructor() {
    let markStarted!: () => void;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.#markStarted = markStarted;
  }

  describe(): string {
    return "Apply the irreversible replay effect";
  }

  async execute(
    _input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.#markStarted();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(
        context.signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) {
        abort();
      }
    });
    return { output: "unreachable", isError: true };
  }
}

function replayTranscript(
  fixture: Awaited<ReturnType<typeof createReplayFixture>>,
  runId: string,
): string {
  return fixture.store.listThreadMessages(fixture.threadId)
    .filter((message) => message.runId === runId)
    .flatMap((message) => message.content)
    .map((block) => block.type === "text"
      ? block.text
      : block.type === "tool-result"
        ? block.output
        : "")
    .join("\n");
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

class ReplayVault implements SecretVault {
  readonly #values = new Map<string, string>();

  async put(reference: string, secret: string): Promise<string> {
    this.#values.set(reference, secret);
    return reference;
  }

  async get(reference: string): Promise<string | null> {
    return this.#values.get(reference) ?? null;
  }

  async delete(reference: string): Promise<void> {
    this.#values.delete(reference);
  }
}
