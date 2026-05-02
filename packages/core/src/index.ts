export const Skeleton = "core-skeleton";

export type { FileLock } from "./locks.js";
export type { DataDirName, DataDirResolution } from "./data-dir.js";
export { dataPath, resolveDataDir } from "./data-dir.js";
export {
  acquireLocks,
  createFileLockService,
  detectLockConflicts,
  listLocks,
  releaseLocks,
} from "./locks.js";

export type { VerifyResult } from "./verifier.js";
export { verifyTask } from "./verifier.js";
export type { NextTasksResult, RunGuardResult, ScheduleResult } from "./scheduler.js";
export { canRunTask, getNextTasks, getSchedule } from "./scheduler.js";
export type { DoctorReport } from "./doctor.js";
export { formatDoctorReport, runDoctor } from "./doctor.js";
export type { SmokeCheck, SmokeCheckStatus, SmokeReport } from "./smoke.js";
export { formatSmokeReport, runSmoke } from "./smoke.js";
export type { MigrationMode, MigrationOptions, MigrationResult, MigrationStatus } from "./migrate.js";
export { formatMigrationResult, migrateDataDir } from "./migrate.js";

export type {
  CloseTaskResult,
  DiscardActionResult,
  FixScopeActionResult,
  GetReviewContentResult,
  ReopenTaskResult,
  ReviewActionResult,
} from "./actions.js";
export { closeTask, discardTask, fixScopeTask, generateReviewReport, getReviewReportContent, reopenTask } from "./actions.js";
