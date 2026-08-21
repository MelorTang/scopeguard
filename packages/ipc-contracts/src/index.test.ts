import assert from "node:assert/strict";
import test from "node:test";

import {
  IPC_CHANNELS,
  parseCaptureWorkspaceFileRequest,
  parseClipboardText,
  parseCreateAgentInput,
  parseCreateDispatchRequest,
  parseHandoffPromptRequest,
  parseExportArtifactVersionRequest,
  parseOpenArtifactVersionRequest,
  parseRendererLayoutLifecycleRequest,
  parseRendererLayoutLifecycleResponse,
  parseResolveApprovalRequest,
  parseSaveProviderProfileRequest,
  parseStageWorkspaceLayoutResult,
  parseWorkspaceCenterStateRequest,
  parseUpdateConversationSettingsInput,
  parseWorkspaceLayoutRequest,
  toDesktopWorkspaceSnapshot,
  toProviderProfileView,
} from "./index.js";

test("exposes Main-owned layout staging and flush channels", () => {
  assert.equal(IPC_CHANNELS.stageWorkspaceLayout, "scopeguard:layout:stage");
  assert.equal(IPC_CHANNELS.flushWorkspaceLayouts, "scopeguard:layout:flush");
  assert.equal(
    IPC_CHANNELS.rendererLayoutLifecycleRequest,
    "scopeguard:layout:lifecycle-request",
  );
  assert.equal(
    IPC_CHANNELS.rendererLayoutLifecycleResponse,
    "scopeguard:layout:lifecycle-response",
  );
});

test("accepts only exact Renderer layout lifecycle requests and responses", () => {
  assert.deepEqual(parseRendererLayoutLifecycleRequest({
    requestId: "request-1",
    action: "drain",
  }), { requestId: "request-1", action: "drain" });
  assert.deepEqual(parseRendererLayoutLifecycleResponse({
    requestId: "request-1",
    action: "drain",
    ok: true,
    drainReceipt: {
      generation: "request-1",
      acceptedRevisions: [{
        workspaceId: "workspace",
        revision: 3,
        layout: layout(560),
      }],
    },
  }), {
    requestId: "request-1",
    action: "drain",
    ok: true,
    drainReceipt: {
      generation: "request-1",
      acceptedRevisions: [{
        workspaceId: "workspace",
        revision: 3,
        layout: layout(560),
      }],
    },
  });
  assert.deepEqual(parseRendererLayoutLifecycleResponse({
    requestId: "request-1",
    action: "resume",
    ok: true,
  }), { requestId: "request-1", action: "resume", ok: true });
  assert.deepEqual(parseRendererLayoutLifecycleResponse({
    requestId: "request-1",
    action: "drain",
    ok: false,
    error: "Renderer drain failed.",
  }), {
    requestId: "request-1",
    action: "drain",
    ok: false,
    error: "Renderer drain failed.",
  });

  for (const invalid of [
    undefined,
    { requestId: "汉".repeat(43), action: "drain" },
    { requestId: "request-1", action: "quit" },
    { requestId: "request-1", action: "drain", extra: true },
  ]) {
    assert.throws(() => parseRendererLayoutLifecycleRequest(invalid), /lifecycle request/i);
  }
  for (const invalid of [
    undefined,
    { requestId: "request-1", action: "drain", ok: true },
    {
      requestId: "request-1",
      action: "drain",
      ok: true,
      drainReceipt: { generation: "forged", acceptedRevisions: [] },
    },
    {
      requestId: "request-1",
      action: "drain",
      ok: true,
      drainReceipt: {
        generation: "request-1",
        acceptedRevisions: [{
          workspaceId: "workspace",
          revision: 0,
          layout: layout(560),
        }],
      },
    },
    { requestId: "request-1", action: "drain", ok: false },
    { requestId: "request-1", action: "drain", ok: true, error: "mixed" },
    { requestId: "request-1", action: "drain", ok: false, error: "" },
    { requestId: "request-1", action: "drain", ok: true, extra: true },
  ]) {
    assert.throws(() => parseRendererLayoutLifecycleResponse(invalid), /lifecycle response/i);
  }
});

test("bounds Renderer drain receipt revisions, identifiers, arrays, and total UTF-8 payload", () => {
  const invalidReceipts: Array<[unknown, RegExp]> = [
    [drainResponse({
      acceptedRevisions: [{
        workspaceId: "workspace",
        revision: Number.MAX_SAFE_INTEGER + 1,
        layout: layout(560),
      }],
    }), /positive safe integer/i],
    [drainResponse({
      acceptedRevisions: [{
        workspaceId: "汉".repeat(43),
        revision: 1,
        layout: { ...layout(560), workspaceId: "汉".repeat(43) },
      }],
    }), /workspaceId exceeds 128 bytes/i],
    [drainResponse({
      acceptedRevisions: [{
        workspaceId: "workspace",
        revision: 1,
        layout: {
          ...layout(560),
          openConversationIds: ["汉".repeat(43)],
          paneConversationIds: ["汉".repeat(43)],
          activeConversationId: "汉".repeat(43),
        },
      }],
    }), /Conversation 0 exceeds 128 bytes/i],
    [drainResponse({
      acceptedRevisions: [{
        workspaceId: "workspace",
        revision: 1,
        layout: {
          ...layout(560),
          openConversationIds: [
            "conversation",
            ...Array.from({ length: 256 }, (_, index) => `c-${index}`),
          ],
        },
      }],
    }), /too many open Conversations/i],
    [drainResponse({
      acceptedRevisions: Array.from({ length: 65 }, (_, index) => ({
        workspaceId: `workspace-${index}`,
        revision: 1,
        layout: { ...layout(560), workspaceId: `workspace-${index}` },
      })),
    }), /too many accepted revisions/i],
    [drainResponse({
      acceptedRevisions: [0, 1].map((revisionIndex) => {
        const workspaceId = `workspace-${revisionIndex}-${"w".repeat(100)}`;
        const conversationIds = Array.from(
          { length: 256 },
          (_, index) => `conversation-${revisionIndex}-${index}-${"c".repeat(108)}`,
        );
        return {
          workspaceId,
          revision: 1,
          layout: {
            ...layout(560),
            workspaceId,
            openConversationIds: conversationIds,
            paneConversationIds: [conversationIds[0]],
            activeConversationId: conversationIds[0],
          },
        };
      }),
    }), /exceeds 64 KiB/i],
  ];

  for (const [invalid, expected] of invalidReceipts) {
    assert.throws(() => parseRendererLayoutLifecycleResponse(invalid), expected);
  }
});

function drainResponse(drainReceipt: {
  generation?: string;
  acceptedRevisions: unknown[];
}) {
  return {
    requestId: "request-1",
    action: "drain",
    ok: true,
    drainReceipt: {
      generation: "request-1",
      ...drainReceipt,
    },
  };
}

function layout(width: number) {
  return {
    workspaceId: "workspace",
    openConversationIds: ["conversation"],
    paneConversationIds: ["conversation"],
    paneWidths: [width],
    activeConversationId: "conversation",
    requestedPaneCount: 1,
  };
}

test("accepts only the exact Workspace layout stage result union", () => {
  assert.deepEqual(parseStageWorkspaceLayoutResult({ accepted: true }), {
    accepted: true,
  });
  assert.deepEqual(parseStageWorkspaceLayoutResult({
    accepted: false,
    reason: "quiescing",
  }), {
    accepted: false,
    reason: "quiescing",
  });
  for (const invalid of [
    undefined,
    null,
    true,
    { accepted: false },
    { accepted: false, reason: "busy" },
    { accepted: true, reason: "quiescing" },
    { accepted: true, extra: true },
    { accepted: "true" },
  ]) {
    assert.throws(
      () => parseStageWorkspaceLayoutResult(invalid),
      /Workspace layout stage result/i,
    );
  }
});

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
    artifacts: [],
    artifactVersions: [],
    centerStates: [],
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "activeRuns",
    "agents",
    "artifactVersions",
    "artifacts",
    "centerStates",
    "conversations",
    "dispatches",
    "layouts",
    "pendingApprovals",
    "providerProfiles",
    "recentRuns",
    "workspaces",
  ]);
});

test("accepts only bounded Artifact capture, export, and Review requests", () => {
  assert.deepEqual(parseCaptureWorkspaceFileRequest({
    workspaceId: "workspace",
    relativePath: "reports/final.docx",
    artifactId: "artifact",
    producedByConversationId: "conversation",
    producedByRunId: "run",
    inputRelativePaths: ["inputs/source.docx"],
    toolchain: "Agent Skill: documents",
    limitations: ["External preview."],
  }), {
    workspaceId: "workspace",
    relativePath: "reports/final.docx",
    artifactId: "artifact",
    title: undefined,
    format: undefined,
    producedByConversationId: "conversation",
    producedByRunId: "run",
    inputRelativePaths: ["inputs/source.docx"],
    toolchain: "Agent Skill: documents",
    limitations: ["External preview."],
  });
  assert.deepEqual(parseExportArtifactVersionRequest({
    workspaceId: "workspace",
    versionId: "version",
    relativePath: "exports/final.docx",
    expectedContentHash: null,
  }), {
    workspaceId: "workspace",
    versionId: "version",
    relativePath: "exports/final.docx",
    expectedContentHash: null,
  });
  assert.deepEqual(parseOpenArtifactVersionRequest({ versionId: "version" }), {
    versionId: "version",
  });
  assert.throws(
    () => parseOpenArtifactVersionRequest({ versionId: "version", path: "/private/blob" }),
    /Open Artifact Version input/i,
  );
  assert.equal(parseWorkspaceCenterStateRequest({
    workspaceId: "workspace",
    mode: "artifact-review",
    artifactId: "artifact",
    versionId: "version",
    comparisonVersionId: null,
    associatedConversationId: null,
    conversationPanelOpen: false,
  }).mode, "artifact-review");

  for (const invalid of [
    {
      workspaceId: "workspace",
      relativePath: "../secret.docx",
      toolchain: "Agent Skill",
    },
    {
      workspaceId: "workspace",
      relativePath: "file.docx",
      toolchain: "Agent Skill",
      limitations: ["same", "same"],
    },
    {
      workspaceId: "workspace",
      relativePath: "file.docx",
      inputRelativePaths: ["inputs/source.docx", "inputs/source.docx"],
      toolchain: "Agent Skill",
    },
    {
      workspaceId: "workspace",
      relativePath: "file.docx",
      inputRelativePaths: ["../outside.docx"],
      toolchain: "Agent Skill",
    },
    {
      workspaceId: "workspace",
      relativePath: "file.docx",
      toolchain: "Agent Skill",
      absolutePath: "/private/file.docx",
    },
  ]) {
    assert.throws(() => parseCaptureWorkspaceFileRequest(invalid), /path|duplicate|supported fields/i);
  }
  assert.throws(() => parseExportArtifactVersionRequest({
    workspaceId: "workspace",
    versionId: "version",
    relativePath: "file.docx",
  }), /expectedContentHash/i);
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
    paneWidths: [420, 420],
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

test("accepts only bounded exact strings for controlled clipboard writes", () => {
  assert.equal(parseClipboardText("# Handoff Prompt\n\nReview this."), "# Handoff Prompt\n\nReview this.");
  assert.throws(() => parseClipboardText({ text: "not an exact string" }), /string/i);
  assert.throws(() => parseClipboardText(""), /empty/i);
  assert.throws(() => parseClipboardText("汉".repeat(10_923)), /32 KiB/i);
});
