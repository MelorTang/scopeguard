import assert from "node:assert/strict";
import test from "node:test";

import {
  isRunEvent,
  parseCreateArtifactInput,
  parseCreateAgentProfileInput,
  parseCreateTaskInput,
  parseManagedExecutionRequest,
  parsePublishWorkspaceContextRequest,
  parseResolveApprovalRequest,
  parseSaveRuntimeNodeInput,
  parseSaveProviderProfileRequest,
  parseUpdateAgentInstanceRuntimeRequest,
  parseUpdateTaskStatusRequest,
  parseUpdateThreadSettingsInput,
  toProviderProfileView,
} from "./index.js";

test("removes secret references from Provider profiles returned to Renderer", () => {
  const view = toProviderProfileView({
    id: "provider",
    name: "Relay",
    protocol: "openai-compatible",
    baseUrl: "https://relay.example.com/v1",
    defaultModel: "model",
    apiKeyRef: "provider:opaque-secret-reference",
    customHeaders: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal(view.hasApiKey, true);
  assert.equal("apiKeyRef" in view, false);
});

test("validates provider settings at the IPC boundary", () => {
  assert.deepEqual(
    parseSaveProviderProfileRequest({
      name: "Relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      defaultModel: "model",
      apiKey: "secret",
      customHeaders: { "X-Tenant": "scopeguard" },
    }),
    {
      id: undefined,
      name: "Relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      defaultModel: "model",
      apiKey: "secret",
      clearApiKey: undefined,
      customHeaders: { "X-Tenant": "scopeguard" },
    },
  );
  assert.throws(
    () => parseSaveProviderProfileRequest({
      name: "Relay",
      protocol: "unknown",
      baseUrl: "https://relay.example.com",
      defaultModel: "model",
    }),
    /protocol/,
  );
});

test("rejects malformed permissions and approval decisions", () => {
  assert.equal(
    parseCreateAgentProfileInput({
      projectId: "project",
      name: "Agent",
      instructions: "",
      executionProfile: "auto-approve",
    }).executionProfile,
    "auto-approve",
  );
  assert.throws(
    () => parseCreateAgentProfileInput({
      projectId: "project",
      name: "Agent",
      instructions: "",
      providerProfileId: "provider",
      toolPolicy: { runCommands: "always" },
    }),
    /runCommands/,
  );
  assert.throws(
    () => parseCreateAgentProfileInput({
      projectId: "project",
      name: "Agent",
      instructions: "",
      executionProfile: "unrestricted",
    }),
    /executionProfile/,
  );
  assert.throws(
    () => parseResolveApprovalRequest({
      approvalId: "approval",
      decision: "approved-project",
    }),
    /approved-once or denied/,
  );
});

test("validates conversation settings at the IPC boundary", () => {
  assert.deepEqual(
    parseUpdateThreadSettingsInput({
      threadId: "thread",
      modelOverride: "specialist-model",
      executionProfile: "full-access",
    }),
    {
      threadId: "thread",
      modelOverride: "specialist-model",
      executionProfile: "full-access",
    },
  );
  assert.throws(
    () => parseUpdateThreadSettingsInput({
      threadId: "thread",
      executionProfile: "unrestricted",
    }),
    /executionProfile/,
  );
});

test("validates first-stage control-plane commands at the IPC boundary", () => {
  assert.deepEqual(parseSaveRuntimeNodeInput({
    name: "Remote",
    kind: "remote",
    baseUrl: "https://runtime.example.com",
    credential: "secret",
  }), {
    id: undefined,
    name: "Remote",
    kind: "remote",
    baseUrl: "https://runtime.example.com",
    credential: "secret",
    clearCredential: undefined,
  });
  assert.deepEqual(parseCreateTaskInput({
    workspaceId: "workspace",
    title: "Research",
    priority: "high",
  }), {
    workspaceId: "workspace",
    title: "Research",
    description: undefined,
    priority: "high",
  });
  assert.deepEqual(parseUpdateAgentInstanceRuntimeRequest({
    agentInstanceId: "agent-instance",
    runtimeNodeId: "remote-runtime",
  }), {
    agentInstanceId: "agent-instance",
    runtimeNodeId: "remote-runtime",
  });
  assert.equal(
    parseCreateArtifactInput({
      workspaceId: "workspace",
      taskId: "task",
      agentInstanceId: "agent",
      kind: "markdown",
      title: "Report",
      mimeType: "text/markdown",
      content: "# Report",
    }).kind,
    "markdown",
  );
  assert.equal(
    parsePublishWorkspaceContextRequest({
      workspaceId: "workspace",
      title: "Decision",
      content: "Approved.",
      publishedBy: "user",
    }).publishedBy,
    "user",
  );
  assert.throws(
    () => parseUpdateTaskStatusRequest({ taskId: "task", status: "done" }),
    /valid Task status/,
  );
  assert.throws(
    () => parseSaveRuntimeNodeInput({ name: "Remote", kind: "cloud" }),
    /local or remote/,
  );
  assert.throws(
    () => parseUpdateAgentInstanceRuntimeRequest({
      agentInstanceId: "agent-instance",
      runtimeNodeId: "",
    }),
    /runtimeNodeId/,
  );
});

test("accepts only known run event envelopes", () => {
  assert.equal(isRunEvent({
    type: "assistant-delta",
    runId: "run",
    threadId: "thread",
    delta: "hello",
    at: new Date().toISOString(),
  }), true);
  assert.equal(isRunEvent({
    type: "unknown",
    runId: "run",
    threadId: "thread",
    at: new Date().toISOString(),
  }), false);
});

test("validates managed execution requests at the private IPC boundary", () => {
  const request = parseManagedExecutionRequest({
    executionId: "execution",
    projectId: "project",
    threadId: "thread",
    runId: "run",
    workspaceRoot: "C:\\work",
    command: "echo ready",
    timeoutMs: 30_000,
    environment: { PATH: "C:\\Windows\\System32" },
  });
  assert.equal(request.command, "echo ready");
  assert.throws(
    () => parseManagedExecutionRequest({ ...request, timeoutMs: 999 }),
    /timeoutMs/,
  );
  assert.throws(
    () => parseManagedExecutionRequest({ ...request, command: " " }),
    /command/,
  );
});
