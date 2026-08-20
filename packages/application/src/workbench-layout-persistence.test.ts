import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceLayout } from "@scopeguard/domain";

import { WorkbenchLayoutPersistence } from "./workbench-layout-persistence.js";

test("persists pending layouts independently when Workspace changes inside debounce window", async () => {
  const saved: WorkspaceLayout[] = [];
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(layout) {
      saved.push(structuredClone(layout));
      return layout;
    },
  });
  const a = layout("workspace-a", "conversation-a", 440);
  const b = layout("workspace-b", "conversation-b", 520);

  persistence.schedule(a);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await persistence.flush("workspace-a");
  persistence.schedule(b);
  await persistence.flushAll();

  assert.deepEqual(saved, [a, b]);
  assert.equal(persistence.pendingWorkspaceCount, 0);
});

test("newer revisions only supersede pending state in the same Workspace", async () => {
  const saved: WorkspaceLayout[] = [];
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 10,
    async save(value) {
      saved.push(structuredClone(value));
      return value;
    },
  });

  persistence.schedule(layout("workspace-a", "conversation-a", 400));
  persistence.schedule(layout("workspace-b", "conversation-b", 500));
  persistence.schedule(layout("workspace-a", "conversation-a", 600));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await persistence.flushAll();

  assert.deepEqual(saved.map(({ workspaceId, paneWidths }) => [workspaceId, paneWidths[0]]), [
    ["workspace-b", 500],
    ["workspace-a", 600],
  ]);
});

test("a failed save stays visible but does not poison the next Workspace flush", async () => {
  let attempts = 0;
  const saved: WorkspaceLayout[] = [];
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(value) {
      attempts += 1;
      if (attempts === 1) throw new Error("disk unavailable");
      saved.push(structuredClone(value));
      return value;
    },
  });
  const first = layout("workspace-a", "conversation-a", 440);
  persistence.schedule(first);
  await assert.rejects(() => persistence.flush("workspace-a"), /disk unavailable/);

  const second = layout("workspace-a", "conversation-a", 520);
  persistence.schedule(second);
  await persistence.flush("workspace-a");

  assert.deepEqual(saved, [second]);
  assert.equal(persistence.pendingWorkspaceCount, 0);
});

test("flushAll includes a newer revision staged while SQLite save is in flight", async () => {
  const saved: WorkspaceLayout[] = [];
  let releaseFirstSave: (() => void) | undefined;
  let firstSaveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(value) {
      saved.push(structuredClone(value));
      if (saved.length === 1) {
        firstSaveStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        });
      }
      return value;
    },
  });

  persistence.schedule(layout("workspace-a", "conversation-a", 440));
  const flushing = persistence.flushAll();
  await started;
  persistence.schedule(layout("workspace-a", "conversation-a", 560));
  releaseFirstSave?.();
  await flushing;

  assert.deepEqual(saved.map(({ paneWidths }) => paneWidths[0]), [440, 560]);
  assert.equal(persistence.pendingWorkspaceCount, 0);
});

test("quiescing rejects new revisions explicitly and can resume after a failed exit", () => {
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(value) {
      return value;
    },
  });

  persistence.suspendScheduling();
  assert.equal(persistence.isSchedulingSuspended, true);
  assert.throws(
    () => persistence.schedule(layout("workspace-a", "conversation-a", 440)),
    /quiescing/i,
  );
  persistence.resumeScheduling();
  persistence.schedule(layout("workspace-a", "conversation-a", 560));
  assert.equal(persistence.isSchedulingSuspended, false);
  assert.equal(persistence.pendingWorkspaceCount, 1);
});

function layout(workspaceId: string, conversationId: string, width: number): WorkspaceLayout {
  return {
    workspaceId,
    openConversationIds: [conversationId],
    paneConversationIds: [conversationId],
    paneWidths: [width],
    activeConversationId: conversationId,
    requestedPaneCount: 1,
  };
}
