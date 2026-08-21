import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceLayout } from "@scopeguard/domain";

import { WorkbenchLayoutStageCoordinator } from "./workbench-layout-stage-coordinator.js";

test("quiesced Workspaces retry independently without overwriting each other", async () => {
  const attempts: string[] = [];
  const accepted: string[] = [];
  let quiescing = true;
  const coordinator = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1,
    async stage(layout) {
      attempts.push(`${layout.workspaceId}:${layout.paneWidths[0]}`);
      if (quiescing) return { accepted: false, reason: "quiescing" };
      accepted.push(`${layout.workspaceId}:${layout.paneWidths[0]}`);
      return { accepted: true };
    },
  });

  const workspaceA = coordinator.submit(layout("workspace-a", 560));
  await waitFor(() => attempts.includes("workspace-a:560"));
  const workspaceB = coordinator.submit(layout("workspace-b", 620));
  await waitFor(() => attempts.includes("workspace-b:620"));
  quiescing = false;
  await Promise.all([workspaceA, workspaceB]);

  assert.deepEqual(new Set(accepted), new Set([
    "workspace-a:560",
    "workspace-b:620",
  ]));
  coordinator.dispose();
});

test("a newer revision supersedes only the older revision in the same Workspace", async () => {
  const attempts: number[] = [];
  const accepted: number[] = [];
  let quiescing = true;
  const coordinator = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1,
    async stage(value) {
      const width = value.paneWidths[0]!;
      attempts.push(width);
      if (quiescing) return { accepted: false, reason: "quiescing" };
      accepted.push(width);
      return { accepted: true };
    },
  });

  const first = coordinator.submit(layout("workspace-a", 560));
  await waitFor(() => attempts.includes(560));
  const latest = coordinator.submit(layout("workspace-a", 640));
  quiescing = false;
  await Promise.all([first, latest]);

  assert.deepEqual(accepted, [640]);
  coordinator.dispose();
});

test("an invalid stage response fails explicitly and can be resubmitted without a retry loop", async () => {
  const accepted: number[] = [];
  const errors: unknown[] = [];
  let invalid = true;
  const coordinator = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1,
    async stage(value) {
      if (invalid) throw new Error("Workspace layout stage result is invalid.");
      accepted.push(value.paneWidths[0]!);
      return { accepted: true };
    },
    onError: (error) => errors.push(error),
  });
  const latest = layout("workspace-a", 560);

  await assert.rejects(() => coordinator.submit(latest), /stage result is invalid/i);
  assert.equal(errors.length, 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(accepted, []);

  invalid = false;
  await coordinator.submit(latest);
  assert.deepEqual(accepted, [560]);
  coordinator.dispose();
});

function layout(workspaceId: string, width: number): WorkspaceLayout {
  return {
    workspaceId,
    openConversationIds: [`${workspaceId}-conversation`],
    paneConversationIds: [`${workspaceId}-conversation`],
    paneWidths: [width],
    activeConversationId: `${workspaceId}-conversation`,
    requestedPaneCount: 1,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Coordinator test timed out.");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
