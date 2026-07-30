import assert from "node:assert/strict";
import test from "node:test";

import {
  isRunEvent,
  parseCreateAgentProfileInput,
  parseResolveApprovalRequest,
  parseSaveProviderProfileRequest,
} from "./index.js";

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
    () => parseResolveApprovalRequest({
      approvalId: "approval",
      decision: "approved-project",
    }),
    /approved-once or denied/,
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
