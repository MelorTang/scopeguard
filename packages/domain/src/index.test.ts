import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DISPATCH_PROMPT_BYTES,
  DEFAULT_WORKBENCH_PANE_WIDTH,
  MAX_WORKBENCH_PANE_WIDTH,
  MIN_WORKBENCH_PANE_WIDTH,
  SCOPEGUARD_SCHEMA_ID,
  SCOPEGUARD_SCHEMA_VERSION,
  activateConversationInLayout,
  canTransitionDispatch,
  canTransitionRun,
  mergeToolPolicy,
  normalizeProviderBaseUrl,
  parseArtifact,
  parseArtifactVersion,
  parseDispatchPrompt,
  parseWorkspaceCenterState,
  parseWorkspaceFileVersion,
  resizeWorkspacePanePair,
  parseWorkspaceLayout,
  validateProviderProfileInput,
} from "./index.js";

test("identifies the fresh personal Pi schema family", () => {
  assert.equal(SCOPEGUARD_SCHEMA_ID, "scopeguard-personal-pi-v1");
  assert.equal(SCOPEGUARD_SCHEMA_VERSION, 2);
});

test("keeps Artifact Versions immutable and Workspace File identity explicit", () => {
  const hash = "a".repeat(64);
  const source = parseWorkspaceFileVersion({
    workspaceId: "workspace-1",
    relativePath: "reports/quarter.docx",
    contentHash: hash,
    byteSize: 42,
  });
  assert.equal(source.relativePath, "reports/quarter.docx");
  assert.throws(
    () => parseWorkspaceFileVersion({ ...source, relativePath: "../quarter.docx" }),
    /traversal/i,
  );

  const artifact = parseArtifact({
    id: "artifact-1",
    workspaceId: "workspace-1",
    title: "Quarterly report",
    format: "docx",
    sourceRelativePath: source.relativePath,
    currentVersionId: "version-2",
    associatedConversationId: "conversation-1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:01:00.000Z",
  });
  assert.equal(artifact.currentVersionId, "version-2");

  const version = parseArtifactVersion({
    id: "version-2",
    artifactId: artifact.id,
    version: 2,
    parentVersionId: "version-1",
    source,
    contentHash: "b".repeat(64),
    byteSize: 43,
    producedByConversationId: "conversation-1",
    producedByRunId: "run-1",
    toolchain: "selected Agent workflow",
    limitations: ["Preview fidelity is not guaranteed."],
    createdAt: "2026-08-21T00:01:00.000Z",
  });
  assert.equal(version.parentVersionId, "version-1");
  assert.throws(
    () => parseArtifactVersion({ ...version, limitations: ["same", "same"] }),
    /duplicates/i,
  );
});

test("persists Workbench and Artifact Review as exact separate center states", () => {
  assert.deepEqual(
    parseWorkspaceCenterState({ workspaceId: "workspace-1", mode: "workbench" }),
    { workspaceId: "workspace-1", mode: "workbench" },
  );
  assert.equal(
    parseWorkspaceCenterState({
      workspaceId: "workspace-1",
      mode: "artifact-review",
      artifactId: "artifact-1",
      versionId: "version-2",
      comparisonVersionId: "version-1",
      associatedConversationId: "conversation-1",
      conversationPanelOpen: true,
    }).mode,
    "artifact-review",
  );
  assert.throws(
    () => parseWorkspaceCenterState({
      workspaceId: "workspace-1",
      mode: "workbench",
      artifactId: "artifact-1",
    }),
    /exactly/i,
  );
});

test("normalizes provider URLs without changing their path", () => {
  assert.equal(
    normalizeProviderBaseUrl(" https://relay.example.com/v1/// "),
    "https://relay.example.com/v1",
  );
  assert.throws(
    () => normalizeProviderBaseUrl("file:///tmp/provider"),
    /http or https/,
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://user:secret@relay.example.com/v1"),
    /must not contain credentials/,
  );
});

test("validates provider fields and removes empty headers", () => {
  assert.deepEqual(
    validateProviderProfileInput({
      name: " Company relay ",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1/",
      defaultModel: " gpt-compatible ",
      apiKey: " secret ",
      customHeaders: {
        " X-Workspace ": " scopeguard ",
        Empty: " ",
      },
    }),
    {
      name: "Company relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      defaultModel: "gpt-compatible",
      apiKey: "secret",
      customHeaders: {
        "X-Workspace": "scopeguard",
      },
    },
  );
});

test("keeps run transitions explicit", () => {
  assert.equal(canTransitionRun("queued", "preparing"), true);
  assert.equal(canTransitionRun("preparing", "running"), true);
  assert.equal(canTransitionRun("running", "waiting-approval"), true);
  assert.equal(canTransitionRun("running", "waiting-input"), true);
  assert.equal(canTransitionRun("waiting-input", "running"), true);
  assert.equal(canTransitionRun("cancelling", "completed"), true);
  assert.equal(canTransitionRun("completed", "running"), false);
  assert.equal(canTransitionRun("cancelled", "completed"), false);
});

test("merges tool policy without making writes implicit", () => {
  assert.deepEqual(mergeToolPolicy({ runCommands: "deny" }), {
    readFiles: "allow",
    writeFiles: "ask",
    runCommands: "deny",
  });
});

test("validates a bounded Workspace layout without guessing missing state", () => {
  assert.deepEqual(
    parseWorkspaceLayout(
      {
        workspaceId: "workspace-1",
        openConversationIds: ["conversation-1", "conversation-2"],
        paneConversationIds: ["conversation-2", "conversation-1"],
        paneWidths: [480, 360],
        activeConversationId: "conversation-2",
        requestedPaneCount: 2,
      },
      new Set(["conversation-1", "conversation-2"]),
    ),
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1", "conversation-2"],
      paneConversationIds: ["conversation-2", "conversation-1"],
      paneWidths: [480, 360],
      activeConversationId: "conversation-2",
      requestedPaneCount: 2,
    },
  );

  for (const invalid of [
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1", "conversation-1"],
      paneConversationIds: ["conversation-1"],
      paneWidths: [DEFAULT_WORKBENCH_PANE_WIDTH],
      activeConversationId: "conversation-1",
      requestedPaneCount: 1,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-unknown"],
      paneWidths: [DEFAULT_WORKBENCH_PANE_WIDTH],
      activeConversationId: "conversation-unknown",
      requestedPaneCount: 1,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-1"],
      paneWidths: [DEFAULT_WORKBENCH_PANE_WIDTH],
      activeConversationId: "conversation-1",
      requestedPaneCount: 5,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-1"],
      paneWidths: [DEFAULT_WORKBENCH_PANE_WIDTH],
      activeConversationId: "conversation-1",
      requestedPaneCount: 1,
      transcript: [],
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1", "conversation-2"],
      paneConversationIds: ["conversation-1", "conversation-2"],
      paneWidths: [DEFAULT_WORKBENCH_PANE_WIDTH],
      activeConversationId: "conversation-1",
      requestedPaneCount: 2,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-1"],
      paneWidths: [MIN_WORKBENCH_PANE_WIDTH - 1],
      activeConversationId: "conversation-1",
      requestedPaneCount: 1,
    },
  ]) {
    assert.throws(
      () => parseWorkspaceLayout(invalid, new Set(["conversation-1"])),
      /Layout|Conversation|pane|field/i,
    );
  }
  const validBase = {
    workspaceId: "workspace-1",
    openConversationIds: ["conversation-1", "conversation-2"],
    paneConversationIds: ["conversation-1", "conversation-2"],
    activeConversationId: "conversation-1",
    requestedPaneCount: 2,
  };
  assert.throws(
    () => parseWorkspaceLayout(
      { ...validBase, paneWidths: [DEFAULT_WORKBENCH_PANE_WIDTH] },
      new Set(validBase.openConversationIds),
    ),
    /one width per pane/i,
  );
  assert.throws(
    () => parseWorkspaceLayout(
      { ...validBase, paneWidths: [MIN_WORKBENCH_PANE_WIDTH - 1, 400] },
      new Set(validBase.openConversationIds),
    ),
    /pane widths/i,
  );
});

test("bounds Dispatch prompts by UTF-8 bytes and keeps status monotonic", () => {
  assert.equal(parseDispatchPrompt("  review this change  "), "review this change");
  assert.equal(
    new TextEncoder().encode(parseDispatchPrompt("汉".repeat(5_461))).byteLength,
    MAX_DISPATCH_PROMPT_BYTES - 1,
  );
  assert.throws(() => parseDispatchPrompt("   "), /empty/i);
  assert.throws(() => parseDispatchPrompt("汉".repeat(5_462)), /16 KiB/i);
  assert.equal(canTransitionDispatch("pending", "running"), true);
  assert.equal(canTransitionDispatch("running", "completed"), true);
  assert.equal(canTransitionDispatch("failed", "running"), false);
  assert.equal(canTransitionDispatch("completed", "failed"), false);
});

test("resizes adjacent panes independently within readable bounds", () => {
  const layout = resizeWorkspacePanePair({
    workspaceId: "workspace",
    openConversationIds: ["one", "two", "three", "four"],
    paneConversationIds: ["one", "two", "three", "four"],
    paneWidths: [400, 400, 400, 400],
    activeConversationId: "four",
    requestedPaneCount: 4,
  }, 1, 120);
  assert.deepEqual(layout.paneWidths, [400, 480, 320, 400]);

  const bounded = resizeWorkspacePanePair(layout, 0, MAX_WORKBENCH_PANE_WIDTH);
  assert.equal(bounded.paneWidths[0], 560);
  assert.equal(bounded.paneWidths[1], MIN_WORKBENCH_PANE_WIDTH);
});

test("opening a fifth Conversation replaces the active pane without exceeding four panes", () => {
  const layout = activateConversationInLayout({
    workspaceId: "workspace",
    openConversationIds: ["one", "two", "three", "four"],
    paneConversationIds: ["one", "two", "three", "four"],
    paneWidths: [360, 420, 480, 540],
    activeConversationId: "two",
    requestedPaneCount: 4,
  }, "five");

  assert.deepEqual(layout.openConversationIds, ["one", "two", "three", "four", "five"]);
  assert.deepEqual(layout.paneConversationIds, ["one", "five", "three", "four"]);
  assert.deepEqual(layout.paneWidths, [360, 420, 480, 540]);
  assert.equal(layout.activeConversationId, "five");
  assert.equal(layout.paneConversationIds.length, layout.requestedPaneCount);
});
