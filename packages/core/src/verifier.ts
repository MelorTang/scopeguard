import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { minimatch } from "minimatch";
import spawn from "cross-spawn";
import { dataPath, resolveDataDir } from "./data-dir.js";

const DEFAULT_FORBIDDEN_GENERATED = [
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.map",
  "**/*.tsbuildinfo",
] as const;

type TaskRecord = {
  id: string;
  status: string;
  worktreePath: string | null;
  allowedFiles: string[];
  lockedFiles: string[];
  dependencies: string[];
  forbiddenFiles: string[];
  commands: string[];
  testLogPath: string | null;
  updatedAt: string;
};

type VerifyCommandResult = {
  command: string;
  exitCode: number;
  passed: boolean;
};

type VerifyReport = {
  taskId: string;
  verifiedAt: string;
  status: "passed" | "failed";
  changedFiles: string[];
  includeDependencies?: boolean;
  dependencyTaskIds?: string[];
  dependencyFilesChanged?: string[];
  commandsSkipped?: boolean;
  skipReason?: string;
  scopeCheck: {
    passed: boolean;
    outsideAllowedFiles: string[];
    forbiddenFilesChanged: string[];
    generatedArtifactsChanged: string[];
  };
  commands: VerifyCommandResult[];
  summary: string;
};

export type VerifyResult = {
  ok: boolean;
  message: string;
};

export type VerifyOptions = {
  workingTree?: boolean;
  scopeOnly?: boolean;
  includeDependencies?: boolean;
};

export function verifyTask(gitRoot: string, taskId: string, options?: VerifyOptions): VerifyResult {
  const resolved = resolveDataDir(gitRoot);
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  if (!existsSync(taskPath)) {
    return { ok: false, message: `Task ${taskId} not found.` };
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  const useWorkingTree = options?.workingTree === true;
  const scopeOnly = options?.scopeOnly === true;
  const includeDependencies = options?.includeDependencies === true;
  let verifyRoot = gitRoot;

  if (includeDependencies && !useWorkingTree) {
    return { ok: false, message: "--include-dependencies requires --working-tree." };
  }

  if (!useWorkingTree) {
    if (!task.worktreePath) {
      return { ok: false, message: `Task ${taskId} has no worktreePath.` };
    }

    const worktreePath = join(gitRoot, task.worktreePath);
    if (!existsSync(worktreePath)) {
      return { ok: false, message: `Task worktree does not exist: ${task.worktreePath}` };
    }
    verifyRoot = worktreePath;
  }

  const taskRoot = dataPath(gitRoot, "tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  const diffPath = join(taskRoot, "diff.patch");
  const testLogPath = join(taskRoot, "test.log");
  const reportPath = join(taskRoot, "verify-report.json");

  const changedFiles = parseChangedFiles(runGit(verifyRoot, "diff --name-only"));
  const fullDiff = runGit(verifyRoot, "diff");
  writeFileSync(diffPath, fullDiff, "utf-8");

  const dependencyTasks = includeDependencies
    ? loadDependencyTasks(gitRoot, task.dependencies ?? [])
    : [];
  const dependencyTaskIds = dependencyTasks.map((dep) => dep.id);
  const targetOwnedFiles = changedFiles.filter((file) => isOwnedByTaskScope(file, task));
  const dependencyOwnedFiles = includeDependencies
    ? changedFiles.filter((file) => !targetOwnedFiles.includes(file) && dependencyTasks.some((dep) => isOwnedByTaskScope(file, dep)))
    : [];
  const outsideAllowedFiles = includeDependencies
    ? changedFiles.filter((file) => !targetOwnedFiles.includes(file) && !dependencyOwnedFiles.includes(file))
    : changedFiles.filter((file) => !isOwnedByTaskScope(file, task));
  const forbiddenFilesChanged = changedFiles.filter((file) =>
    task.forbiddenFiles.some((pattern) => matchesPattern(file, pattern)),
  );
  const generatedArtifactsChanged = changedFiles.filter((file) =>
    DEFAULT_FORBIDDEN_GENERATED.some((pattern) => matchesPattern(file, pattern)),
  );

  const commandResults = scopeOnly ? [] : runCommandsInWorktree(verifyRoot, task.commands, testLogPath);
  const allCommandsPassed = scopeOnly ? true : commandResults.every((result) => result.passed);
  const scopePassed =
    outsideAllowedFiles.length === 0 &&
    forbiddenFilesChanged.length === 0 &&
    generatedArtifactsChanged.length === 0;
  const passed = scopePassed && allCommandsPassed;

  const now = new Date().toISOString();
  const report: VerifyReport = {
    taskId,
    verifiedAt: now,
    status: passed ? "passed" : "failed",
    changedFiles,
    includeDependencies: includeDependencies || undefined,
    dependencyTaskIds: includeDependencies ? dependencyTaskIds : undefined,
    dependencyFilesChanged: includeDependencies ? dependencyOwnedFiles : undefined,
    commandsSkipped: scopeOnly || undefined,
    skipReason: scopeOnly ? "scope-only" : undefined,
    scopeCheck: {
      passed: scopePassed,
      outsideAllowedFiles,
      forbiddenFilesChanged,
      generatedArtifactsChanged,
    },
    commands: commandResults,
    summary: buildSummary(
      passed,
      scopeOnly,
      outsideAllowedFiles,
      forbiddenFilesChanged,
      generatedArtifactsChanged,
      commandResults,
    ),
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  task.status = passed ? "needs_review" : "test_failed";
  task.testLogPath = `${resolved.dataDirName}/tasks/${taskId}/test.log`;
  task.updatedAt = now;
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  if (passed) {
    const commandsPassedCount = commandResults.filter((result) => result.passed).length;
    const dependencyLines = includeDependencies && dependencyOwnedFiles.length > 0
      ? `\nDependency files allowed:\n${dependencyOwnedFiles.map((file) => `- ${file}`).join("\n")}\n`
      : "";
    if (scopeOnly) {
      return {
        ok: true,
        message: `Verification passed for ${taskId}.\n${dependencyLines ? `\n${dependencyLines}` : "\n"}Scope check passed.\nCommands skipped due to --scope-only.\n\nSee ${resolved.dataDirName}/tasks/${taskId}/verify-report.json`,
      };
    }
    if (dependencyLines) {
      return {
        ok: true,
        message: `Verification passed for ${taskId}.\n\n${dependencyLines}Changed files: ${changedFiles.length}\nCommands passed: ${commandsPassedCount}\n\nSee ${resolved.dataDirName}/tasks/${taskId}/verify-report.json`,
      };
    }
    return {
      ok: true,
      message: `Verification passed for ${taskId}.\nChanged files: ${changedFiles.length}\nCommands passed: ${commandsPassedCount}`,
    };
  }

  const lines = [`Verification failed for ${taskId}.`, ""];
  if (outsideAllowedFiles.length > 0) {
    lines.push("Out-of-scope files changed:");
    for (const file of outsideAllowedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  if (forbiddenFilesChanged.length > 0) {
    lines.push("Forbidden files changed:");
    for (const file of forbiddenFilesChanged) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  if (generatedArtifactsChanged.length > 0) {
    lines.push("Generated artifacts changed:");
    for (const file of generatedArtifactsChanged) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  if (scopeOnly) {
    lines.push("Commands skipped due to --scope-only.");
    lines.push("");
  }
  if (includeDependencies && dependencyOwnedFiles.length > 0) {
    lines.push("Dependency files allowed:");
    for (const file of dependencyOwnedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  lines.push(`See ${resolved.dataDirName}/tasks/${taskId}/verify-report.json`);
  return { ok: false, message: lines.join("\n") };
}

function runCommandsInWorktree(worktreePath: string, commands: string[], testLogPath: string): VerifyCommandResult[] {
  const outputChunks: string[] = [];
  const results: VerifyCommandResult[] = [];

  if (commands.length === 0) {
    outputChunks.push("[verify] No task commands configured.\n");
  }

  for (const command of commands) {
    outputChunks.push(`$ ${command}\n`);
    const result = spawn.sync(command, {
      cwd: worktreePath,
      shell: true,
      encoding: "utf-8",
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (stdout.length > 0) {
      outputChunks.push(stdout);
      if (!stdout.endsWith("\n")) {
        outputChunks.push("\n");
      }
    }
    if (stderr.length > 0) {
      outputChunks.push(stderr);
      if (!stderr.endsWith("\n")) {
        outputChunks.push("\n");
      }
    }

    const exitCode = result.status ?? 1;
    const passed = exitCode === 0;
    results.push({
      command,
      exitCode,
      passed,
    });
  }

  mkdirSync(dirname(testLogPath), { recursive: true });
  writeFileSync(testLogPath, outputChunks.join(""), "utf-8");
  return results;
}

function runGit(cwd: string, args: string): string {
  return execSync(`git -c safe.directory=* ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  return minimatch(normalizedFile, normalizedPattern, { dot: true });
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function buildSummary(
  passed: boolean,
  scopeOnly: boolean,
  outsideAllowedFiles: string[],
  forbiddenFilesChanged: string[],
  generatedArtifactsChanged: string[],
  commandResults: VerifyCommandResult[],
): string {
  if (passed) {
    if (scopeOnly) {
      return "Scope checks passed. Commands skipped due to --scope-only.";
    }
    return "Scope checks and command checks passed.";
  }

  const parts: string[] = [];
  if (outsideAllowedFiles.length > 0) {
    parts.push(`${outsideAllowedFiles.length} file(s) outside allowedFiles.`);
  }
  if (forbiddenFilesChanged.length > 0) {
    parts.push(`${forbiddenFilesChanged.length} file(s) matched forbiddenFiles.`);
  }
  if (generatedArtifactsChanged.length > 0) {
    parts.push(`${generatedArtifactsChanged.length} generated artifact file(s) changed.`);
  }
  const failedCommands = commandResults.filter((result) => !result.passed);
  if (failedCommands.length > 0) {
    parts.push(`${failedCommands.length} command(s) failed.`);
  }
  if (parts.length === 0) {
    return "Verification failed.";
  }
  return parts.join(" ");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isOwnedByTaskScope(filePath: string, task: Pick<TaskRecord, "allowedFiles" | "lockedFiles">): boolean {
  const matchesAllowed = task.allowedFiles.some((pattern) => matchesPattern(filePath, pattern));
  if (!matchesAllowed) {
    return false;
  }
  if (task.lockedFiles.length === 0) {
    return true;
  }
  return task.lockedFiles.some((pattern) => matchesPattern(filePath, pattern));
}

function loadDependencyTasks(gitRoot: string, dependencyIds: string[]): TaskRecord[] {
  const tasks: TaskRecord[] = [];
  for (const depId of dependencyIds) {
    if (typeof depId !== "string" || depId.trim().length === 0) {
      continue;
    }
    const depPath = dataPath(gitRoot, "tasks", depId, "task.json");
    if (!existsSync(depPath)) {
      continue;
    }
    try {
      const task = JSON.parse(readFileSync(depPath, "utf-8")) as TaskRecord;
      tasks.push(task);
    } catch {
      continue;
    }
  }
  return tasks;
}
