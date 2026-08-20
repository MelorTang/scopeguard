import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DISPATCH_PROMPT_BYTES,
  SCOPEGUARD_SCHEMA_ID,
  SCOPEGUARD_SCHEMA_VERSION,
  canTransitionDispatch,
  canTransitionRun,
  mergeToolPolicy,
  normalizeProviderBaseUrl,
  parseDispatchPrompt,
  projectWorkspaceLayout,
  parseWorkspaceLayout,
  validateProviderProfileInput,
} from "./index.js";

test("identifies the fresh personal Pi schema family", () => {
  assert.equal(SCOPEGUARD_SCHEMA_ID, "scopeguard-personal-pi-v1");
  assert.equal(SCOPEGUARD_SCHEMA_VERSION, 1);
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
        activeConversationId: "conversation-2",
        requestedPaneCount: 2,
      },
      new Set(["conversation-1", "conversation-2"]),
    ),
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1", "conversation-2"],
      paneConversationIds: ["conversation-2", "conversation-1"],
      activeConversationId: "conversation-2",
      requestedPaneCount: 2,
    },
  );

  for (const invalid of [
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1", "conversation-1"],
      paneConversationIds: ["conversation-1"],
      activeConversationId: "conversation-1",
      requestedPaneCount: 1,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-unknown"],
      activeConversationId: "conversation-unknown",
      requestedPaneCount: 1,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-1"],
      activeConversationId: "conversation-1",
      requestedPaneCount: 5,
    },
    {
      workspaceId: "workspace-1",
      openConversationIds: ["conversation-1"],
      paneConversationIds: ["conversation-1"],
      activeConversationId: "conversation-1",
      requestedPaneCount: 1,
      transcript: [],
    },
  ]) {
    assert.throws(
      () => parseWorkspaceLayout(invalid, new Set(["conversation-1"])),
      /Layout|Conversation|pane|field/i,
    );
  }
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

test("responsive layout projection keeps the active Conversation visible", () => {
  assert.deepEqual(projectWorkspaceLayout({
    workspaceId: "workspace",
    openConversationIds: ["one", "two", "three", "four"],
    paneConversationIds: ["one", "two", "three", "four"],
    activeConversationId: "four",
    requestedPaneCount: 4,
  }, 2).paneConversationIds, ["one", "four"]);
});
