import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPhase3LateLayoutObservation,
  parseLateWorkspaceLayoutStageReceipt,
} from "./phase3-late-layout-observation.js";

test("Phase 3 accepts only an exact arm receipt matching the requested delay", () => {
  assert.deepEqual(
    parseLateWorkspaceLayoutStageReceipt({
      armedAtUnixMs: 1_000,
      dueAtUnixMs: 2_000,
    }, 1_000),
    { armedAtUnixMs: 1_000, dueAtUnixMs: 2_000 },
  );
  assert.throws(
    () => parseLateWorkspaceLayoutStageReceipt({
      armedAtUnixMs: 1_000,
      dueAtUnixMs: 2_000,
      extra: true,
    }, 1_000),
    /exact fields/i,
  );
  assert.throws(
    () => parseLateWorkspaceLayoutStageReceipt({
      armedAtUnixMs: 1_000,
      dueAtUnixMs: 2_001,
    }, 1_000),
    /does not match/i,
  );
});

test("Phase 3 rejects a delayed layout revision that was due before Renderer destruction", () => {
  assert.throws(
    () => assertPhase3LateLayoutObservation({
      armedAtUnixMs: 1_000,
      dueAtUnixMs: 2_000,
      rendererDestroyedAtUnixMs: 2_200,
      observationCompletedAtUnixMs: 2_400,
      lateLayoutStageAttempts: 0,
    }),
    /destroyed before the delayed layout revision was due/i,
  );
});

test("Phase 3 requires an observation window extending beyond the delayed revision deadline", () => {
  assert.throws(
    () => assertPhase3LateLayoutObservation({
      armedAtUnixMs: 1_000,
      dueAtUnixMs: 2_000,
      rendererDestroyedAtUnixMs: 1_500,
      observationCompletedAtUnixMs: 1_900,
      lateLayoutStageAttempts: 0,
    }),
    /observation window ended before/i,
  );
});

test("Phase 3 accepts only a zero-IPC window spanning Renderer destruction and the due time", () => {
  assert.doesNotThrow(() => assertPhase3LateLayoutObservation({
    armedAtUnixMs: 1_000,
    dueAtUnixMs: 2_000,
    rendererDestroyedAtUnixMs: 1_500,
    observationCompletedAtUnixMs: 2_200,
    lateLayoutStageAttempts: 0,
  }));
});
