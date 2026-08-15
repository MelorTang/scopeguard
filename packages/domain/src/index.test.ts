import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionRun,
  canTransitionTask,
  canTransitionToolCall,
  countWorkspacePendingAttention,
  mergeToolPolicy,
  normalizeProviderBaseUrl,
  validateProviderProfileInput,
} from "./index.js";

test("counts pending attention only for the selected Workspace", () => {
  assert.equal(countWorkspacePendingAttention({
    workspaceId: "workspace-a",
    threads: [
      { id: "thread-a", projectId: "workspace-a" },
      { id: "thread-b", projectId: "workspace-b" },
    ],
    runs: [
      { id: "run-a", threadId: "thread-a" },
      { id: "run-b", threadId: "thread-b" },
    ],
    approvals: [
      { approval: { runId: "run-a" } },
      { approval: { runId: "run-b" } },
    ],
    inboxItems: [
      { workspaceId: "workspace-a", status: "unread", kind: "task-failed" },
      { workspaceId: "workspace-a", status: "resolved", kind: "task-completed" },
      { workspaceId: "workspace-a", status: "unread", kind: "approval" },
      { workspaceId: "workspace-b", status: "unread", kind: "task-failed" },
    ],
  }), 2);
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

test("keeps durable task transitions explicit", () => {
  assert.equal(canTransitionTask("draft", "ready"), true);
  assert.equal(canTransitionTask("ready", "running"), true);
  assert.equal(canTransitionTask("running", "waiting-input"), true);
  assert.equal(canTransitionTask("waiting-input", "running"), true);
  assert.equal(canTransitionTask("completed", "running"), false);
  assert.equal(canTransitionTask("archived", "ready"), false);
});

test("keeps tool call facts monotonic after a terminal outcome", () => {
  assert.equal(canTransitionToolCall("proposed", "awaiting-approval"), true);
  assert.equal(canTransitionToolCall("awaiting-approval", "running"), true);
  assert.equal(canTransitionToolCall("running", "effect_unknown"), true);
  assert.equal(canTransitionToolCall("effect_unknown", "cancelled"), false);
  assert.equal(canTransitionToolCall("succeeded", "failed"), false);
  assert.equal(canTransitionToolCall("cancelled", "running"), false);
});

test("merges tool policy without making writes implicit", () => {
  assert.deepEqual(mergeToolPolicy({ runCommands: "deny" }), {
    readFiles: "allow",
    writeFiles: "ask",
    runCommands: "deny",
  });
});
