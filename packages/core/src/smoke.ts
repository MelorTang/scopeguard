import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFileLockService } from "./locks.js";
import { dataPath, resolveDataDir } from "./data-dir.js";
import { runDoctor } from "./doctor.js";
import { getNextTasks, getSchedule } from "./scheduler.js";

export type SmokeCheckStatus = "pass" | "fail";

export interface SmokeCheck {
  name: string;
  status: SmokeCheckStatus;
  message: string;
  details?: unknown;
}

export interface SmokeReport {
  checks: SmokeCheck[];
  summary: {
    passed: number;
    failed: number;
  };
}

export async function runSmoke(gitRootInput?: string): Promise<SmokeReport> {
  const checks: SmokeCheck[] = [];
  const gitRoot = resolveGitRoot(gitRootInput);
  if (!gitRoot) {
    checks.push({
      name: "git-root",
      status: "fail",
      message: "not inside a Git repository",
    });
    return withSummary(checks);
  }

  const resolvedDataDir = resolveDataDir(gitRoot);
  const hasDataDir = existsSync(resolvedDataDir.dataDir);

  checks.push(checkDoctor(gitRoot));
  checks.push(checkDataDirectory(gitRoot, resolvedDataDir.dataDirName, hasDataDir));
  checks.push(checkTasks(gitRoot, hasDataDir));
  checks.push(checkNext(gitRoot, hasDataDir));
  checks.push(checkSchedule(gitRoot, hasDataDir));
  checks.push(checkLocks(gitRoot, hasDataDir));
  checks.push(checkWorktrees(gitRoot));
  checks.push(checkAgentBranches(gitRoot));
  if (isScopeGuardSourceRepo(gitRoot)) {
    checks.push(checkScopeguardBin(gitRoot));
    checks.push(checkAgentboardBin(gitRoot));
  } else {
    checks.push({
      name: "cli-invocation",
      status: "pass",
      message: "cli invocation available (external repository mode)",
    });
  }

  return withSummary(checks);
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push("ScopeGuard Smoke Test");
  lines.push("");
  for (const check of report.checks) {
    const marker = check.status === "pass" ? "[PASS]" : "[FAIL]";
    lines.push(`${marker} ${check.message}`);
  }
  lines.push("");
  lines.push("Summary:");
  lines.push(`Passed: ${report.summary.passed}`);
  lines.push(`Failed: ${report.summary.failed}`);
  return lines.join("\n");
}

function withSummary(checks: SmokeCheck[]): SmokeReport {
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    if (check.status === "pass") {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return {
    checks,
    summary: { passed, failed },
  };
}

function checkDoctor(gitRoot: string): SmokeCheck {
  try {
    const report = runDoctor(gitRoot);
    if (report.summary.failed === 0) {
      if (report.summary.warnings > 0) {
        return {
          name: "doctor",
          status: "pass",
          message: `doctor passed with ${report.summary.warnings} warning(s)`,
          details: report.summary,
        };
      }
      return { name: "doctor", status: "pass", message: "doctor passed" };
    }
    return {
      name: "doctor",
      status: "fail",
      message: `doctor failed with ${report.summary.failed} failed check(s), ${report.summary.warnings} warning(s)`,
      details: report.summary,
    };
  } catch (error) {
    return {
      name: "doctor",
      status: "fail",
      message: `doctor check failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkDataDirectory(gitRoot: string, dataDirName: ".scopeguard" | ".agentboard", hasDataDir: boolean): SmokeCheck {
  try {
    if (!hasDataDir) {
      return {
        name: "data-directory",
        status: "fail",
        message: "data directory not found",
      };
    }
    return {
      name: "data-directory",
      status: "pass",
      message: `data directory readable: ${dataDirName}`,
    };
  } catch (error) {
    return {
      name: "data-directory",
      status: "fail",
      message: `data directory check failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkTasks(gitRoot: string, hasDataDir: boolean): SmokeCheck {
  try {
    if (!hasDataDir) {
      return { name: "tasks", status: "fail", message: "task store unavailable: data directory not found" };
    }
    const tasksRoot = dataPath(gitRoot, "tasks");
    let loaded = 0;
    if (existsSync(tasksRoot)) {
      for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const taskPath = join(tasksRoot, entry.name, "task.json");
        if (!existsSync(taskPath)) {
          continue;
        }
        try {
          JSON.parse(readFileSync(taskPath, "utf-8"));
          loaded += 1;
        } catch {
          return {
            name: "tasks",
            status: "fail",
            message: `task store read failed: invalid JSON in ${entry.name}/task.json`,
          };
        }
      }
    }
    return { name: "tasks", status: "pass", message: `loaded ${loaded} task(s)` };
  } catch (error) {
    return {
      name: "tasks",
      status: "fail",
      message: `task store read failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkNext(gitRoot: string, hasDataDir: boolean): SmokeCheck {
  try {
    if (!hasDataDir) {
      return { name: "next", status: "fail", message: "next unavailable: data directory not found" };
    }
    const result = getNextTasks(gitRoot);
    return {
      name: "next",
      status: "pass",
      message: `next computed ${result.safeToRun.length} safe task(s)`,
    };
  } catch (error) {
    return {
      name: "next",
      status: "fail",
      message: `next computation failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkSchedule(gitRoot: string, hasDataDir: boolean): SmokeCheck {
  try {
    if (!hasDataDir) {
      return { name: "schedule", status: "fail", message: "schedule unavailable: data directory not found" };
    }
    const result = getSchedule(gitRoot);
    return {
      name: "schedule",
      status: "pass",
      message: `schedule computed ${result.batches.length} batch(es)`,
    };
  } catch (error) {
    return {
      name: "schedule",
      status: "fail",
      message: `schedule computation failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkLocks(gitRoot: string, hasDataDir: boolean): SmokeCheck {
  try {
    if (!hasDataDir) {
      return { name: "locks", status: "fail", message: "locks unavailable: data directory not found" };
    }
    const active = createFileLockService(gitRoot).listLocks().filter((lock) => lock.status === "active").length;
    if (active > 0) {
      return {
        name: "locks",
        status: "fail",
        message: `${active} active lock(s) found`,
      };
    }
    return { name: "locks", status: "pass", message: "no active locks" };
  } catch (error) {
    return {
      name: "locks",
      status: "fail",
      message: `locks check failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkWorktrees(gitRoot: string): SmokeCheck {
  try {
    const res = runGit(gitRoot, ["worktree", "list", "--porcelain"]);
    if (res.status !== 0) {
      return { name: "worktrees", status: "fail", message: "failed to inspect git worktrees" };
    }

    const managed = res.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => normalizePath(line.slice("worktree ".length).trim()))
      .filter((path) => path.includes("/.scopeguard/worktrees/") || path.includes("/.agentboard/worktrees/"));

    if (managed.length > 0) {
      return {
        name: "worktrees",
        status: "fail",
        message: `${managed.length} ScopeGuard/AgentBoard worktree(s) found`,
        details: managed,
      };
    }

    return {
      name: "worktrees",
      status: "pass",
      message: "no ScopeGuard/AgentBoard worktrees",
    };
  } catch (error) {
    return {
      name: "worktrees",
      status: "fail",
      message: `worktree check failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkAgentBranches(gitRoot: string): SmokeCheck {
  try {
    const res = runGit(gitRoot, ["branch", "--list", "agent/*"]);
    if (res.status !== 0) {
      return { name: "agent-branches", status: "fail", message: "failed to inspect agent branches" };
    }
    const count = res.stdout
      .split(/\r?\n/)
      .map((line) => line.replace("*", "").trim())
      .filter((line) => line.length > 0).length;
    if (count > 0) {
      return { name: "agent-branches", status: "fail", message: `${count} agent/* branch(es) found` };
    }
    return { name: "agent-branches", status: "pass", message: "no agent/* branches" };
  } catch (error) {
    return {
      name: "agent-branches",
      status: "fail",
      message: `agent branch check failed: ${toErrorMessage(error)}`,
    };
  }
}

function checkScopeguardBin(gitRoot: string): SmokeCheck {
  const path = join(gitRoot, "apps", "cli", "bin", "scopeguard.js");
  if (existsSync(path)) {
    return { name: "scopeguard-bin", status: "pass", message: "scopeguard bin available" };
  }
  return { name: "scopeguard-bin", status: "fail", message: "scopeguard bin missing" };
}

function checkAgentboardBin(gitRoot: string): SmokeCheck {
  const path = join(gitRoot, "apps", "cli", "bin", "agentboard.js");
  if (existsSync(path)) {
    return { name: "agentboard-bin", status: "pass", message: "agentboard legacy bin available" };
  }
  return { name: "agentboard-bin", status: "fail", message: "agentboard legacy bin missing" };
}

function isScopeGuardSourceRepo(gitRoot: string): boolean {
  return existsSync(join(gitRoot, "apps", "cli", "bin", "scopeguard.js")) && existsSync(join(gitRoot, "packages", "core", "src", "smoke.ts"));
}

function resolveGitRoot(gitRootInput?: string): string | null {
  if (gitRootInput && gitRootInput.trim().length > 0) {
    return gitRootInput;
  }
  const res = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (res.status !== 0) {
    return null;
  }
  const value = res.stdout.trim();
  return value.length > 0 ? value : null;
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-c", "safe.directory=*", ...args], {
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

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
