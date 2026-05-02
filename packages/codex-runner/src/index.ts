import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import spawn from "cross-spawn";
import { canRunTask, createFileLockService, dataPath, resolveDataDir, type FileLock } from "@scopeguard/core";

export type RunnerTask = {
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

export type RunResult = {
  ok: boolean;
  message: string;
};

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type CodexResultJson = {
  task_id?: string;
  status?: "completed" | "blocked" | "failed" | string;
  summary?: string;
  files_changed?: string[];
};

const DEFAULT_GENERATED_FORBIDDEN_PATTERNS = [
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.map",
  "**/*.tsbuildinfo",
] as const;

const CODEX_NOT_FOUND_MESSAGE = `Codex CLI was not found.\n\nTry:\n  npm install -g @openai/codex\n  where.exe codex\n  npm config get prefix\n\nOn Windows, you can also set:\n  $env:CODEX_BIN="C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd"`;

export function runTaskWithCodex(gitRoot: string, taskId: string): RunResult {
  const taskPath = getTaskPath(gitRoot, taskId);
  if (!existsSync(taskPath)) {
    return { ok: false, message: `Task not found: ${taskId}` };
  }

  const task = readTask(taskPath);
  const guard = canRunTask(gitRoot, taskId);
  if (!guard.ok) {
    const lines = [`Task ${taskId} cannot be run.`, "", "Reasons:"];
    for (const reason of guard.reasons) {
      lines.push(`- ${reason}`);
    }
    return { ok: false, message: lines.join("\n") };
  }

  const codexProbe = resolveCodexBinary();

  const dataDirName = resolveDataDir(gitRoot).dataDirName;
  const taskRoot = dataPath(gitRoot, "tasks", task.id);
  mkdirSync(taskRoot, { recursive: true });
  const lockPatterns = task.lockedFiles.length > 0 ? task.lockedFiles : task.allowedFiles;
  const effectiveForbiddenFiles = buildEffectiveForbiddenFiles(task.forbiddenFiles);
  const prompt = buildCodexPrompt(task, lockPatterns, effectiveForbiddenFiles);
  const promptPath = join(taskRoot, "prompt.md");
  writeFileSync(promptPath, prompt, "utf-8");

  if (!codexProbe.found || !codexProbe.command) {
    task.status = "blocked";
    task.resultSummary = CODEX_NOT_FOUND_MESSAGE;
    task.updatedAt = new Date().toISOString();
    writeTask(taskPath, task);
    return { ok: false, message: CODEX_NOT_FOUND_MESSAGE };
  }

  const lockService = createFileLockService(gitRoot);

  const conflicts = lockService.detectLockConflicts(task.id, lockPatterns);
  if (conflicts.length > 0) {
    task.status = "blocked";
    task.resultSummary = formatConflictSummary(conflicts);
    task.updatedAt = new Date().toISOString();
    writeTask(taskPath, task);
    return { ok: false, message: `Lock conflict: ${task.resultSummary}` };
  }

  const acquired = lockService.acquireLocks(task.id, lockPatterns);
  if (acquired.conflicts.length > 0) {
    task.status = "blocked";
    task.resultSummary = formatConflictSummary(acquired.conflicts);
    task.updatedAt = new Date().toISOString();
    writeTask(taskPath, task);
    return { ok: false, message: `Lock conflict: ${task.resultSummary}` };
  }

  const branchName = `agent/${task.id}`;
  const worktreeRelPath = `${dataDirName}/worktrees/${task.id}`;
  const worktreeAbsPath = join(gitRoot, worktreeRelPath);

  if (existsSync(worktreeAbsPath)) {
    lockService.releaseLocks(task.id);
    return {
      ok: false,
      message: `Worktree already exists at ${worktreeRelPath}. Run \`scopeguard discard ${task.id}\` first.`,
    };
  }

  if (branchExists(gitRoot, branchName)) {
    lockService.releaseLocks(task.id);
    return {
      ok: false,
      message: `Branch ${branchName} already exists. Run \`scopeguard discard ${task.id}\` or handle it manually first.`,
    };
  }

  try {
    execSync(`git -c safe.directory=* worktree add "${worktreeAbsPath}" -b "${branchName}"`, {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (error) {
    lockService.releaseLocks(task.id);
    return { ok: false, message: `Failed to create worktree: ${toErrorMessage(error)}` };
  }

  const worktreeTaskDir = join(worktreeAbsPath, dataDirName);
  mkdirSync(worktreeTaskDir, { recursive: true });
  writeFileSync(
    join(worktreeTaskDir, "current-task.json"),
    `${JSON.stringify({ ...task, effectiveForbiddenFiles }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(join(worktreeTaskDir, "codex-task-prompt.md"), prompt, "utf-8");

  const stdoutPath = join(taskRoot, "stdout.log");
  const stderrPath = join(taskRoot, "stderr.log");
  const diffPath = join(taskRoot, "diff.patch");
  const resultPath = join(taskRoot, "result.json");

  const run = runCommand(
    codexProbe.command,
    ["exec", "--full-auto", prompt],
    worktreeAbsPath,
  );

  writeFileSync(stdoutPath, run.stdout, "utf-8");
  writeFileSync(stderrPath, run.stderr, "utf-8");

  if (run.error) {
    lockService.releaseLocks(task.id);

    task.status = "blocked";
    task.branchName = branchName;
    task.worktreePath = worktreeRelPath;
    task.diffPath = normalizeRel(gitRoot, diffPath);
    task.updatedAt = new Date().toISOString();

    const errorCode = "code" in run.error ? String((run.error as NodeJS.ErrnoException).code ?? "") : "";
    const looksLikeNotFound = errorCode === "ENOENT" || errorCode === "EACCES";

    if (looksLikeNotFound) {
      task.resultSummary = CODEX_NOT_FOUND_MESSAGE;
      const stderrWithHint = run.stderr + (run.stderr ? "\n" : "") + CODEX_NOT_FOUND_MESSAGE;
      writeFileSync(stderrPath, stderrWithHint, "utf-8");
    } else {
      task.resultSummary = `Codex process failed to start: ${toErrorMessage(run.error)}`;
    }

    writeFileSync(diffPath, "", "utf-8");
    writeTask(taskPath, task);

    return { ok: false, message: task.resultSummary };
  }

  const diff = safeGitDiff(worktreeAbsPath);
  writeFileSync(diffPath, diff, "utf-8");

  const codexResult = parseCodexResult(run.stdout);
  if (codexResult) {
    writeFileSync(resultPath, `${JSON.stringify(codexResult, null, 2)}\n`, "utf-8");
  }

  task.branchName = branchName;
  task.worktreePath = worktreeRelPath;
  task.diffPath = normalizeRel(gitRoot, diffPath);
  task.updatedAt = new Date().toISOString();

  const noDiffNote = diff.trim().length === 0 ? " No diff detected." : "";

  if (codexResult) {
    const codexStatus = codexResult.status ?? "failed";
    const codexSummary = codexResult.summary?.trim() || "";

    if (codexStatus === "completed") {
      task.status = "needs_review";
      task.resultSummary = `${codexSummary || "Codex completed."}${noDiffNote}`.trim();
    } else if (codexStatus === "blocked") {
      task.status = "blocked";
      task.resultSummary = `Codex blocked: ${codexSummary || "Task blocked."}${noDiffNote}`;
    } else {
      task.status = "test_failed";
      task.resultSummary = `Codex failed: ${codexSummary || "Task failed."}${noDiffNote}`;
    }
  } else if (run.status === 0) {
    task.status = "needs_review";
    task.resultSummary = `Codex run completed but result JSON could not be parsed.${noDiffNote}`;
  } else {
    task.status = "test_failed";
    task.resultSummary = `Codex run failed with exit code ${String(run.status ?? "unknown")}. See ${dataDirName}/tasks/${task.id}/stderr.log${noDiffNote}`;
  }

  writeTask(taskPath, task);
  lockService.releaseLocks(task.id);

  return {
    ok: task.status === "needs_review",
    message: task.resultSummary ?? `Task ${task.id} processed.`,
  };
}

function resolveCodexBinary(): { found: boolean; command?: string } {
  const isWindows = process.platform === "win32";
  const candidates: string[] = [];

  const envCodexBin = process.env.CODEX_BIN?.trim();
  if (envCodexBin) {
    candidates.push(envCodexBin);
  }

  candidates.push("codex");
  if (isWindows) {
    candidates.push("codex.cmd");
  }

  for (const candidate of candidates) {
    const probe = runCommand(candidate, ["--version"], process.cwd());
    if (!probe.error && probe.status === 0) {
      return { found: true, command: candidate };
    }
  }

  return { found: false };
}

function runCommand(command: string, args: string[], cwd: string): SpawnResult {
  const res = spawn.sync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 1000 * 60 * 30,
    windowsHide: true,
  });

  return {
    status: typeof res.status === "number" ? res.status : null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error as Error | undefined,
  };
}

function parseCodexResult(stdout: string): CodexResultJson | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as CodexResultJson;
      if (typeof parsed === "object" && parsed && typeof parsed.status === "string") {
        return parsed;
      }
    } catch {
      // continue searching
    }
  }

  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as CodexResultJson;
    if (typeof parsed === "object" && parsed && typeof parsed.status === "string") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function getTaskPath(gitRoot: string, taskId: string): string {
  return dataPath(gitRoot, "tasks", taskId, "task.json");
}

function readTask(path: string): RunnerTask {
  return JSON.parse(readFileSync(path, "utf-8")) as RunnerTask;
}

function writeTask(path: string, task: RunnerTask): void {
  writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, "utf-8");
}

function branchExists(gitRoot: string, branchName: string): boolean {
  try {
    execSync(`git -c safe.directory=* rev-parse --verify "refs/heads/${branchName}"`, {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

function safeGitDiff(worktreeAbsPath: string): string {
  try {
    return execSync("git -c safe.directory=* diff", {
      cwd: worktreeAbsPath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 50,
    });
  } catch (error) {
    return `# failed to collect diff\n${toErrorMessage(error)}\n`;
  }
}

function buildCodexPrompt(task: RunnerTask, lockPatterns: string[], effectiveForbiddenFiles: string[]): string {
  return `# ScopeGuard Task Execution\n\nYou are working inside a git worktree created by ScopeGuard.\n\nYour job is to complete exactly one task.\n\n## Task\n\nTask ID: ${task.id}\nTitle: ${task.title}\n\nDescription:\n${task.description}\n\n## Allowed Files\n\nYou may only edit files matching these paths:\n\n${renderList(task.allowedFiles)}\n\n## Locked Files\n\nThis task has acquired locks for:\n\n${renderList(lockPatterns)}\n\n## Forbidden Files\n\nYou must not edit files matching these paths:\n\n${renderList(effectiveForbiddenFiles)}\n\n## Generated Artifacts Are Forbidden\n\nDo not edit generated artifacts directly, even if they match the allowed file patterns.\n\nGenerated artifacts include:\n\n- dist/**\n- build/**\n- .next/**\n- coverage/**\n- *.map\n- *.tsbuildinfo\n\nIf a generated artifact needs to change, modify the source file instead and let the build command regenerate it.\n\nIf the only way to complete the task appears to require editing generated artifacts directly, stop and report the task as blocked.\n\nIf you believe another file must be changed, do not edit it. Instead, add a note in your final report under \`blocked_changes\`.\n\n## Acceptance Criteria\n\n${renderList(task.acceptanceCriteria)}\n\n## Required Commands\n\nRun these commands before finishing:\n\n${renderList(task.commands)}\n\nIf a command fails, try to fix the issue if it is within the allowed file scope. If fixing requires editing files outside the allowed scope, stop and report it.\n\n## Rules\n\n1. Do not modify files outside the allowed file list.\n2. Do not perform unrelated refactors.\n3. Do not rename public APIs unless required by the task.\n4. Do not change formatting across unrelated files.\n5. Do not modify lockfiles unless dependency changes are explicitly required.\n6. Do not commit or merge changes.\n7. Keep the diff minimal and task-focused.\n8. Add or update tests when relevant.\n9. Prefer existing project conventions.\n10. If blocked, explain exactly what is needed.\n11. Do not edit generated artifacts such as dist, build, .next, coverage, *.map, or *.tsbuildinfo files.\n12. Modify source files only and let build commands regenerate generated outputs.\n13. Before finishing, run \`git diff --name-only\` and ensure none of the changed files match the forbidden files list.\n14. If any generated artifact changed, revert that file before finishing.\n\n## Required Final Response Format\n\nReturn your result in this format:\n\n{\n  "task_id": "${task.id}",\n  "status": "completed | blocked | failed",\n  "summary": "short summary of what changed",\n  "files_changed": ["path/to/file"],\n  "tests_run": [\n    {\n      "command": "pnpm test ...",\n      "result": "passed | failed",\n      "notes": "..."\n    }\n  ],\n  "acceptance_criteria_met": [\n    {\n      "criterion": "...",\n      "met": true,\n      "notes": "..."\n    }\n  ],\n  "blocked_changes": [\n    {\n      "reason": "...",\n      "suggested_file": "..."\n    }\n  ],\n  "risks": ["..."]\n}\n`;
}

function buildEffectiveForbiddenFiles(taskForbiddenFiles: string[]): string[] {
  const patterns = new Set<string>();
  for (const pattern of taskForbiddenFiles) {
    patterns.add(pattern);
  }
  for (const pattern of DEFAULT_GENERATED_FORBIDDEN_PATTERNS) {
    patterns.add(pattern);
  }
  return [...patterns];
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "(none)";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatConflictSummary(conflicts: FileLock[]): string {
  const preview = conflicts.slice(0, 3).map((lock) => `${lock.taskId}:${lock.pattern}`).join(", ");
  return `lock conflicts with active locks (${preview})`;
}

function normalizeRel(gitRoot: string, absPath: string): string {
  const rel = absPath.slice(gitRoot.length).replace(/^[/\\]/, "");
  return rel.replace(/\\/g, "/");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
