import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateAgentInput,
  parseCreateDispatchRequest,
  parseHandoffPromptRequest,
  parseResolveApprovalRequest,
  parseSaveProviderProfileRequest,
  parseUpdateConversationSettingsInput,
  parseWorkspaceLayoutRequest,
  toDesktopWorkspaceSnapshot,
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

test("projects the canonical V1 snapshot without compatibility collections", () => {
  const snapshot = toDesktopWorkspaceSnapshot({
    workspaces: [],
    providerProfiles: [],
    agents: [],
    conversations: [],
    activeRuns: [],
    recentRuns: [],
    pendingApprovals: [],
    layouts: [],
    dispatches: [],
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "activeRuns",
    "agents",
    "conversations",
    "dispatches",
    "layouts",
    "pendingApprovals",
    "providerProfiles",
    "recentRuns",
    "workspaces",
  ]);
});

test("validates provider and Agent inputs at the IPC boundary", () => {
  assert.equal(parseSaveProviderProfileRequest({
    name: "Relay",
    protocol: "openai-compatible",
    baseUrl: "https://relay.example.com/v1",
    defaultModel: "model",
  }).protocol, "openai-compatible");
  assert.equal(parseCreateAgentInput({
    workspaceId: "workspace",
    name: "Agent",
    instructions: "Help.",
    providerProfileId: "provider",
    executionProfile: "auto-approve",
  }).executionProfile, "auto-approve");
  assert.throws(() => parseCreateAgentInput({
    workspaceId: "workspace",
    name: "Agent",
    instructions: "Help.",
    providerProfileId: "provider",
    toolPolicy: { runCommands: "always" },
  }), /runCommands/);
});

test("validates Conversation settings and approval decisions", () => {
  assert.deepEqual(parseUpdateConversationSettingsInput({
    conversationId: "conversation",
    modelOverride: "specialist-model",
    executionProfile: "full-access",
  }), {
    conversationId: "conversation",
    modelOverride: "specialist-model",
    executionProfile: "full-access",
  });
  assert.throws(() => parseResolveApprovalRequest({
    approvalId: "approval",
    decision: "approved-workspace",
  }), /approved-once or denied/);
});

test("rejects extra fields and transcript injection in Phase 3 requests", () => {
  const layout = {
    workspaceId: "workspace",
    openConversationIds: ["source", "target"],
    paneConversationIds: ["source", "target"],
    activeConversationId: "source",
    requestedPaneCount: 2,
  };
  assert.deepEqual(parseWorkspaceLayoutRequest(layout), layout);
  assert.throws(
    () => parseWorkspaceLayoutRequest({ ...layout, messages: [] }),
    /exactly|field/i,
  );

  const dispatch = {
    workspaceId: "workspace",
    sourceConversationId: "source",
    targetConversationId: "target",
    prompt: "Review the output.",
    sourceRunId: null,
  };
  assert.deepEqual(parseCreateDispatchRequest(dispatch), dispatch);
  for (const forbidden of ["transcript", "messages", "history"]) {
    assert.throws(
      () => parseCreateDispatchRequest({ ...dispatch, [forbidden]: [] }),
      /exactly|field/i,
    );
  }

  const handoff = {
    workspaceId: "workspace",
    sourceConversationId: "source",
    targetConversationId: "target",
    workRequest: "Check the result.",
  };
  assert.deepEqual(parseHandoffPromptRequest(handoff), handoff);
  assert.throws(
    () => parseHandoffPromptRequest({ ...handoff, transcript: ["secret"] }),
    /exactly|field/i,
  );
  assert.throws(
    () => parseHandoffPromptRequest({ ...handoff, workRequest: "汉".repeat(5_462) }),
    /16 KiB/i,
  );
});
