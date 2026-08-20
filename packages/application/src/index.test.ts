import assert from "node:assert/strict";
import test from "node:test";

import type { PiRuntimeSupervisor } from "@scopeguard/pi-runtime";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";

import { ScopeGuardApplication } from "./index.js";

test("runs a Conversation through the injected Pi Runtime and stores only its locator", async () => {
  const store = new ScopeGuardStore(":memory:");
  const runtime = {
    validateLocator() {},
    projectMessages() { return []; },
    async probe() {},
    async shutdown() {},
    async run(options: {
      conversationId: string;
      onSessionReady?: (locator: {
        sessionFile: string;
        sessionId: string;
        piVersion: "0.84.2";
        sessionVersion: 3;
      }) => void;
      onApproval: (request: {
        processId: string;
        requestId: string;
        toolCallId: string;
        toolName: string;
        canonicalInput: Record<string, unknown>;
        canonicalInputSha256: string;
      }) => Promise<boolean>;
    }) {
      const locator = {
        sessionFile: `/sessions/${options.conversationId}/session.jsonl`,
        sessionId: "pi-session",
        piVersion: "0.84.2" as const,
        sessionVersion: 3 as const,
      };
      options.onSessionReady?.(locator);
      assert.equal(store.getConversation(options.conversationId)?.piSession?.sessionId, "pi-session");
      const approved = await options.onApproval({
        processId: `process-${options.conversationId}`,
        requestId: `request-${options.conversationId}`,
        toolCallId: `tool-${options.conversationId}`,
        toolName: "write",
        canonicalInput: { path: "report.md", content: "done" },
        canonicalInputSha256: "a".repeat(64),
      });
      assert.equal(approved, true);
      assert.equal(store.listActiveRuns()[0]?.effect, "effect_unknown");
      return {
        locator,
        effect: "confirmed" as const,
        messages: [],
      };
    },
  } as unknown as PiRuntimeSupervisor;
  const secrets = {
    async put(reference: string) { return reference; },
    async get() { return null; },
    async delete() {},
  };
  let application: ScopeGuardApplication;
  let interactiveApprovals = 0;
  application = new ScopeGuardApplication({
    store,
    secrets,
    runtime,
    publish(event) {
      if (event.type === "approval-required") {
        interactiveApprovals += 1;
        queueMicrotask(() => void application.resolveApproval(event.approval.id, "approved-once"));
      }
    },
  });
  try {
    const workspace = application.createWorkspace({ name: "Workspace" });
    const provider = await application.saveProviderProfile({
      name: "Provider", protocol: "openai-compatible", baseUrl: "http://127.0.0.1/v1", defaultModel: "model",
    });
    const agent = application.createAgent({ workspaceId: workspace.id, name: "Agent", instructions: "Help", providerProfileId: provider.id });
    const conversation = application.createConversation({ workspaceId: workspace.id, agentId: agent.id });
    const run = await application.startRun({ conversationId: conversation.id, prompt: "Hello" });
    const completed = await application.waitForRun(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.effect, "confirmed");
    assert.equal(store.getConversation(conversation.id)?.piSession?.sessionId, "pi-session");
    assert.equal(store.listSchemaTables().includes("conversation_messages"), false);

    const automaticAgent = application.createAgent({
      workspaceId: workspace.id, name: "Automatic Agent", instructions: "Help",
      providerProfileId: provider.id, executionProfile: "auto-approve",
      toolPolicy: { runCommands: "allow" },
    });
    const automaticConversation = application.createConversation({
      workspaceId: workspace.id,
      agentId: automaticAgent.id,
    });
    const automaticRun = await application.startRun({
      conversationId: automaticConversation.id,
      prompt: "Automatic",
    });
    assert.equal((await application.waitForRun(automaticRun.id)).status, "completed");
    assert.equal(interactiveApprovals, 1);
    assert.equal(store.getWorkspaceSnapshot().pendingApprovals.length, 0);
  } finally {
    await application.shutdown();
    store.close();
  }
});

test("turns a Provider vault read failure into an explicit failed Run", async () => {
  const store = new ScopeGuardStore(":memory:");
  const runtime = {
    validateLocator() {}, projectMessages() { return []; }, async probe() {}, async shutdown() {},
    async run() { throw new Error("Runtime must not start without its credential."); },
  } as unknown as PiRuntimeSupervisor;
  const application = new ScopeGuardApplication({
    store,
    runtime,
    secrets: {
      async put(reference: string) { return reference; },
      async get() { throw new Error("Credential vault unavailable."); },
      async delete() {},
    },
  });
  try {
    const workspace = application.createWorkspace({ name: "Workspace" });
    const provider = await application.saveProviderProfile({
      name: "Provider", protocol: "openai-compatible", baseUrl: "http://127.0.0.1/v1",
      defaultModel: "model", apiKey: "fixture-key",
    });
    const agent = application.createAgent({
      workspaceId: workspace.id, name: "Agent", instructions: "Help",
      providerProfileId: provider.id,
    });
    const conversation = application.createConversation({ workspaceId: workspace.id, agentId: agent.id });
    const run = await application.startRun({ conversationId: conversation.id, prompt: "Hello" });
    const failed = await application.waitForRun(run.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /vault unavailable/);
  } finally {
    await application.shutdown();
    store.close();
  }
});

test("expires an unanswered approval before the Runtime timeout and completes denied", async () => {
  const store = new ScopeGuardStore(":memory:");
  let approvalId: string | null = null;
  const runtime = {
    validateLocator() {}, projectMessages() { return []; }, async probe() {}, async shutdown() {},
    async run(options: {
      conversationId: string;
      onApproval: (request: {
        processId: string;
        requestId: string;
        toolCallId: string;
        toolName: string;
        canonicalInput: Record<string, unknown>;
        canonicalInputSha256: string;
      }) => Promise<boolean>;
    }) {
      const approved = await options.onApproval({
        processId: "process-timeout",
        requestId: "request-timeout",
        toolCallId: "tool-timeout",
        toolName: "write",
        canonicalInput: { path: "must-not-exist.txt", content: "blocked" },
        canonicalInputSha256: "b".repeat(64),
      });
      assert.equal(approved, false);
      return {
        locator: {
          sessionFile: `/sessions/${options.conversationId}/session.jsonl`,
          sessionId: "timeout-session",
          piVersion: "0.84.2" as const,
          sessionVersion: 3 as const,
        },
        effect: "none" as const,
        messages: [],
      };
    },
  } as unknown as PiRuntimeSupervisor;
  const application = new ScopeGuardApplication({
    store,
    runtime,
    approvalTimeoutMs: 20,
    secrets: {
      async put(reference: string) { return reference; },
      async get() { return null; },
      async delete() {},
    },
    publish(event) {
      if (event.type === "approval-required") approvalId = event.approval.id;
    },
  });
  try {
    const workspace = application.createWorkspace({ name: "Workspace" });
    const provider = await application.saveProviderProfile({
      name: "Provider",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1/v1",
      defaultModel: "model",
    });
    const agent = application.createAgent({
      workspaceId: workspace.id,
      name: "Agent",
      instructions: "Help",
      providerProfileId: provider.id,
    });
    const conversation = application.createConversation({ workspaceId: workspace.id, agentId: agent.id });
    const run = await application.startRun({ conversationId: conversation.id, prompt: "Write" });
    assert.equal((await application.waitForRun(run.id)).status, "completed");
    assert.ok(approvalId);
    assert.equal(store.getApproval(approvalId)?.status, "expired");
    assert.equal(store.listPendingApprovals().length, 0);
  } finally {
    await application.shutdown();
    store.close();
  }
});

test("runs four independent Conversations concurrently", async () => {
  const store = new ScopeGuardStore(":memory:");
  const pending = new Map<string, ReturnType<typeof deferredRun>>();
  const runtime = {
    validateLocator() {}, projectMessages() { return []; }, async probe() {}, async shutdown() {},
    run(options: { conversationId: string; signal: AbortSignal; onSessionReady?: (locator: ReturnType<typeof locatorFor>) => void }) {
      const deferred = deferredRun();
      pending.set(options.conversationId, deferred);
      options.signal.addEventListener("abort", () => deferred.reject(
        options.signal.reason ?? new DOMException("Cancelled", "AbortError"),
      ), { once: true });
      options.onSessionReady?.(locatorFor(options.conversationId));
      return deferred.promise.then(() => ({
        locator: locatorFor(options.conversationId),
        effect: "none" as const,
        messages: [],
      }));
    },
  } as unknown as PiRuntimeSupervisor;
  const application = new ScopeGuardApplication({
    store,
    runtime,
    secrets: memorySecrets(),
  });
  try {
    const { workspace, agent } = await createApplicationFixture(application);
    const conversations = Array.from({ length: 4 }, (_, index) =>
      application.createConversation({
        workspaceId: workspace.id,
        agentId: agent.id,
        title: `Parallel ${index + 1}`,
      })
    );
    const runs = await Promise.all(conversations.map((conversation) =>
      application.startRun({ conversationId: conversation.id, prompt: "Work independently" })
    ));
    assert.equal(store.listActiveRuns().length, 4);
    await assert.rejects(
      application.startRun({ conversationId: conversations[0]!.id, prompt: "Conflict" }),
      /already has an active Run/,
    );
    await application.cancelRun(runs[0]!.id);
    assert.equal((await application.waitForRun(runs[0]!.id)).status, "cancelled");
    assert.equal(store.listActiveRuns().length, 3);
    for (const conversation of conversations.slice(1)) pending.get(conversation.id)!.resolve();
    assert.deepEqual(await Promise.all(
      runs.slice(1).map(async ({ id }) => (await application.waitForRun(id)).status),
    ), ["completed", "completed", "completed"]);
  } finally {
    await application.shutdown();
    store.close();
  }
});

test("executes Dispatches, fails busy targets, and reconciles pending work on restart", async () => {
  const store = new ScopeGuardStore(":memory:");
  const pending = new Map<string, ReturnType<typeof deferredRun>>();
  const runtime = {
    validateLocator() {}, projectMessages() { return []; }, async probe() {}, async shutdown() {},
    run(options: { conversationId: string; onSessionReady?: (locator: ReturnType<typeof locatorFor>) => void }) {
      const deferred = deferredRun();
      pending.set(options.conversationId, deferred);
      options.onSessionReady?.(locatorFor(options.conversationId));
      return deferred.promise.then(() => ({
        locator: locatorFor(options.conversationId),
        effect: "none" as const,
        messages: [],
      }));
    },
  } as unknown as PiRuntimeSupervisor;
  const application = new ScopeGuardApplication({
    store,
    runtime,
    secrets: memorySecrets(),
  });
  try {
    const { workspace, agent } = await createApplicationFixture(application);
    const source = application.createConversation({ workspaceId: workspace.id, agentId: agent.id, title: "Source" });
    const target = application.createConversation({ workspaceId: workspace.id, agentId: agent.id, title: "Target" });
    const sourceRun = await application.startRun({
      conversationId: source.id,
      prompt: "SECRET TRANSCRIPT CONTENT",
    });
    pending.get(source.id)!.resolve();
    await application.waitForRun(sourceRun.id);
    const handoff = application.generateHandoffPrompt({
      workspaceId: workspace.id,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      workRequest: "Review the source result.",
    });
    assert.match(handoff.text, /Source/);
    assert.match(handoff.text, /Target/);
    assert.match(handoff.text, /Review the source result/);
    assert.doesNotMatch(handoff.text, /SECRET TRANSCRIPT CONTENT/);
    assert.throws(() => application.generateHandoffPrompt({
      workspaceId: workspace.id,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      workRequest: "汉".repeat(5_462),
    }), /16 KiB/);
    const dispatch = application.createDispatch({
      workspaceId: workspace.id,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      prompt: "Review the source result.",
    });
    const running = await application.executeDispatch(dispatch.id);
    assert.equal(running.status, "running");
    assert.ok(running.targetRunId);
    pending.get(target.id)!.resolve();
    await application.waitForRun(running.targetRunId!);
    assert.equal(application.listDispatches(workspace.id)[0]?.status, "completed");

    const busyRun = await application.startRun({ conversationId: target.id, prompt: "Stay busy" });
    const blocked = application.createDispatch({
      workspaceId: workspace.id,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      prompt: "This must not queue.",
    });
    const failed = await application.executeDispatch(blocked.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /active Run/);
    pending.get(target.id)!.resolve();
    await application.waitForRun(busyRun.id);

    const abandoned = application.createDispatch({
      workspaceId: workspace.id,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      prompt: "Interrupted by restart.",
    });
    assert.deepEqual(application.initialize(), {
      interruptedRuns: 0,
      interruptedDispatches: 1,
    });
    const reconciled = application.listDispatches(workspace.id)
      .find(({ id }) => id === abandoned.id);
    assert.equal(reconciled?.status, "interrupted");
    assert.match(reconciled?.error ?? "", /restarted/);
  } finally {
    await application.shutdown();
    store.close();
  }
});

function deferredRun() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function locatorFor(conversationId: string) {
  return {
    sessionFile: `/sessions/${conversationId}/session.jsonl`,
    sessionId: `pi-${conversationId}`,
    piVersion: "0.84.2" as const,
    sessionVersion: 3 as const,
  };
}

function memorySecrets() {
  return {
    async put(reference: string) { return reference; },
    async get() { return null; },
    async delete() {},
  };
}

async function createApplicationFixture(application: ScopeGuardApplication) {
  const workspace = application.createWorkspace({ name: "Workspace" });
  const provider = await application.saveProviderProfile({
    name: "Provider",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1/v1",
    defaultModel: "model",
  });
  const agent = application.createAgent({
    workspaceId: workspace.id,
    name: "Agent",
    instructions: "Help",
    providerProfileId: provider.id,
  });
  return { workspace, provider, agent };
}
