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

test("terminal quiesce drains every Workspace immediately and blocks new submissions", async () => {
  const attempts: string[] = [];
  const accepted: string[] = [];
  let mainQuiescing = true;
  const coordinator = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1_000,
    async stage(value) {
      const key = `${value.workspaceId}:${value.paneWidths[0]}`;
      attempts.push(key);
      if (mainQuiescing) return { accepted: false, reason: "quiescing" };
      accepted.push(key);
      return { accepted: true };
    },
  });

  const workspaceA = coordinator.submit(layout("workspace-a", 560));
  const workspaceB = coordinator.submit(layout("workspace-b", 620));
  await waitFor(() => attempts.length === 2);
  mainQuiescing = false;

  const drained = coordinator.quiesceAndDrain();
  await assert.rejects(
    () => coordinator.submit(layout("workspace-a", 680)),
    /quiescing/i,
  );
  await Promise.all([workspaceA, workspaceB, drained]);

  assert.deepEqual(new Set(accepted), new Set([
    "workspace-a:560",
    "workspace-b:620",
  ]));
  coordinator.resumeSubmissions();
  await coordinator.submit(layout("workspace-a", 700));
  assert.equal(accepted.at(-1), "workspace-a:700");
  coordinator.dispose();
});

test("terminal drain overtakes a stale quiescing response without waiting its retry timer", async () => {
  let releaseFirst: (() => void) | undefined;
  let firstAttemptStarted: (() => void) | undefined;
  const firstAttempt = new Promise<void>((resolve) => {
    firstAttemptStarted = resolve;
  });
  let attempts = 0;
  const coordinator = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1_000,
    async stage() {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { accepted: false, reason: "quiescing" };
      }
      return { accepted: true };
    },
  });

  const submitted = coordinator.submit(layout("workspace-a", 560));
  await firstAttempt;
  const drained = coordinator.quiesceAndDrain();
  releaseFirst?.();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([submitted, drained]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Terminal drain waited for the retry timer.")),
          50,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assert.equal(attempts, 2);
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
