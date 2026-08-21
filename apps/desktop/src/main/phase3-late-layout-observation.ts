export type LateWorkspaceLayoutStageReceipt = {
  armedAtUnixMs: number;
  dueAtUnixMs: number;
};

export type Phase3LateLayoutObservation = LateWorkspaceLayoutStageReceipt & {
  rendererDestroyedAtUnixMs: number;
  observationCompletedAtUnixMs: number;
  lateLayoutStageAttempts: number;
};

export function parseLateWorkspaceLayoutStageReceipt(
  value: unknown,
  expectedDelayMs: number,
): LateWorkspaceLayoutStageReceipt {
  if (!isExactObject(value, ["armedAtUnixMs", "dueAtUnixMs"])) {
    throw new Error("Late Workspace layout stage receipt must have exact fields.");
  }
  const armedAtUnixMs = parseTimestamp(value.armedAtUnixMs, "armedAtUnixMs");
  const dueAtUnixMs = parseTimestamp(value.dueAtUnixMs, "dueAtUnixMs");
  if (!Number.isSafeInteger(expectedDelayMs) || expectedDelayMs <= 0) {
    throw new Error("Late Workspace layout stage delay must be a positive safe integer.");
  }
  if (dueAtUnixMs - armedAtUnixMs !== expectedDelayMs) {
    throw new Error("Late Workspace layout stage receipt does not match its requested delay.");
  }
  return { armedAtUnixMs, dueAtUnixMs };
}

export function assertPhase3LateLayoutObservation(
  value: Phase3LateLayoutObservation,
): void {
  const armedAtUnixMs = parseTimestamp(value.armedAtUnixMs, "armedAtUnixMs");
  const dueAtUnixMs = parseTimestamp(value.dueAtUnixMs, "dueAtUnixMs");
  const rendererDestroyedAtUnixMs = parseTimestamp(
    value.rendererDestroyedAtUnixMs,
    "rendererDestroyedAtUnixMs",
  );
  const observationCompletedAtUnixMs = parseTimestamp(
    value.observationCompletedAtUnixMs,
    "observationCompletedAtUnixMs",
  );
  if (!Number.isSafeInteger(value.lateLayoutStageAttempts) || value.lateLayoutStageAttempts < 0) {
    throw new Error("Late Workspace layout stage attempts must be a non-negative safe integer.");
  }
  if (dueAtUnixMs <= armedAtUnixMs) {
    throw new Error("Delayed layout revision due time must follow its arm time.");
  }
  if (rendererDestroyedAtUnixMs < armedAtUnixMs) {
    throw new Error("Renderer destruction cannot precede the delayed layout arm time.");
  }
  if (rendererDestroyedAtUnixMs >= dueAtUnixMs) {
    throw new Error("Renderer must be destroyed before the delayed layout revision was due.");
  }
  if (observationCompletedAtUnixMs < dueAtUnixMs) {
    throw new Error("Post-destroy observation window ended before the delayed revision was due.");
  }
  if (value.lateLayoutStageAttempts !== 0) {
    throw new Error("A late Renderer layout revision crossed IPC after destruction.");
  }
}

function parseTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe-integer Unix timestamp.`);
  }
  return value as number;
}

function isExactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}
