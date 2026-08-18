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
