import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceLayout } from "@scopeguard/domain";

import { Phase3LayoutDrainEvidence } from "./phase3-layout-drain-evidence.js";

test("proves the exact target revision was accepted by a Renderer drain generation", () => {
  const target = layout(560);
  const evidence = new Phase3LayoutDrainEvidence(target);

  evidence.recordStage(target, { accepted: false, reason: "quiescing" });
  evidence.recordStage(target, { accepted: true });
  evidence.recordDrainReceipt({
    generation: "layout-lifecycle-7",
    acceptedRevisions: [{ workspaceId: "workspace", revision: 2, layout: target }],
  });
  evidence.recordMainSuspended();
  evidence.recordSqliteFlushed();

  assert.deepEqual(evidence.snapshot(), {
    targetRevisionRejectedWhileQuiescing: true,
    targetRevisionAcceptedDuringRendererDrain: true,
    targetRevisionAcceptedOutsideRendererDrain: false,
    targetDrainReceipt: {
      generation: "layout-lifecycle-7",
      acceptedRevision: { workspaceId: "workspace", revision: 2, layout: target },
    },
    events: [
      "target-revision-rejected-quiescing",
      "target-revision-accepted-by-main",
      "target-revision-confirmed-by-renderer-drain-receipt",
      "main-suspended",
      "sqlite-flushed",
    ],
  });
});

test("fails causality when an ordinary retry is accepted after drain request but before generation", () => {
  const target = layout(560);
  const evidence = new Phase3LayoutDrainEvidence(target);

  evidence.recordStage(target, { accepted: false, reason: "quiescing" });
  evidence.recordStage(target, { accepted: true });
  evidence.recordDrainReceipt({
    generation: "layout-lifecycle-8",
    acceptedRevisions: [],
  });

  assert.equal(evidence.snapshot().targetRevisionAcceptedDuringRendererDrain, false);
  assert.equal(evidence.snapshot().targetRevisionAcceptedOutsideRendererDrain, true);
  assert.equal(evidence.snapshot().targetDrainReceipt, null);
  assert.deepEqual(evidence.snapshot().events, [
    "target-revision-rejected-quiescing",
    "target-revision-accepted-by-main",
  ]);
});

function layout(width: number): WorkspaceLayout {
  return {
    workspaceId: "workspace",
    openConversationIds: ["conversation"],
    paneConversationIds: ["conversation"],
    paneWidths: [width],
    activeConversationId: "conversation",
    requestedPaneCount: 1,
  };
}
