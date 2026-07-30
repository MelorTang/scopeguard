import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentTool,
  ModelToolDefinition,
  ProviderAdapter,
  ProviderCredentials,
  ProviderStreamEvent,
  ProviderTurnRequest,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "@scopeguard/agent-runtime";
import type {
  ApprovalDecision,
  RunEvent,
} from "@scopeguard/domain";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";

import {
  type CliAgentRunner,
  ScopeGuardApplication,
  type SecretVault,
} from "./index.js";

test("stores provider secrets outside SQLite and reuses them for connection tests", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    const profile = await fixture.application.saveProviderProfile({
      name: "Company relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1/",
      defaultModel: "test-model",
      apiKey: "sk-secret-value",
    });

    assert.match(profile.apiKeyRef ?? "", new RegExp(`^provider:${profile.id}:`));
    assert.equal("apiKey" in profile, false);
    assert.equal(
      await fixture.vault.get(profile.apiKeyRef ?? ""),
      "sk-secret-value",
    );

    await fixture.application.testProviderConnection({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      defaultModel: profile.defaultModel,
    });
    assert.equal(fixture.provider.testedCredentials?.apiKey, "sk-secret-value");

    const cleared = await fixture.application.saveProviderProfile({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      defaultModel: profile.defaultModel,
      clearApiKey: true,
    });
    assert.equal(cleared.apiKeyRef, null);
    assert.equal(
      [...fixture.vault.values.values()].includes("sk-secret-value"),
      false,
    );
  } finally {
    fixture.store.close();
  }
});

test("runs two Threads concurrently and cancels only the selected Run", async () => {
  const provider = new ControlledProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const secondAgent = fixture.application.createAgentProfile({
      projectId: workspace.project.id,
      name: "Second Agent",
      instructions: "Work independently.",
      providerProfileId: workspace.provider.id,
    });
    const secondThread = fixture.application.createThread({
      projectId: workspace.project.id,
      agentProfileId: secondAgent.id,
      title: "Second Thread",
    });

    const firstRun = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "First task",
    });
    const secondRun = await fixture.application.startRun({
      threadId: secondThread.id,
      prompt: "Second task",
    });
    await provider.waitForStarts(2);
    assert.equal(fixture.store.listActiveRuns().length, 2);

    const cancel = fixture.application.cancelRun(firstRun.id);
    provider.release("Second task");
    await Promise.all([
      cancel,
      fixture.application.waitForRun(secondRun.id),
    ]);

    assert.equal(fixture.store.getRun(firstRun.id)?.status, "cancelled");
    assert.equal(fixture.store.getRun(secondRun.id)?.status, "completed");
    assert.equal(
      messageText(fixture.store.listThreadMessages(workspace.thread.id)).includes(
        "Second task",
      ),
      false,
    );
    assert.equal(
      messageText(fixture.store.listThreadMessages(secondThread.id)).includes(
        "Second task",
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("persists a command approval and never executes after denial", async () => {
  const provider = new ToolCallingProvider();
  const command = new CountingTool();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([command]),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Run a command",
    });
    const approval = await waitForEvent(
      events,
      (event): event is Extract<RunEvent, { type: "approval-required" }> =>
        event.type === "approval-required",
    );

    assert.equal(fixture.store.getRun(run.id)?.status, "waiting-approval");
    await fixture.application.resolveApproval(approval.approval.id, "denied");
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(command.executeCount, 0);
    assert.equal(
      fixture.store.getApproval(approval.approval.id)?.status,
      "denied",
    );
    assert.equal(
      messageText(fixture.store.listThreadMessages(workspace.thread.id)).includes(
        "The user denied this tool call.",
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("expires a pending approval when its Run is cancelled", async () => {
  const provider = new ToolCallingProvider();
  const command = new CountingTool();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([command]),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Run a command",
    });
    const approvalEvent = await waitForEvent(
      events,
      (event): event is Extract<RunEvent, { type: "approval-required" }> =>
        event.type === "approval-required",
    );

    await fixture.application.cancelRun(run.id);

    assert.equal(fixture.store.getRun(run.id)?.status, "cancelled");
    assert.equal(
      fixture.store.getApproval(approvalEvent.approval.id)?.status,
      "expired",
    );
    assert.equal(
      fixture.store.getToolCall(approvalEvent.toolCall.id)?.status,
      "cancelled",
    );
    assert.equal(fixture.store.listPendingApprovals().length, 0);
    assert.equal(command.executeCount, 0);

    const continued = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Continue after cancellation",
    });
    assert.equal(
      (await fixture.application.waitForRun(continued.id)).status,
      "completed",
    );
    const secondRequest = provider.requests.at(-1);
    const cancelledResult = secondRequest?.messages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "provider-command-1",
    );
    assert.equal(cancelledResult?.role, "tool");
    assert.match(cancelledResult?.content ?? "", /cancelled/i);
  } finally {
    fixture.store.close();
  }
});

test("rejects context provenance from another Project or Thread", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    const first = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: first.thread.id,
      prompt: "Create source material",
    });
    await fixture.application.waitForRun(run.id);

    const secondProject = fixture.application.addProject({
      name: "Other Project",
      rootPath: "/tmp/scopeguard-application-other-project",
    });
    const secondAgent = fixture.application.createAgentProfile({
      projectId: secondProject.id,
      name: "Other Agent",
      instructions: "",
      providerProfileId: first.provider.id,
    });
    const secondThread = fixture.application.createThread({
      projectId: secondProject.id,
      agentProfileId: secondAgent.id,
      title: "Other Thread",
    });

    assert.throws(
      () => fixture.application.updateProjectContext(
        secondProject.id,
        "Cross-project source",
        secondThread.id,
        run.id,
      ),
      /source Run belongs to a different Project/,
    );

    const siblingAgent = fixture.application.createAgentProfile({
      projectId: first.project.id,
      name: "Sibling Agent",
      instructions: "",
      providerProfileId: first.provider.id,
    });
    const siblingThread = fixture.application.createThread({
      projectId: first.project.id,
      agentProfileId: siblingAgent.id,
      title: "Sibling Thread",
    });
    const siblingRun = await fixture.application.startRun({
      threadId: siblingThread.id,
      prompt: "Sibling source material",
    });
    await fixture.application.waitForRun(siblingRun.id);

    assert.throws(
      () => fixture.application.updateProjectContext(
        first.project.id,
        "Mismatched source",
        first.thread.id,
        siblingRun.id,
      ),
      /source Run belongs to a different Thread/,
    );
  } finally {
    fixture.store.close();
  }
});

test("redacts an arbitrary provider API key before persisting a Run error", async () => {
  const events: RunEvent[] = [];
  const provider = new EchoingErrorProvider();
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry(),
    (event) => events.push(event),
  );
  const secret = "relay-key-without-a-standard-prefix";
  try {
    const savedProvider = await fixture.application.saveProviderProfile({
      name: "Echoing relay",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "test-model",
      apiKey: secret,
    });
    const project = fixture.application.addProject({
      name: "Project",
      rootPath: "/tmp/scopeguard-redaction-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "Agent",
      instructions: "",
      providerProfileId: savedProvider.id,
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "Thread",
    });

    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Trigger provider error",
    });
    const failed = await fixture.application.waitForRun(run.id);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.includes(secret), false);
    assert.match(failed.error ?? "", /REDACTED/);
    assert.equal(JSON.stringify(events).includes(secret), false);
  } finally {
    fixture.store.close();
  }
});

test("rolls back Provider metadata when SecretVault cleanup fails", async () => {
  const vault = new FailingVault();
  const store = new ScopeGuardStore(":memory:");
  const application = new ScopeGuardApplication({
    store,
    secrets: vault,
    providerFactory: () => new ImmediateProvider(),
    tools: new FakeRegistry(),
  });
  application.initialize();
  try {
    const profile = await application.saveProviderProfile({
      name: "Relay",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "model",
      apiKey: "old-key",
    });
    const originalReference = profile.apiKeyRef;
    assert.ok(originalReference);

    vault.failDeleteReference = originalReference;
    await assert.rejects(
      () => application.saveProviderProfile({
        id: profile.id,
        name: profile.name,
        protocol: profile.protocol,
        baseUrl: profile.baseUrl,
        defaultModel: profile.defaultModel,
        apiKey: "new-key",
      }),
      /Injected SecretVault delete failure/,
    );
    assert.equal(
      store.getProviderProfile(profile.id)?.apiKeyRef,
      originalReference,
    );
    assert.equal(await vault.get(originalReference), "old-key");
    assert.equal([...vault.values.values()].includes("new-key"), false);

    await assert.rejects(
      () => application.saveProviderProfile({
        id: profile.id,
        name: profile.name,
        protocol: profile.protocol,
        baseUrl: profile.baseUrl,
        defaultModel: profile.defaultModel,
        clearApiKey: true,
      }),
      /Injected SecretVault delete failure/,
    );
    assert.equal(
      store.getProviderProfile(profile.id)?.apiKeyRef,
      originalReference,
    );
  } finally {
    store.close();
  }
});

test("rejects plaintext custom headers and CLI environment values", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    await assert.rejects(
      () => fixture.application.saveProviderProfile({
        name: "Unsafe relay",
        protocol: "openai-compatible",
        baseUrl: "https://provider.example.com/v1",
        defaultModel: "test-model",
        customHeaders: { "X-Secret": "plaintext" },
      }),
      /Custom headers are disabled/,
    );

    const workspace = await createWorkspace(fixture.application);
    assert.throws(
      () => fixture.application.createAgentProfile({
        projectId: workspace.project.id,
        name: "CLI",
        runtimeKind: "local-cli",
        instructions: "",
        cliConfig: {
          command: "agent",
          args: [],
          cwd: null,
          env: { AGENT_TOKEN: "plaintext" },
        },
      }),
      /environment variables are disabled/,
    );
  } finally {
    fixture.store.close();
  }
});

test("runs and persists an optional local CLI Agent without a Provider", async () => {
  const cliRunner = new ImmediateCliRunner();
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    cliRunner,
  );
  try {
    const project = fixture.application.addProject({
      name: "CLI Project",
      rootPath: "/tmp/scopeguard-cli-application-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "Local CLI",
      runtimeKind: "local-cli",
      instructions: "Answer from the local CLI.",
      cliConfig: {
        command: "local-agent",
        args: ["--prompt", "{prompt}"],
        cwd: null,
        env: {},
      },
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "CLI Thread",
    });

    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Inspect the project",
    });
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.configSnapshot.runtimeKind, "local-cli");
    assert.equal(completed.configSnapshot.providerProfileId, null);
    assert.match(cliRunner.prompt, /Inspect the project/);
    assert.match(
      messageText(fixture.store.listThreadMessages(thread.id)),
      /CLI answer/,
    );
  } finally {
    fixture.store.close();
  }
});

test("persists partial provider output when a Run fails", async () => {
  const fixture = createApplicationFixture(new PartialErrorProvider());
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Start a partial response",
    });
    const failed = await fixture.application.waitForRun(run.id);
    const partial = fixture.store.listThreadMessages(workspace.thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );

    assert.equal(failed.status, "failed");
    assert.equal(messageText(partial ? [partial] : []), "Partial answer");
  } finally {
    fixture.store.close();
  }
});

test("cancels a local CLI Run and persists its partial output", async () => {
  const cliRunner = new ControlledCliRunner();
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    cliRunner,
  );
  try {
    const project = fixture.application.addProject({
      rootPath: "/tmp/scopeguard-cli-cancel-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "CLI",
      runtimeKind: "local-cli",
      instructions: "",
      cliConfig: {
        command: "local-agent",
        args: [],
        cwd: null,
        env: {},
      },
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Long task",
    });
    await cliRunner.started;

    await fixture.application.cancelRun(run.id);

    assert.equal(fixture.store.getRun(run.id)?.status, "cancelled");
    const partial = fixture.store.listThreadMessages(thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );
    assert.equal(messageText(partial ? [partial] : []), "CLI started\n");
  } finally {
    fixture.store.close();
  }
});

test("interrupts active Runs and persists partial output during shutdown", async () => {
  const cliRunner = new ControlledCliRunner();
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    cliRunner,
  );
  try {
    const project = fixture.application.addProject({
      rootPath: "/tmp/scopeguard-cli-shutdown-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "CLI",
      runtimeKind: "local-cli",
      instructions: "",
      cliConfig: {
        command: "local-agent",
        args: [],
        cwd: null,
        env: {},
      },
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Long task",
    });
    await cliRunner.started;

    await fixture.application.shutdown();

    const interrupted = fixture.store.getRun(run.id);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(
      interrupted?.error,
      "The agent host stopped before this run completed.",
    );
    const partial = fixture.store.listThreadMessages(thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );
    assert.equal(messageText(partial ? [partial] : []), "CLI started\n");
  } finally {
    fixture.store.close();
  }
});

class MemoryVault implements SecretVault {
  readonly values = new Map<string, string>();

  async put(reference: string, secret: string): Promise<string> {
    this.values.set(reference, secret);
    return reference;
  }

  async get(reference: string): Promise<string | null> {
    return this.values.get(reference) ?? null;
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

class FailingVault extends MemoryVault {
  failDeleteReference: string | null = null;

  override async delete(reference: string): Promise<void> {
    if (reference === this.failDeleteReference) {
      throw new Error("Injected SecretVault delete failure.");
    }
    await super.delete(reference);
  }
}

class ImmediateProvider implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;
  testedCredentials: ProviderCredentials | null = null;

  async testConnection(credentials: ProviderCredentials) {
    this.testedCredentials = credentials;
    return {
      ok: true,
      latencyMs: 1,
      model: credentials.model,
      message: "ok",
    };
  }

  async *streamTurn(
    _request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", delta: "Done" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class ControlledProvider extends ImmediateProvider {
  readonly #startedPrompts: string[] = [];
  readonly #waiters: Array<() => void> = [];
  readonly #releases = new Map<string, () => void>();

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const prompt = [...request.messages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
    const gate = new Promise<void>((resolve, reject) => {
      const abort = () => reject(
        request.signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
      request.signal.addEventListener("abort", abort, { once: true });
      this.#releases.set(prompt, () => {
        request.signal.removeEventListener("abort", abort);
        resolve();
      });
      if (request.signal.aborted) {
        abort();
      }
    });
    this.#startedPrompts.push(prompt);
    this.#notifyWaiters();
    yield { type: "text-delta", delta: `Working on ${prompt}` };
    await gate;
    yield { type: "completed", finishReason: "stop" };
  }

  release(prompt: string): void {
    const release = this.#releases.get(prompt);
    if (!release) {
      throw new Error(`Provider prompt has not started: ${prompt}`);
    }
    this.#releases.delete(prompt);
    release();
  }

  async waitForStarts(count: number): Promise<void> {
    if (this.#startedPrompts.length >= count) {
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (this.#startedPrompts.length < count) {
      await this.waitForStarts(count);
    }
  }

  #notifyWaiters(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter();
    }
  }
}

class EchoingErrorProvider extends ImmediateProvider {
  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    throw new Error(`Provider echoed ${request.credentials.apiKey}`);
  }
}

class PartialErrorProvider extends ImmediateProvider {
  override async *streamTurn(): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", delta: "Partial answer" };
    throw new Error("Provider disconnected.");
  }
}

class ToolCallingProvider extends ImmediateProvider {
  callCount = 0;
  readonly requests: ProviderTurnRequest[] = [];

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        type: "tool-call",
        toolCall: {
          id: "provider-command-1",
          name: "run_command",
          arguments: { command: "echo should-not-run" },
        },
      };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", delta: "The command was denied." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class CountingTool implements AgentTool {
  readonly permission = "runCommands" as const;
  readonly definition: ModelToolDefinition = {
    name: "run_command",
    description: "Run a command",
    inputSchema: { type: "object" },
  };
  executeCount = 0;

  describe(input: Record<string, unknown>): string {
    return `Run command: ${String(input.command ?? "")}`;
  }

  async execute(
    _input: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.executeCount += 1;
    return { output: "executed", isError: false };
  }
}

class FakeRegistry implements ToolRegistry {
  readonly #tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[] = []) {
    this.#tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  definitions(): ModelToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  get(name: string): AgentTool | null {
    return this.#tools.get(name) ?? null;
  }
}

function createApplicationFixture(
  provider: ImmediateProvider,
  tools: ToolRegistry = new FakeRegistry(),
  publish?: (event: RunEvent) => void,
  cliRunner?: CliAgentRunner,
) {
  const store = new ScopeGuardStore(":memory:");
  const vault = new MemoryVault();
  const application = new ScopeGuardApplication({
    store,
    secrets: vault,
    providerFactory: () => provider,
    tools,
    publish,
    cliRunner,
  });
  application.initialize();
  return { application, store, vault, provider };
}

class ImmediateCliRunner implements CliAgentRunner {
  prompt = "";

  async run(input: Parameters<CliAgentRunner["run"]>[0]) {
    this.prompt = input.prompt;
    input.onOutput({ stream: "stdout", chunk: "CLI answer" });
    return { stdout: "CLI answer", stderr: "" };
  }
}

class ControlledCliRunner implements CliAgentRunner {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  async run(input: Parameters<CliAgentRunner["run"]>[0]) {
    input.onOutput({ stream: "stdout", chunk: "CLI started\n" });
    this.#resolveStarted();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("CLI aborted.");
        Object.assign(error, { code: "CLI_AGENT_ABORTED" });
        reject(error);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) {
        abort();
      }
    });
    return { stdout: "", stderr: "" };
  }
}

async function createWorkspace(application: ScopeGuardApplication) {
  const provider = await application.saveProviderProfile({
    name: "Test provider",
    protocol: "openai-compatible",
    baseUrl: "https://provider.example.com/v1",
    defaultModel: "test-model",
  });
  const project = application.addProject({
    name: "Project",
    rootPath: "/tmp/scopeguard-application-test",
  });
  const agent = application.createAgentProfile({
    projectId: project.id,
    name: "General",
    instructions: "Be concise.",
    providerProfileId: provider.id,
  });
  const thread = application.createThread({
    projectId: project.id,
    agentProfileId: agent.id,
    title: "First Thread",
  });
  return { provider, project, agent, thread };
}

function messageText(messages: ReturnType<ScopeGuardStore["listThreadMessages"]>): string {
  return messages
    .flatMap((message) => message.content)
    .map((block) => block.type === "text"
      ? block.text
      : block.type === "tool-result"
        ? block.output
        : "")
    .join("\n");
}

async function waitForEvent<T extends RunEvent>(
  events: RunEvent[],
  predicate: (event: RunEvent) => event is T,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for application event.");
}
