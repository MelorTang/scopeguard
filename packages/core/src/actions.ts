import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { minimatch } from "minimatch";
import { createFileLockService } from "./locks.js";
import { dataPath, resolveDataDir } from "./data-dir.js";

const DEFAULT_GENERATED_FORBIDDEN_PATTERNS = [
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.map",
  "**/*.tsbuildinfo",
] as const;

type TaskRecord = {
  id: string;
  projectId: string;
  requirementId: string;
  title: string;
  description: string;
  status: string;
  agentType: string;
  allowedFiles: string[];
  lockedFiles: string[];
  forbiddenFiles: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  commands: string[];
  riskLevel: "low" | "medium" | "high";
  branchName: string | null;
  worktreePath: string | null;
  diffPath: string | null;
  testLogPath: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

type VerifyReport = {
  taskId: string;
  verifiedAt: string;
  status: "passed" | "failed";
  changedFiles: string[];
  scopeCheck: {
    passed: boolean;
    outsideAllowedFiles: string[];
    forbiddenFilesChanged: string[];
    generatedArtifactsChanged: string[];
  };
  commands: Array<{ command: string; exitCode: number; passed: boolean }>;
  summary: string;
};

type CodexResult = {
  status?: string;
  summary?: string;
  files_changed?: string[];
  tests_run?: Array<{ command?: string; result?: string; notes?: string }>;
  blocked_changes?: Array<{ reason?: string; suggested_file?: string }>;
  risks?: string[];
};

type FixScopeReport = {
  taskId: string;
  fixedAt: string;
  status: "passed" | "failed";
  revertedFiles: string[];
  remainingChangedFiles: string[];
  errors: string[];
  summary: string;
};

export type ReviewActionResult =
  | {
      ok: true;
      taskId: string;
      message: string;
      reviewPath: string;
      recommendation: string;
    }
  | { ok: false; taskId: string; message: string };

export type GetReviewContentResult =
  | { ok: true; taskId: string; content: string; reviewPath: string }
  | { ok: false; taskId: string; message: string };

export type FixScopeActionResult =
  | {
      ok: true;
      taskId: string;
      message: string;
      reportPath: string;
      revertedFiles: string[];
      remainingChangedFiles: string[];
    }
  | {
      ok: false;
      taskId: string;
      message: string;
      reportPath?: string;
      revertedFiles?: string[];
      remainingChangedFiles?: string[];
    };

export type DiscardActionResult =
  | { ok: true; taskId: string; message: string }
  | { ok: false; taskId: string; message: string };

export type CloseTaskResult =
  | { ok: true; taskId: string; message: string; warning?: string; status: "closed" }
  | { ok: false; taskId: string; message: string };

export type ReopenTaskResult =
  | { ok: true; taskId: string; message: string; status: "ready" }
  | { ok: false; taskId: string; message: string };

export type ReviewOptions = {
  workingTree?: boolean;
};

export function generateReviewReport(
  gitRoot: string,
  taskId: string,
  outputPath?: string,
  options?: ReviewOptions,
): ReviewActionResult {
  const taskDir = dataPath(gitRoot, "tasks", taskId);
  const taskPath = join(taskDir, "task.json");
  if (!existsSync(taskPath)) {
    return { ok: false, taskId, message: `Task ${taskId} not found.` };
  }

  const finalOutputPath = outputPath ?? join(taskDir, "review.md");
  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  const diffPath = join(taskDir, "diff.patch");
  const verifyPath = join(taskDir, "verify-report.json");
  const testLogPath = join(taskDir, "test.log");
  const resultPath = join(taskDir, "result.json");
  const stdoutPath = join(taskDir, "stdout.log");
  const stderrPath = join(taskDir, "stderr.log");

  if (options?.workingTree === true) {
    mkdirSync(taskDir, { recursive: true });
    const currentDiff = runGitArgs(gitRoot, ["diff"]).stdout;
    writeFileSync(diffPath, currentDiff, "utf-8");
  }

  const diffText = existsSync(diffPath) ? readFileSync(diffPath, "utf-8") : null;
  const verifyReport = existsSync(verifyPath)
    ? (JSON.parse(readFileSync(verifyPath, "utf-8")) as VerifyReport)
    : null;
  const testLog = existsSync(testLogPath) ? readFileSync(testLogPath, "utf-8") : null;
  const result = existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, "utf-8")) as CodexResult) : null;
  const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf-8") : null;
  const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf-8") : null;

  const changedFiles = collectChangedFiles(verifyReport, diffText);
  const hasArtifacts = (diffText && diffText.trim().length > 0) || existsSync(resultPath) || existsSync(verifyPath);
  const recommendation = getReviewRecommendation(task.status, verifyReport, hasArtifacts);
  const scopeSection = buildScopeSection(verifyReport);
  const verificationSection = buildVerificationSection(verifyReport);
  const testCommandsSection = buildTestCommandsSection(task, verifyReport, testLog);
  const codexResultSection = buildCodexResultSection(result, stdout, stderr);
  const risksSection = buildRisksSection(task, result, verifyReport);
  const notesSection = buildNotesSection(taskId, verifyReport, diffText);

  const acceptanceCriteria = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria.map((item) => `- [ ] ${item}`).join("\n")
    : "Not available.";
  const changedFilesText = changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join("\n") : "No changed files detected.";

  const markdown = `# Review Report: ${task.id}

## Summary

- Title: ${task.title}
- Status: ${task.status}
- Agent: ${task.agentType}
- Risk: ${task.riskLevel}
- Requirement: ${task.requirementId}
- Branch: ${task.branchName ?? "Not available."}
- Worktree: ${task.worktreePath ?? "Not available."}

## Recommendation

${recommendation}

## Task Description

${task.description || "Not available."}

## Acceptance Criteria

${acceptanceCriteria}

## Changed Files

${changedFilesText}

## Scope Check

${scopeSection}

## Verification

${verificationSection}

## Test Commands

${testCommandsSection}

## Codex Result

${codexResultSection}

## Risks

${risksSection}

## Notes for Human Reviewer

${notesSection}
`;

  mkdirSync(dirname(finalOutputPath), { recursive: true });
  writeFileSync(finalOutputPath, markdown, "utf-8");

  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  return {
    ok: true,
    taskId,
    message: `Review report generated for ${taskId}.`,
    reviewPath: normalizePath(finalOutputPath),
    recommendation,
  };
}

export function getReviewReportContent(gitRoot: string, taskId: string): GetReviewContentResult {
  const reviewPath = dataPath(gitRoot, "tasks", taskId, "review.md");
  if (!existsSync(reviewPath)) {
    return { ok: false, taskId, message: "Review report not found. Run review first." };
  }
  return { ok: true, taskId, content: readFileSync(reviewPath, "utf-8"), reviewPath: normalizePath(reviewPath) };
}

export function fixScopeTask(gitRoot: string, taskId: string): FixScopeActionResult {
  const resolved = resolveDataDir(gitRoot);
  const taskDir = dataPath(gitRoot, "tasks", taskId);
  const taskPath = join(taskDir, "task.json");
  if (!existsSync(taskPath)) {
    return { ok: false, taskId, message: `Task ${taskId} not found.` };
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  if (!task.worktreePath) {
    return { ok: false, taskId, message: `Task ${taskId} has no worktreePath.` };
  }

  const expectedWorktreeRel = `${resolved.dataDirName}/worktrees/${taskId}`;
  if (normalizePath(task.worktreePath) !== normalizePath(expectedWorktreeRel)) {
    return { ok: false, taskId, message: `Unsafe task worktreePath: ${task.worktreePath}` };
  }

  const worktreeAbsPath = join(gitRoot, task.worktreePath);
  if (!existsSync(worktreeAbsPath)) {
    return { ok: false, taskId, message: `Task worktree does not exist: ${task.worktreePath}` };
  }

  const diffPatchPath = join(taskDir, "diff.patch");
  const fixScopeReportPath = join(taskDir, "fix-scope-report.json");

  const changedFiles = parseChangedFiles(runGitArgs(worktreeAbsPath, ["diff", "--name-only"]).stdout);
  const generatedArtifactsToRevert = dedupeFileList(
    changedFiles.filter((file) => DEFAULT_GENERATED_FORBIDDEN_PATTERNS.some((pattern) => matchesGlob(file, pattern))),
  );
  const forbiddenFilesToRevert = dedupeFileList(
    changedFiles.filter((file) => task.forbiddenFiles.some((pattern) => matchesGlob(file, pattern))),
  );
  const outsideAllowedFilesToRevert = dedupeFileList(
    changedFiles.filter((file) => !task.allowedFiles.some((pattern) => matchesGlob(file, pattern))),
  );
  const targets = dedupeFileList([
    ...generatedArtifactsToRevert,
    ...forbiddenFilesToRevert,
    ...outsideAllowedFilesToRevert,
  ]);

  const errors: string[] = [];
  const revertedFiles: string[] = [];

  for (const target of targets) {
    if (!isSafeRelativeFilePath(target)) {
      errors.push(`Rejected unsafe file path: ${target}`);
      continue;
    }
    const checkout = runGitArgs(worktreeAbsPath, ["checkout", "--", target]);
    if (checkout.status !== 0) {
      const stderr = checkout.stderr.trim();
      errors.push(`Failed to revert ${target}${stderr ? `: ${stderr}` : ""}`);
      continue;
    }
    revertedFiles.push(target);
  }

  const remainingChangedFiles = parseChangedFiles(runGitArgs(worktreeAbsPath, ["diff", "--name-only"]).stdout);
  const diffPatch = runGitArgs(worktreeAbsPath, ["diff"]).stdout;
  writeFileSync(diffPatchPath, diffPatch, "utf-8");

  const fixedAt = new Date().toISOString();
  const report: FixScopeReport = {
    taskId,
    fixedAt,
    status: errors.length === 0 ? "passed" : "failed",
    revertedFiles,
    remainingChangedFiles,
    errors,
    summary:
      targets.length === 0
        ? "No out-of-scope files required reverting."
        : `Reverted ${revertedFiles.length} out-of-scope file(s).`,
  };
  writeFileSync(fixScopeReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  if (errors.length > 0) {
    task.status = "test_failed";
  } else if (remainingChangedFiles.length > 0) {
    task.status = "needs_review";
  } else {
    task.status = "ready";
  }
  task.diffPath = `${resolved.dataDirName}/tasks/${taskId}/diff.patch`;
  task.resultSummary =
    targets.length === 0
      ? "No out-of-scope files were found by fix-scope."
      : `fix-scope reverted ${revertedFiles.length} out-of-scope file(s).`;
  task.updatedAt = fixedAt;
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  if (targets.length === 0) {
    return {
      ok: true,
      taskId,
      message: `No out-of-scope files to revert for ${taskId}.`,
      reportPath: `${resolved.dataDirName}/tasks/${taskId}/fix-scope-report.json`,
      revertedFiles,
      remainingChangedFiles,
    };
  }

  if (errors.length > 0) {
    return {
      ok: false,
      taskId,
      message: `Fixed scope for ${taskId} with errors.`,
      reportPath: `${resolved.dataDirName}/tasks/${taskId}/fix-scope-report.json`,
      revertedFiles,
      remainingChangedFiles,
    };
  }

  return {
    ok: true,
    taskId,
    message: `Fixed scope for ${taskId}.`,
    reportPath: `${resolved.dataDirName}/tasks/${taskId}/fix-scope-report.json`,
    revertedFiles,
    remainingChangedFiles,
  };
}

export function discardTask(gitRoot: string, taskId: string, options?: { toStatus?: "ready" | "backlog"; keepBranch?: boolean; keepWorktree?: boolean }): DiscardActionResult {
  const toStatus = options?.toStatus ?? "ready";
  const keepBranch = options?.keepBranch ?? false;
  const keepWorktree = options?.keepWorktree ?? false;

  const resolved = resolveDataDir(gitRoot);
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  if (!existsSync(taskPath)) {
    return { ok: false, taskId, message: `Task ${taskId} not found.` };
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  const allowedStatuses = new Set(["in_progress", "needs_review", "test_failed", "conflict", "blocked", "ready"]);
  if (task.status === "approved" || task.status === "merged") {
    return { ok: false, taskId, message: `Task ${taskId} is approved/merged and cannot be discarded.` };
  }
  if (!allowedStatuses.has(task.status)) {
    return { ok: false, taskId, message: `Task ${taskId} status ${task.status} cannot be discarded.` };
  }

  const taskDir = dataPath(gitRoot, "tasks", taskId);
  archiveTaskArtifacts(taskDir);

  const defaultWorktreeRelPath = `${resolved.dataDirName}/worktrees/${taskId}`;
  const worktreeRelPath = task.worktreePath ?? defaultWorktreeRelPath;
  if (!keepWorktree) {
    removeTaskWorktree(gitRoot, worktreeRelPath, taskId);
  }

  const defaultBranch = `agent/${taskId}`;
  const branchName = task.branchName ?? defaultBranch;
  if (!keepBranch) {
    deleteTaskBranch(gitRoot, branchName);
  }

  const lockService = createFileLockService(gitRoot);
  lockService.releaseLocks(taskId);

  task.status = toStatus;
  task.branchName = keepBranch ? task.branchName : null;
  task.worktreePath = keepWorktree ? task.worktreePath : null;
  task.diffPath = null;
  task.testLogPath = null;
  task.resultSummary = null;
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  return { ok: true, taskId, message: `Discarded task ${taskId}.` };
}

export function closeTask(gitRoot: string, taskId: string, reason?: string): CloseTaskResult {
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  if (!existsSync(taskPath)) {
    return { ok: false, taskId, message: `Task ${taskId} not found.` };
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord & {
    closedAt?: string;
    closeReason?: string;
    reopenedAt?: string;
  };
  if (task.status === "merged") {
    return { ok: false, taskId, message: `Task ${taskId} is merged and cannot be closed.` };
  }
  if (task.status === "closed") {
    return { ok: true, taskId, message: `Task ${taskId} is already closed.`, status: "closed" };
  }

  const closeReason = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "manual";
  const now = new Date().toISOString();
  task.status = "closed";
  task.closedAt = now;
  task.closeReason = closeReason;
  task.updatedAt = now;
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  const hasArtifacts = Boolean(task.worktreePath) || Boolean(task.branchName);
  const warning = hasArtifacts
      ? `Task ${taskId} has execution artifacts. Consider running: scopeguard discard ${taskId}`
    : undefined;
  return {
    ok: true,
    taskId,
    message: `Closed task ${taskId}.`,
    warning,
    status: "closed",
  };
}

export function reopenTask(gitRoot: string, taskId: string): ReopenTaskResult {
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  if (!existsSync(taskPath)) {
    return { ok: false, taskId, message: `Task ${taskId} not found.` };
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord & {
    closedAt?: string;
    closeReason?: string;
    reopenedAt?: string;
  };
  if (task.status !== "closed") {
    return { ok: false, taskId, message: `Task ${taskId} is not closed.` };
  }

  const now = new Date().toISOString();
  task.status = "ready";
  task.reopenedAt = now;
  task.updatedAt = now;
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  return { ok: true, taskId, message: `Reopened task ${taskId}.`, status: "ready" };
}

function parseChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function matchesGlob(filePath: string, pattern: string): boolean {
  return minimatch(normalizePath(filePath), normalizePath(pattern), { dot: true });
}

function isSafeRelativeFilePath(filePath: string): boolean {
  const normalized = normalizePath(filePath).trim();
  if (normalized.length === 0 || normalized === "." || normalized.endsWith("/")) {
    return false;
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  if (normalized.includes("*") || normalized.includes("?")) {
    return false;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    return false;
  }
  return true;
}

function dedupeFileList(files: string[]): string[] {
  return [...new Set(files.map((file) => normalizePath(file)))].sort();
}

function runGitArgs(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", ["-c", "safe.directory=*", ...args], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    status: typeof res.status === "number" ? res.status : null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function parseReviewOutputPath(gitRoot: string, taskId: string, value?: string): string {
  if (!value) {
    return dataPath(gitRoot, "tasks", taskId, "review.md");
  }
  const dataDirName = resolveDataDir(gitRoot).dataDirName;
  if (value.startsWith(`${dataDirName}/`) || value.startsWith(`${dataDirName}\\`)) {
    return join(gitRoot, value);
  }
  return resolve(gitRoot, value);
}

function collectChangedFiles(verifyReport: VerifyReport | null, diffText: string | null): string[] {
  if (verifyReport && Array.isArray(verifyReport.changedFiles) && verifyReport.changedFiles.length > 0) {
    return verifyReport.changedFiles;
  }
  if (!diffText) {
    return [];
  }

  const files = new Set<string>();
  for (const line of diffText.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) {
      continue;
    }
    files.add(match[2]);
  }
  return [...files];
}

function getReviewRecommendation(taskStatus: string, verifyReport: VerifyReport | null, hasArtifacts: boolean): string {
  if (!hasArtifacts) {
    return "[INFO] No execution artifacts found";
  }
  if (taskStatus === "blocked") {
    return "[BLOCKED] Blocked";
  }
  if (taskStatus === "merged" && verifyReport?.status === "passed") {
    return "[PASS] Merged";
  }
  if ((taskStatus === "needs_review" || taskStatus === "approved") && verifyReport?.status === "passed") {
    return "[PASS] Ready for human review";
  }
  if (taskStatus === "test_failed" || verifyReport?.status === "failed") {
    return "[WARN] Needs fixes before review";
  }
  return "[WARN] Needs fixes before review";
}

function buildScopeSection(verifyReport: VerifyReport | null): string {
  if (!verifyReport) {
  return "Not available. Run `scopeguard verify <task-id>` first.";
  }
  return `Passed: ${String(verifyReport.scopeCheck.passed)}

Outside allowed files:
${toListOrNotAvailable(verifyReport.scopeCheck.outsideAllowedFiles)}

Forbidden files changed:
${toListOrNotAvailable(verifyReport.scopeCheck.forbiddenFilesChanged)}

Generated artifacts changed:
${toListOrNotAvailable(verifyReport.scopeCheck.generatedArtifactsChanged)}`;
}

function buildVerificationSection(verifyReport: VerifyReport | null): string {
  if (!verifyReport) {
    return "Not available.";
  }
  return `Status: ${verifyReport.status}
Verified at: ${verifyReport.verifiedAt}
Summary: ${verifyReport.summary}`;
}

function buildTestCommandsSection(task: TaskRecord, verifyReport: VerifyReport | null, testLog: string | null): string {
  if (verifyReport && verifyReport.commands.length > 0) {
    return verifyReport.commands.map((cmd) => `- \`${cmd.command}\` (exitCode: ${cmd.exitCode}, passed: ${String(cmd.passed)})`).join("\n");
  }
  if (task.commands.length > 0) {
    return `${task.commands.map((cmd) => `- \`${cmd}\``).join("\n")}\n\nNot verified yet.`;
  }
  if (testLog && testLog.trim().length > 0) {
    return "Not available in verify report. See test.log for raw command output.";
  }
  return "Not available.";
}

function buildCodexResultSection(result: CodexResult | null, stdout: string | null, stderr: string | null): string {
  if (result) {
    const lines: string[] = [];
    lines.push(`status: ${result.status ?? "Not available."}`);
    lines.push(`summary: ${result.summary ?? "Not available."}`);
    lines.push("files_changed:");
    lines.push(toListOrNotAvailable(result.files_changed));
    lines.push("tests_run:");
    if (!result.tests_run || result.tests_run.length === 0) {
      lines.push("Not available.");
    } else {
      for (const item of result.tests_run) {
        lines.push(`- ${JSON.stringify(item)}`);
      }
    }
    lines.push("blocked_changes:");
    if (!result.blocked_changes || result.blocked_changes.length === 0) {
      lines.push("Not available.");
    } else {
      for (const item of result.blocked_changes) {
        lines.push(`- ${JSON.stringify(item)}`);
      }
    }
    lines.push("risks:");
    lines.push(toListOrNotAvailable(result.risks));
    return lines.join("\n");
  }

  if (stdout && stdout.trim().length > 0) {
    const lines = stdout.split(/\r?\n/);
    const tail = lines.slice(-80).join("\n");
    return `result.json not available.\n\nstdout.log tail (last 80 lines):\n\n${tail}`;
  }

  if (stderr && stderr.trim().length > 0) {
    return `result.json/stdout.log not available.\n\nstderr.log:\n\n${stderr}`;
  }

  return "Not available.";
}

function buildRisksSection(task: TaskRecord, result: CodexResult | null, verifyReport: VerifyReport | null): string {
  const risks = new Set<string>();
  risks.add(`Task risk level: ${task.riskLevel}`);
  for (const risk of result?.risks ?? []) {
    risks.add(`Codex risk: ${risk}`);
  }
  for (const file of verifyReport?.scopeCheck.generatedArtifactsChanged ?? []) {
    risks.add(`Generated artifact changed: ${file}`);
  }
  for (const file of verifyReport?.scopeCheck.outsideAllowedFiles ?? []) {
    risks.add(`Outside allowed files: ${file}`);
  }
  for (const file of verifyReport?.scopeCheck.forbiddenFilesChanged ?? []) {
    risks.add(`Forbidden file changed: ${file}`);
  }
  return [...risks].map((item) => `- ${item}`).join("\n");
}

function buildNotesSection(taskId: string, verifyReport: VerifyReport | null, diffText: string | null): string {
  const notes: string[] = [];
  if ((verifyReport?.scopeCheck.generatedArtifactsChanged ?? []).length > 0) {
    notes.push(
      "This task modified generated artifacts. Ask the agent to update source files only and rerun build instead of editing dist/build outputs directly.",
    );
  }
  if ((verifyReport?.scopeCheck.outsideAllowedFiles ?? []).length > 0) {
    notes.push(
      "This task changed files outside its allowed scope. Review whether the plan should be split or allowedFiles should be updated.",
    );
  }
  if (!verifyReport) {
    notes.push(`Run \`scopeguard verify ${taskId}\` before approving this task.`);
  }
  if (!diffText || diffText.trim().length === 0) {
    notes.push("No diff was detected. Confirm whether the task actually made changes.");
  }
  if (notes.length === 0) {
    return "- No additional reviewer notes.";
  }
  return notes.map((note) => `- ${note}`).join("\n");
}

function toListOrNotAvailable(items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return "Not available.";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function archiveTaskArtifacts(taskDir: string): string[] {
  const artifactNames = [
    "prompt.md",
    "result.json",
    "stdout.log",
    "stderr.log",
    "diff.patch",
    "test.log",
    "verify-report.json",
    "review.md",
  ] as const;
  const existing = artifactNames.filter((name) => existsSync(join(taskDir, name)));
  if (existing.length === 0) {
    return [];
  }
  const timestamp = formatDiscardTimestamp(new Date());
  const archiveDir = join(taskDir, "discarded-runs", timestamp);
  mkdirSync(archiveDir, { recursive: true });
  for (const name of existing) {
    renameSync(join(taskDir, name), join(archiveDir, name));
  }
  return [...existing];
}

function removeTaskWorktree(gitRoot: string, worktreeRelPath: string, taskId: string): string {
  const expected = dataPath(gitRoot, "worktrees", taskId);
  const target = join(gitRoot, worktreeRelPath);
  const expectedNorm = normalizePath(expected);
  const targetNorm = normalizePath(target);
  if (targetNorm !== expectedNorm) {
    return `Skipped unsafe worktree path: ${worktreeRelPath}`;
  }
  if (!existsSync(target)) {
    runGitArgs(gitRoot, ["worktree", "prune"]);
    return `${worktreeRelPath} (not found)`;
  }
  const registeredWorktrees = getRegisteredWorktrees(gitRoot);
  if (registeredWorktrees.has(expectedNorm)) {
    runGitArgs(gitRoot, ["worktree", "remove", target, "--force"]);
  } else {
    rmSync(target, { recursive: true, force: true });
  }
  runGitArgs(gitRoot, ["worktree", "prune"]);
  return worktreeRelPath;
}

function getRegisteredWorktrees(gitRoot: string): Set<string> {
  const output = runGitArgs(gitRoot, ["worktree", "list", "--porcelain"]).stdout;
  const result = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const absPath = line.slice("worktree ".length).trim();
    if (absPath.length > 0) {
      result.add(normalizePath(absPath));
    }
  }
  return result;
}

function deleteTaskBranch(gitRoot: string, branchName: string): string {
  if (branchName === "main" || branchName === "master") {
    return `Skipped protected branch: ${branchName}`;
  }
  const currentBranch = getCurrentBranch(gitRoot);
  if (currentBranch === branchName) {
    return `Skipped current branch: ${branchName}`;
  }
  if (!branchExists(gitRoot, branchName)) {
    return `${branchName} (not found)`;
  }
  runGitArgs(gitRoot, ["branch", "-D", branchName]);
  return branchName;
}

function branchExists(gitRoot: string, branchName: string): boolean {
  return runGitArgs(gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).status === 0;
}

function getCurrentBranch(gitRoot: string): string | null {
  const value = runGitArgs(gitRoot, ["branch", "--show-current"]).stdout.trim();
  return value.length > 0 ? value : null;
}

function formatDiscardTimestamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}
