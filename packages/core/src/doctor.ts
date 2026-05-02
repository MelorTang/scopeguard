import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getNextTasks, getSchedule } from "./scheduler.js";
import { dataPath, resolveDataDir } from "./data-dir.js";

type CheckStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

type DoctorSummary = {
  passed: number;
  warnings: number;
  failed: number;
};

export type DoctorReport = {
  checks: DoctorCheck[];
  summary: DoctorSummary;
};

type TaskRecord = {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  allowedFiles?: unknown;
  lockedFiles?: unknown;
};

const KNOWN_TASK_STATUSES = new Set([
  "backlog",
  "planned",
  "ready",
  "blocked",
  "in_progress",
  "needs_review",
  "test_failed",
  "conflict",
  "approved",
  "merged",
  "closed",
]);

export function runDoctor(gitRootInput?: string): DoctorReport {
  const checks: DoctorCheck[] = [];
  const rootResult = resolveGitRoot(gitRootInput);

  if (!rootResult.ok) {
    checks.push({
      name: "Git repository",
      status: "fail",
      message: "Not inside a Git repository",
    });
    const report = withSummary(checks);
    return report;
  }

  const gitRoot = rootResult.gitRoot;
  checks.push({
    name: "Git repository",
    status: "pass",
    message: "Git repository detected",
    details: { gitRoot: normalizePath(gitRoot) },
  });

  const resolved = resolveDataDir(gitRoot);
  const storageRoot = resolved.dataDir;
  const hasDataDir = existsSync(storageRoot);
  if (!hasDataDir) {
    checks.push({
      name: "Data directory",
      status: "fail",
      message: "Data directory not found. Run: scopeguard init (or agentboard init)",
    });
  } else {
    checks.push({
      name: "Data directory",
      status: "pass",
      message: `Data directory exists: ${resolved.dataDirName}${resolved.compatibilityMode ? " (legacy compatibility mode)" : ""}`,
    });
    if (resolved.compatibilityMode) {
      checks.push({
        name: "Data directory compatibility",
        status: "warn",
        message: "Using legacy .agentboard directory. Future versions may migrate to .scopeguard.",
      });
    }
  }

  const configPath = dataPath(gitRoot, "config.json");
  const legacyConfigPath = join(storageRoot, "agentboard.json");
  if (existsSync(configPath) || existsSync(legacyConfigPath)) {
    checks.push({
      name: "Config",
      status: "pass",
      message: "ScopeGuard config found",
    });
  } else {
    checks.push({
      name: "Config",
      status: "warn",
      message: "ScopeGuard config not found",
    });
  }

  checks.push(checkProjectMap(storageRoot));
  checks.push(...checkTasks(storageRoot));
  checks.push(checkLocks(storageRoot));
  if (hasDataDir) {
    checks.push(checkScheduler(gitRoot));
  } else {
    checks.push({
      name: "Scheduler",
      status: "warn",
      message: "Scheduler skipped: data directory is missing",
    });
  }
  checks.push(checkWorktrees(gitRoot));
  checks.push(checkAgentBranches(gitRoot));
  checks.push(checkPnpm(gitRoot));
  checks.push(checkCodexCli(gitRoot));
  checks.push(checkGitTrackedHygiene(gitRoot));
  checks.push(checkWorkingTreeDirty(gitRoot));

  return withSummary(checks);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("ScopeGuard Doctor");
  lines.push("");
  for (const check of report.checks) {
    const marker = check.status === "pass" ? "[PASS]" : check.status === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`${marker} ${check.message}`);
  }
  lines.push("");
  lines.push("Summary:");
  lines.push(`Passed: ${report.summary.passed}`);
  lines.push(`Warnings: ${report.summary.warnings}`);
  lines.push(`Failed: ${report.summary.failed}`);
  return lines.join("\n");
}

function withSummary(checks: DoctorCheck[]): DoctorReport {
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  for (const check of checks) {
    if (check.status === "pass") {
      passed += 1;
    } else if (check.status === "warn") {
      warnings += 1;
    } else {
      failed += 1;
    }
  }
  return {
    checks,
    summary: { passed, warnings, failed },
  };
}

function resolveGitRoot(gitRootInput?: string): { ok: true; gitRoot: string } | { ok: false } {
  if (gitRootInput && gitRootInput.trim().length > 0) {
    return { ok: true, gitRoot: gitRootInput };
  }
  const res = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (res.status !== 0) {
    return { ok: false };
  }
  const value = res.stdout.trim();
  if (value.length === 0) {
    return { ok: false };
  }
  return { ok: true, gitRoot: value };
}

function checkProjectMap(storageRoot: string): DoctorCheck {
  const mapPath = join(storageRoot, "project-map.json");
  if (!existsSync(mapPath)) {
    return {
      name: "Project map",
      status: "warn",
      message: "project-map.json not found. Run: scopeguard scan",
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(mapPath, "utf-8")) as {
      areas?: unknown;
      dependencyGraph?: unknown;
      summary?: unknown;
    };
    const areas = Array.isArray(parsed.areas) ? parsed.areas.length : 0;
    const graph = Array.isArray(parsed.dependencyGraph) ? parsed.dependencyGraph : [];
    const sourceFiles = countUniqueGraphNodes(graph);
    const missingFields: string[] = [];
    if (!Array.isArray(parsed.areas)) {
      missingFields.push("areas");
    }
    if (!Array.isArray(parsed.dependencyGraph)) {
      missingFields.push("dependencyGraph");
    }
    if (missingFields.length > 0) {
      return {
        name: "Project map",
        status: "warn",
        message: `project-map.json loaded with missing fields: ${missingFields.join(", ")}`,
      };
    }
    return {
      name: "Project map",
      status: "pass",
      message: `project-map.json loaded: ${areas} areas, ${sourceFiles} source files`,
      details: { summary: parsed.summary },
    };
  } catch {
    return {
      name: "Project map",
      status: "fail",
      message: "project-map.json is invalid JSON",
    };
  }
}

function countUniqueGraphNodes(graph: unknown[]): number {
  const files = new Set<string>();
  for (const edge of graph) {
    if (!edge || typeof edge !== "object") {
      continue;
    }
    const from = (edge as { from?: unknown }).from;
    const to = (edge as { to?: unknown }).to;
    if (typeof from === "string" && from.trim().length > 0) {
      files.add(from);
    }
    if (typeof to === "string" && to.trim().length > 0) {
      files.add(to);
    }
  }
  return files.size;
}

function checkTasks(storageRoot: string): DoctorCheck[] {
  const tasksRoot = join(storageRoot, "tasks");
  if (!existsSync(tasksRoot)) {
    return [{ name: "Tasks", status: "warn", message: "No tasks found" }];
  }

  const checks: DoctorCheck[] = [];
  const dirs = readdirSync(tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  let loaded = 0;

  for (const dir of dirs) {
    const taskFilePath = join(tasksRoot, dir.name, "task.json");
    if (!existsSync(taskFilePath)) {
      checks.push({
        name: "Task",
        status: "warn",
        message: `${dir.name} missing task.json`,
      });
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(taskFilePath, "utf-8")) as TaskRecord;
      loaded += 1;
      checks.push(...validateTaskRecord(dir.name, parsed));
    } catch {
      checks.push({
        name: "Task",
        status: "fail",
        message: `${dir.name}/task.json is invalid JSON`,
      });
    }
  }

  if (loaded === 0) {
    checks.unshift({ name: "Tasks", status: "warn", message: "No tasks found" });
  } else {
    checks.unshift({ name: "Tasks", status: "pass", message: `Loaded ${loaded} task(s)` });
  }

  return checks;
}

function validateTaskRecord(dirName: string, task: TaskRecord): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const id = typeof task.id === "string" ? task.id : dirName;

  if (typeof task.id !== "string" || task.id.length === 0) {
    checks.push({ name: "Task", status: "warn", message: `${dirName} task missing id` });
  } else if (task.id !== dirName) {
    checks.push({ name: "Task", status: "warn", message: `${task.id} id does not match directory name ${dirName}` });
  }

  if (typeof task.status !== "string" || task.status.length === 0) {
    checks.push({ name: "Task", status: "warn", message: `${id} missing status` });
  } else if (!KNOWN_TASK_STATUSES.has(task.status)) {
    checks.push({ name: "Task", status: "warn", message: `${id} has unknown status: ${task.status}` });
  }

  if (typeof task.title !== "string" || task.title.trim().length === 0) {
    checks.push({ name: "Task", status: "warn", message: `${id} missing title` });
  }
  if (!Array.isArray(task.allowedFiles)) {
    checks.push({ name: "Task", status: "warn", message: `${id} allowedFiles is not an array` });
  }
  if (!Array.isArray(task.lockedFiles)) {
    checks.push({ name: "Task", status: "warn", message: `${id} lockedFiles is not an array` });
  }
  return checks;
}

function checkLocks(storageRoot: string): DoctorCheck {
  const locksPath = join(storageRoot, "locks.json");
  if (!existsSync(locksPath)) {
    return {
      name: "Locks",
      status: "pass",
      message: "No locks file",
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(locksPath, "utf-8")) as {
      locks?: Array<{ status?: string }>;
    };
    const locks = Array.isArray(parsed.locks) ? parsed.locks : [];
    const activeCount = locks.filter((lock) => lock?.status === "active").length;
    if (activeCount > 0) {
      return {
        name: "Locks",
        status: "warn",
        message: `${activeCount} active lock(s) found`,
      };
    }
    return {
      name: "Locks",
      status: "pass",
      message: "No active locks",
    };
  } catch {
    return {
      name: "Locks",
      status: "fail",
      message: "locks.json is invalid JSON",
    };
  }
}

function checkScheduler(gitRoot: string): DoctorCheck {
  try {
    const next = getNextTasks(gitRoot);
    const schedule = getSchedule(gitRoot);
    return {
      name: "Scheduler",
      status: "pass",
      message: `Scheduler computed ${next.safeToRun.length} safe task(s), ${schedule.batches.length} batch(es)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scheduler error";
    return {
      name: "Scheduler",
      status: "fail",
      message: `Scheduler failed: ${message}`,
    };
  }
}

function checkWorktrees(gitRoot: string): DoctorCheck {
  const res = runGit(gitRoot, ["worktree", "list", "--porcelain"]);
  if (res.status !== 0) {
    return {
      name: "Worktrees",
      status: "fail",
      message: "Failed to inspect git worktrees",
    };
  }
  const lines = res.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree "));
  const count = lines
    .map((line) => line.slice("worktree ".length).trim())
    .map((path) => normalizePath(path))
    .filter((path) => path.includes("/.agentboard/worktrees/")).length;
  if (count > 0) {
    return {
      name: "Worktrees",
      status: "warn",
      message: `${count} AgentBoard worktree(s) found`,
    };
  }
  return {
    name: "Worktrees",
    status: "pass",
    message: "No ScopeGuard/AgentBoard worktrees",
  };
}

function checkAgentBranches(gitRoot: string): DoctorCheck {
  const res = runGit(gitRoot, ["branch", "--list", "agent/*"]);
  if (res.status !== 0) {
    return {
      name: "Agent branches",
      status: "fail",
      message: "Failed to inspect agent branches",
    };
  }

  const count = res.stdout
    .split(/\r?\n/)
    .map((line) => line.replace("*", "").trim())
    .filter((line) => line.length > 0).length;
  if (count > 0) {
    return {
      name: "Agent branches",
      status: "warn",
      message: `${count} agent branch(es) found`,
    };
  }
  return {
    name: "Agent branches",
    status: "pass",
    message: "No agent/* branches",
  };
}

function checkPnpm(gitRoot: string): DoctorCheck {
  const commands = process.platform === "win32" ? ["pnpm", "pnpm.cmd"] : ["pnpm"];
  for (const command of commands) {
    const res = runCommand(gitRoot, command, ["--version"]);
    if (res.status === 0) {
      const version = res.stdout.trim();
      return {
        name: "pnpm",
        status: "pass",
        message: `pnpm available: ${version.length > 0 ? version : "unknown version"}`,
      };
    }
  }
  if (process.platform === "win32") {
    const viaCmd = runCommand(gitRoot, "cmd.exe", ["/d", "/s", "/c", "pnpm --version"]);
    if (viaCmd.status === 0) {
      const version = viaCmd.stdout.trim();
      return {
        name: "pnpm",
        status: "pass",
        message: `pnpm available: ${version.length > 0 ? version : "unknown version"}`,
      };
    }
  }
  return { name: "pnpm", status: "fail", message: "pnpm not found" };
}

function checkCodexCli(gitRoot: string): DoctorCheck {
  const codexBin = process.env.CODEX_BIN;
  let codexBinError: string | null = null;
  if (typeof codexBin === "string" && codexBin.trim().length > 0) {
    const codexBinPath = codexBin.trim();
    if (!existsSync(codexBinPath)) {
      codexBinError = "file does not exist";
    } else {
      const version = runCodexFromExplicitPath(gitRoot, codexBinPath);
      if (version.status === 0) {
        return {
          name: "Codex CLI",
          status: "pass",
          message: `Codex CLI available: ${firstLine(version.stdout)}`,
          details: {
            source: "CODEX_BIN",
            path: codexBinPath,
          },
        };
      }
      codexBinError = firstLine(version.stderr) || `exit code ${String(version.status ?? "unknown")}`;
    }
  }

  const commands = process.platform === "win32" ? ["codex", "codex.cmd", "codex.ps1"] : ["codex"];
  for (const command of commands) {
    const version = runCodexFromCommand(gitRoot, command);
    if (version.status === 0) {
      return {
        name: "Codex CLI",
        status: "pass",
        message: `Codex CLI available: ${firstLine(version.stdout)}`,
        details: {
          source: "PATH",
          command,
        },
      };
    }
  }

  if (typeof codexBin === "string" && codexBin.trim().length > 0) {
    return {
      name: "Codex CLI",
      status: "warn",
      message: `CODEX_BIN is set but failed to execute: ${codexBin.trim()}`,
      details: {
        source: "CODEX_BIN",
        path: codexBin.trim(),
        error: codexBinError ?? "unknown error",
      },
    };
  }

  return {
    name: "Codex CLI",
    status: "warn",
    message: "Codex CLI not found. Run tasks manually or install Codex CLI.",
  };
}

function checkGitTrackedHygiene(gitRoot: string): DoctorCheck {
  const res = runGit(gitRoot, ["ls-files"]);
  if (res.status !== 0) {
    return {
      name: "Git tracking hygiene",
      status: "fail",
      message: "Failed to inspect tracked files",
    };
  }

  const lines = res.stdout
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);

  const trackedGeneratedOrDeps = lines.filter((line) => {
    const hasNodeModules = line === "node_modules" || line.startsWith("node_modules/") || line.includes("/node_modules/");
    const hasDist = line === "dist" || line.startsWith("dist/") || line.includes("/dist/");
    return hasNodeModules || hasDist;
  });

  if (trackedGeneratedOrDeps.length > 0) {
    return {
      name: "Git tracking hygiene",
      status: "warn",
      message: `Tracked generated/dependency files found: ${trackedGeneratedOrDeps.length} file(s)`,
    };
  }

  return {
    name: "Git tracking hygiene",
    status: "pass",
    message: "No tracked node_modules/dist files",
  };
}

function checkWorkingTreeDirty(gitRoot: string): DoctorCheck {
  const res = runGit(gitRoot, ["status", "--porcelain"]);
  if (res.status !== 0) {
    return {
      name: "Working tree",
      status: "fail",
      message: "Failed to inspect git status",
    };
  }

  const paths = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalizeStatusPath(line));

  if (paths.length === 0) {
    return {
      name: "Working tree",
      status: "pass",
      message: "Working tree clean",
    };
  }

  const nonAgentboard = paths.filter((path) => !path.startsWith(".agentboard/"));
  if (nonAgentboard.length > 0) {
    return {
      name: "Working tree",
      status: "warn",
      message: `Working tree has user changes: ${nonAgentboard.length} file(s)`,
    };
  }

  return {
    name: "Working tree",
    status: "warn",
    message: `Working tree has AgentBoard metadata changes: ${paths.length} file(s)`,
  };
}

function normalizeStatusPath(line: string): string {
  const payload = line.length > 3 ? line.slice(3) : line;
  const arrowIdx = payload.indexOf("->");
  const raw = arrowIdx >= 0 ? payload.slice(arrowIdx + 2) : payload;
  return normalizePath(raw.trim());
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "unknown";
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return runCommand(cwd, "git", ["-c", "safe.directory=*", ...args]);
}

function runCommand(cwd: string, command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runCodexFromExplicitPath(
  cwd: string,
  codexBinPath: string,
): { status: number | null; stdout: string; stderr: string } {
  const normalized = codexBinPath.toLowerCase();
  if (process.platform === "win32" && normalized.endsWith(".ps1")) {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", codexBinPath, "--version"],
      {
        cwd,
        encoding: "utf-8",
        windowsHide: true,
        shell: false,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  if (process.platform === "win32" && (normalized.endsWith(".cmd") || normalized.endsWith(".bat"))) {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", codexBinPath, "--version"], {
      cwd,
      encoding: "utf-8",
      windowsHide: true,
      shell: false,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  return runCommand(cwd, codexBinPath, ["--version"]);
}

function runCodexFromCommand(
  cwd: string,
  command: string,
): { status: number | null; stdout: string; stderr: string } {
  if (process.platform === "win32") {
    const normalized = command.toLowerCase();
    if (normalized.endsWith(".ps1")) {
      return runCommand(cwd, "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${command} --version`]);
    }
    const direct = runCommand(cwd, command, ["--version"]);
    if (direct.status === 0) {
      return direct;
    }
    const viaCmd = runCommand(cwd, "cmd.exe", ["/d", "/s", "/c", `${command} --version`]);
    if (viaCmd.status === 0) {
      return viaCmd;
    }
    const viaPowerShell = runCommand(cwd, "powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `${command} --version`,
    ]);
    if (viaPowerShell.status === 0) {
      return viaPowerShell;
    }
    return {
      status: direct.status,
      stdout: `${direct.stdout}${viaCmd.stdout}${viaPowerShell.stdout}`,
      stderr: `${direct.stderr}${viaCmd.stderr}${viaPowerShell.stderr}`,
    };
  }

  return runCommand(cwd, command, ["--version"]);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
