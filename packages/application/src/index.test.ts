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
  ConversationExecutionProfile,
  RunEvent,
} from "@scopeguard/domain";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";

import {
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

test("runs an API Agent without a local folder and exposes no file or command tools", async () => {
  const provider = new RecordingProvider();
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([new CountingTool()]),
  );
  try {
    const workspace = fixture.application.createWorkspace({
      name: "Knowledge workspace",
    });
    const providerProfile = await fixture.application.saveProviderProfile({
      name: "Direct model",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "general-model",
    });
    const agent = fixture.application.createAgent({
      workspaceId: workspace.id,
      name: "Researcher",
      instructions: "Prepare a concise evidence brief.",
      providerProfileId: providerProfile.id,
      toolPolicy: {
        readFiles: "allow",
        writeFiles: "allow",
        runCommands: "allow",
      },
    });
    const thread = fixture.application.createConversation({
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Evidence brief",
    });

    const run = await fixture.application.startRun({
      conversationId: thread.id,
      prompt: "Summarize the approved evidence.",
    });
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.configSnapshot.toolPolicy, {
      readFiles: "deny",
      writeFiles: "deny",
      runCommands: "deny",
    });
    assert.deepEqual(
      provider.request?.tools.map((tool) => tool.name),
      ["request_user_input"],
    );
    assert.equal(
      JSON.stringify(provider.request?.messages).includes("scopeguard://workspace"),
      false,
    );
    assert.deepEqual(
      fixture.store.listRunUsageRecords(run.id).map((record) => ({
        status: record.status,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      })),
      [{ status: "unavailable", inputTokens: null, outputTokens: null }],
    );
  } finally {
    fixture.store.close();
  }
});

test("resumes a desktop core Run from a Conversation input request", async () => {
  const provider = new InputRequestProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "Prepare the report.",
    });
    await waitForCondition(
      () => fixture.store.getRun(run.id)?.status === "waiting-input",
      "Desktop core Run did not wait for user input.",
    );

    const inputRequest = fixture.store.listConversationMessages(workspace.thread.id)
      .find((message) => message.metadata.inputRequest === true);
    assert.match(messageText(inputRequest ? [inputRequest] : []), /reporting period/);

    const resumed = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "Use 2026 Q2.",
    });
    assert.equal(resumed.id, run.id);
    assert.equal((await fixture.application.waitForRun(run.id)).status, "completed");
    assert.equal(provider.requests[1]?.messages.at(-1)?.role, "tool");
    assert.equal(provider.requests[1]?.messages.at(-1)?.content, "Use 2026 Q2.");
  } finally {
    fixture.store.close();
  }
});

test("persists local Native request manifests and provider usage without credentials", async () => {
  const provider = new UsageRecordingProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = fixture.application.createWorkspace({ name: "Ledger" });
    const providerProfile = await fixture.application.saveProviderProfile({
      name: "Private relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      defaultModel: "ledger-model",
      apiKey: "sk-ledger-secret",
    });
    const agent = fixture.application.createAgent({
      workspaceId: workspace.id,
      name: "Ledger Agent",
      instructions: "Answer from the durable request.",
      providerProfileId: providerProfile.id,
    });
    const thread = fixture.application.createConversation({
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Ledger Run",
    });

    const run = await fixture.application.startRun({
      conversationId: thread.id,
      prompt: "Record this request.",
    });
    const completed = await fixture.application.waitForRun(run.id);
    assert.equal(completed.status, "completed");

    const manifests = fixture.store.listRunRequestManifests(run.id);
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0]?.stepSequence, 1);
    assert.equal(manifests[0]?.model, "ledger-model");
    assert.match(manifests[0]?.requestHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      manifests[0]?.messages.some(
        (message) => message.role === "user" && message.content === "Record this request.",
      ),
      true,
    );
    const durablePayload = JSON.stringify(manifests);
    assert.equal(durablePayload.includes("sk-ledger-secret"), false);
    assert.equal(durablePayload.includes("relay.example.com"), false);

    const secondThread = fixture.application.createConversation({
      workspaceId: workspace.id,
      agentId: agent.id,
      title: "Equivalent Ledger Run",
    });
    const equivalentRun = await fixture.application.startRun({
      conversationId: secondThread.id,
      prompt: "Record this request.",
    });
    await fixture.application.waitForRun(equivalentRun.id);
    assert.equal(
      fixture.store.listRunRequestManifests(equivalentRun.id)[0]?.requestHash,
      manifests[0]?.requestHash,
    );

    assert.deepEqual(
      fixture.store.listRunUsageRecords(run.id).map((record) => ({
        sequence: record.sequence,
        stepSequence: record.stepSequence,
        status: record.status,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      })),
      [
        {
          sequence: 1,
          stepSequence: 1,
          status: "reported",
          inputTokens: 21,
          outputTokens: null,
        },
        {
          sequence: 2,
          stepSequence: 1,
          status: "reported",
          inputTokens: null,
          outputTokens: 5,
        },
      ],
    );
  } finally {
    fixture.store.close();
  }
});

test("fails a Native Run before provider invocation when manifest storage fails", async () => {
  const provider = new RecordingProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    fixture.store.recordRunRequestManifest = () => {
      throw new Error("Injected manifest storage failure.");
    };

    const run = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "This must not reach the provider.",
    });
    const failed = await fixture.application.waitForRun(run.id);

    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /manifest storage failure/);
    assert.equal(provider.requests.length, 0);
  } finally {
    fixture.store.close();
  }
});

test("snapshots model and execution settings from the current conversation", async () => {
  const provider = new RecordingProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const { project, agent, thread } = await createWorkspace(fixture.application);
    const sibling = fixture.application.createConversation({
      workspaceId: project.id,
      agentId: agent.id,
      title: "Sibling Thread",
    });

    fixture.application.updateConversationSettings({
      conversationId: thread.id,
      modelOverride: "specialist-model",
      executionProfile: "full-access",
    });
    const run = await fixture.application.startRun({
      conversationId: thread.id,
      prompt: "Use this conversation's settings.",
    });
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.configSnapshot.model, "specialist-model");
    assert.equal(completed.configSnapshot.executionProfile, "full-access");
    assert.equal(provider.request?.credentials.model, "specialist-model");
    assert.equal(
      fixture.store.getConversation(sibling.id)?.executionProfile,
      "request-approval",
    );
    assert.equal(fixture.store.getConversation(sibling.id)?.modelOverride, null);
  } finally {
    fixture.store.close();
  }
});

test("runs two Conversations concurrently and cancels only the selected Run", async () => {
  const provider = new ControlledProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const secondAgent = fixture.application.createAgent({
      workspaceId: workspace.project.id,
      name: "Second Agent",
      instructions: "Work independently.",
      providerProfileId: workspace.provider.id,
    });
    const secondThread = fixture.application.createConversation({
      workspaceId: workspace.project.id,
      agentId: secondAgent.id,
      title: "Second Thread",
    });

    const firstRun = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "First task",
    });
    const secondRun = await fixture.application.startRun({
      conversationId: secondThread.id,
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
      messageText(fixture.store.listConversationMessages(workspace.thread.id)).includes(
        "Second task",
      ),
      false,
    );
    assert.equal(
      messageText(fixture.store.listConversationMessages(secondThread.id)).includes(
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
      conversationId: workspace.thread.id,
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
      messageText(fixture.store.listConversationMessages(workspace.thread.id)).includes(
        "The user denied this tool call.",
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("auto approve skips the prompt but preserves managed execution progress", async () => {
  const provider = new ToolCallingProvider();
  const command = new CountingTool();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([command]),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(
      fixture.application,
      "auto-approve",
    );
    const run = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "Run without another prompt",
    });
    assert.equal((await fixture.application.waitForRun(run.id)).status, "completed");
    assert.equal(command.executeCount, 1);
    assert.equal(
      events.some((event) => event.type === "approval-required"),
      false,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "managed-execution")
        .map((event) => event.progress.stage),
      ["provisioning", "running", "cleaning"],
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
      conversationId: workspace.thread.id,
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
      conversationId: workspace.thread.id,
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
    const project = fixture.application.createWorkspace({
      name: "Project",
      localRootPath: "/tmp/scopeguard-redaction-test",
    });
    const agent = fixture.application.createAgent({
      workspaceId: project.id,
      name: "Agent",
      instructions: "",
      providerProfileId: savedProvider.id,
    });
    const thread = fixture.application.createConversation({
      workspaceId: project.id,
      agentId: agent.id,
      title: "Thread",
    });

    const run = await fixture.application.startRun({
      conversationId: thread.id,
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

test("rejects plaintext custom provider headers", async () => {
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
  } finally {
    fixture.store.close();
  }
});

test("persists partial provider output when a Run fails", async () => {
  const fixture = createApplicationFixture(new PartialErrorProvider());
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "Start a partial response",
    });
    const failed = await fixture.application.waitForRun(run.id);
    const partial = fixture.store.listConversationMessages(workspace.thread.id)
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

test("interrupts active Runs and persists partial output during shutdown", async () => {
  const provider = new ControlledProvider();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry(),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "Long task",
    });
    await provider.waitForStarts(1);
    await waitForEvent(
      events,
      (event): event is Extract<RunEvent, { type: "assistant-delta" }> =>
        event.type === "assistant-delta",
    );

    await fixture.application.shutdown();

    const interrupted = fixture.store.getRun(run.id);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(
      interrupted?.error,
      "The agent host stopped before this run completed.",
    );
    const partial = fixture.store.listConversationMessages(workspace.thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );
    assert.equal(messageText(partial ? [partial] : []), "Working on Long task");
  } finally {
    fixture.store.close();
  }
});

test("recovers a started tool call as effect unknown after an unclean restart", async () => {
  const provider = new ControlledProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      conversationId: workspace.thread.id,
      prompt: "Start work before the process crashes",
    });
    await provider.waitForStarts(1);

    const toolCall = fixture.store.createToolCall(run.id, {
      providerCallId: "provider-crash-1",
      name: "run_command",
      description: "Run a non-idempotent command",
      arguments: { command: "publish-report" },
    });
    fixture.store.updateToolCallStatus(toolCall.id, "running");
    const proposedCall = fixture.store.createToolCall(run.id, {
      providerCallId: "provider-crash-2",
      name: "write_file",
      description: "Write a file after approval",
      arguments: { path: "report.md" },
    });
    const awaitingApprovalCall = fixture.store.createToolCall(run.id, {
      providerCallId: "provider-crash-3",
      name: "run_command",
      description: "Wait for approval",
      arguments: { command: "echo safe" },
    });
    fixture.store.updateToolCallStatus(awaitingApprovalCall.id, "awaiting-approval");
    fixture.store.createApproval(
      run.id,
      awaitingApprovalCall.id,
      "Wait for approval",
    );
    const alreadyCancelledCall = fixture.store.createToolCall(run.id, {
      providerCallId: "provider-crash-4",
      name: "run_command",
      description: "Already cancelled",
      arguments: { command: "echo cancelled" },
    });
    fixture.store.updateToolCallStatus(alreadyCancelledCall.id, "cancelled");
    fixture.store.appendMessage({
      conversationId: workspace.thread.id,
      runId: run.id,
      role: "assistant",
      status: "committed",
      content: [toolCall, proposedCall, awaitingApprovalCall, alreadyCancelledCall]
        .map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          providerCallId: call.providerCallId,
          name: call.name,
          arguments: call.arguments,
        })),
      metadata: {},
    });

    const recovered = new ScopeGuardApplication({
      store: fixture.store,
      secrets: fixture.vault,
      providerFactory: () => fixture.provider,
      tools: new FakeRegistry(),
    });
    assert.equal(recovered.initialize().interruptedRuns, 1);

    assert.equal(
      fixture.store.getToolCall(toolCall.id)?.status,
      "effect_unknown",
    );
    const recoveredResult = fixture.store.listConversationMessages(workspace.thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "tool" &&
        message.content.some((block) =>
          block.type === "tool-result" && block.toolCallId === toolCall.id
        )
      );
    assert.equal(recoveredResult?.status, "interrupted");
    assert.equal(recoveredResult?.metadata.effectUnknown, true);
    assert.match(messageText(recoveredResult ? [recoveredResult] : []), /effect is unknown/i);
    for (const call of [proposedCall, awaitingApprovalCall]) {
      assert.equal(fixture.store.getToolCall(call.id)?.status, "cancelled");
      const result = fixture.store.listConversationMessages(workspace.thread.id)
        .find((message) => message.content.some((block) =>
          block.type === "tool-result" && block.toolCallId === call.id
        ));
      assert.equal(result?.metadata.effectUnknown, false);
      assert.match(messageText(result ? [result] : []), /cancelled before execution/i);
    }
    assert.equal(
      fixture.store.listConversationMessages(workspace.thread.id).some(
        (message) => message.content.some((block) =>
          block.type === "tool-result" && block.toolCallId === alreadyCancelledCall.id
        ),
      ),
      false,
    );

  } finally {
    await fixture.application.shutdown();
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

class RecordingProvider extends ImmediateProvider {
  request: ProviderTurnRequest | null = null;
  readonly requests: ProviderTurnRequest[] = [];

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.request = request;
    this.requests.push(request);
    yield* super.streamTurn(request);
  }
}

class UsageRecordingProvider extends RecordingProvider {
  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.request = request;
    this.requests.push(request);
    yield { type: "usage", inputTokens: 21 };
    yield { type: "text-delta", delta: "Recorded" };
    yield { type: "usage", outputTokens: 5 };
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
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.#releases.set(prompt, releaseGate);
    this.#startedPrompts.push(prompt);
    this.#notifyWaiters();
    yield { type: "text-delta", delta: `Working on ${prompt}` };
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(
        request.signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
      request.signal.addEventListener("abort", abort, { once: true });
      void gate.then(() => {
        request.signal.removeEventListener("abort", abort);
        resolve();
      });
      if (request.signal.aborted) {
        abort();
      }
    });
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

class InputRequestProvider extends ImmediateProvider {
  readonly requests: ProviderTurnRequest[] = [];

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: "tool-call",
        toolCall: {
          id: "provider-input-1",
          name: "request_user_input",
          arguments: { question: "Which reporting period should I use?" },
        },
      };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", delta: "Report prepared for 2026 Q2." };
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
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.executeCount += 1;
    for (const stage of ["provisioning", "running", "cleaning"] as const) {
      context.onManagedExecutionEvent?.({
        executionId: "test-execution",
        stage,
        at: new Date().toISOString(),
      });
    }
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
) {
  const store = new ScopeGuardStore(":memory:");
  const vault = new MemoryVault();
  const application = new ScopeGuardApplication({
    store,
    secrets: vault,
    providerFactory: () => provider,
    tools,
    publish,
  });
  application.initialize();
  return { application, store, vault, provider };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(timeoutMessage);
}

async function createWorkspace(
  application: ScopeGuardApplication,
  executionProfile: ConversationExecutionProfile = "request-approval",
) {
  const provider = await application.saveProviderProfile({
    name: "Test provider",
    protocol: "openai-compatible",
    baseUrl: "https://provider.example.com/v1",
    defaultModel: "test-model",
  });
  const project = application.createWorkspace({
    name: "Project",
    localRootPath: "/tmp/scopeguard-application-test",
  });
  const agent = application.createAgent({
    workspaceId: project.id,
    name: "General",
    instructions: "Be concise.",
    providerProfileId: provider.id,
    executionProfile,
  });
  const thread = application.createConversation({
    workspaceId: project.id,
    agentId: agent.id,
    title: "First Thread",
  });
  return { provider, project, agent, thread };
}

function messageText(messages: ReturnType<ScopeGuardStore["listConversationMessages"]>): string {
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
