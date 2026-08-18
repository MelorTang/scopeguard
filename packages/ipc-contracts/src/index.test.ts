import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateAgentInput,
  parseResolveApprovalRequest,
  parseSaveProviderProfileRequest,
  parseUpdateConversationSettingsInput,
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
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "activeRuns",
    "agents",
    "conversations",
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
