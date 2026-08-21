import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceLayout } from "@scopeguard/domain";

import { Phase3LayoutDrainEvidence } from "./phase3-layout-drain-evidence.js";

test("proves the target revision was rejected then accepted only during Renderer drain", () => {
  const target = layout(560);
  const evidence = new Phase3LayoutDrainEvidence(target);

  evidence.recordStage(target, { accepted: false, reason: "quiescing" }, false);
  evidence.recordRendererDrainStarted();
  evidence.recordStage(target, { accepted: true }, true);
  evidence.recordRendererDrainAcknowledged();
  evidence.recordMainSuspended();
  evidence.recordSqliteFlushed();

  assert.deepEqual(evidence.snapshot(), {
    targetRevisionRejectedWhileQuiescing: true,
    targetRevisionAcceptedDuringRendererDrain: true,
    targetRevisionAcceptedOutsideRendererDrain: false,
    events: [
      "target-revision-rejected-quiescing",
      "renderer-drain-started",
      "target-revision-accepted-during-renderer-drain",
      "renderer-drain-acknowledged",
      "main-suspended",
      "sqlite-flushed",
    ],
  });
});

test("exposes a normal retry that accepts the target revision before Renderer drain", () => {
  const target = layout(560);
  const evidence = new Phase3LayoutDrainEvidence(target);

  evidence.recordStage(target, { accepted: false, reason: "quiescing" }, false);
  evidence.recordStage(target, { accepted: true }, false);
  evidence.recordRendererDrainStarted();
  evidence.recordRendererDrainAcknowledged();

  assert.equal(evidence.snapshot().targetRevisionAcceptedDuringRendererDrain, false);
  assert.equal(evidence.snapshot().targetRevisionAcceptedOutsideRendererDrain, true);
  assert.deepEqual(evidence.snapshot().events, [
    "target-revision-rejected-quiescing",
    "target-revision-accepted-outside-renderer-drain",
    "renderer-drain-started",
    "renderer-drain-acknowledged",
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
