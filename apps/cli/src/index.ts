import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { runTaskWithCodex } from "@scopeguard/codex-runner";
import {
  closeTask,
  createFileLockService,
  discardTask,
  fixScopeTask,
  formatMigrationResult,
  formatDoctorReport,
  formatSmokeReport,
  generateReviewReport,
  getNextTasks,
  getSchedule,
  migrateDataDir,
  reopenTask,
  runDoctor,
  runSmoke,
  resolveDataDir,
  verifyTask,
} from "@scopeguard/core";
import { buildProjectMap } from "@scopeguard/repo-analyzer";
import { startBoardServer } from "@scopeguard/server";
import { runTuiBoard } from "./tui.js";

const REQUIRED_DIRS = ["tasks", "logs", "worktrees", "requirements"] as const;
const DEFAULT_GENERATED_FORBIDDEN_PATTERNS = [
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.map",
  "**/*.tsbuildinfo",
] as const;

type AgentBoardConfig = {
  projectId: string;
  projectName: string;
  rootPath: string;
  defaultBranch: string;
  createdAt: string;
};

type AgentBoardLocks = {
  locks: [];
};

type ProjectMap = {
  projectId: string;
  generatedAt: string;
  rootPath: string;
  summary: string;
  stack: {
    languages: string[];
    frameworks: string[];
    packageManager: string;
  };
  areas: Array<{
    id: string;
    name: string;
    paths: string[];
    summary: string;
    dependencies: string[];
    relatedTests: string[];
    riskLevel: "low" | "medium" | "high";
  }>;
  dependencyGraph: Array<{
    from: string;
    to: string;
    type: "import" | "require" | "dynamic" | "unknown";
  }>;
};

type PlanInput = {
  projectId: string;
  requirementId: string;
  summary: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    agentType: string;
    allowedFiles: string[];
    lockedFiles: string[];
    forbiddenFiles: string[];
    dependencies: string[];
    acceptanceCriteria: string[];
    commands: string[];
    riskLevel: "low" | "medium" | "high";
  }>;
};

type PlanValidationResult = {
  errors: string[];
  warnings: string[];
};

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
  commands: Array<{
    command: string;
    exitCode: number;
    passed: boolean;
  }>;
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

type VerifyScopeTargets = {
  outsideAllowedFiles: string[];
  forbiddenFilesChanged: string[];
  generatedArtifactsChanged: string[];
  filesToRevert: string[];
};

type CleanupResult = {
  ok: boolean;
  message: string;
  removed?: boolean;
};

export function runCli(rawArgs: string[]): void {
  const args = normalizeArgs(rawArgs);
  const command = args[0];
  const showHelp = args.includes("--help") || args.includes("-h") || args.length === 0;

  if (showHelp) {
    printHelp();
    return;
  }

  if (command === "init") {
    runInit(args.slice(1));
    return;
  }

  if (command === "migrate") {
    runMigrate(args.slice(1));
    return;
  }

  if (command === "scan") {
    runScan();
    return;
  }

  if (command === "plan") {
    runPlan(args.slice(1));
    return;
  }

  if (command === "import-plan") {
    runImportPlan(args.slice(1));
    return;
  }

  if (command === "validate-plan") {
    runValidatePlan(args.slice(1));
    return;
  }

  if (command === "tasks") {
    runTasks();
    return;
  }

  if (command === "next") {
    runNext(args.slice(1));
    return;
  }

  if (command === "schedule") {
    runSchedule(args.slice(1));
    return;
  }

  if (command === "doctor") {
    runDoctorCommand(args.slice(1));
    return;
  }

  if (command === "smoke") {
    void runSmokeCommand(args.slice(1));
    return;
  }

  if (command === "board") {
    void runBoard(args.slice(1));
    return;
  }

  if (command === "tui") {
    runTui();
    return;
  }

  if (command === "run") {
    runTaskCommand(args.slice(1));
    return;
  }

  if (command === "verify") {
    runVerify(args.slice(1));
    return;
  }

  if (command === "review") {
    runReview(args.slice(1));
    return;
  }

  if (command === "approve") {
    runApprove(args.slice(1));
    return;
  }

  if (command === "merge") {
    runMerge(args.slice(1));
    return;
  }

  if (command === "fix-scope") {
    runFixScope(args.slice(1));
    return;
  }

  if (command === "locks") {
    runLocks();
    return;
  }

  if (command === "unlock") {
    runUnlock(args.slice(1));
    return;
  }

  if (command === "discard") {
    runDiscard(args.slice(1));
    return;
  }

  if (command === "close") {
    runClose(args.slice(1));
    return;
  }

  if (command === "reopen") {
    runReopen(args.slice(1));
    return;
  }

  console.log("Unknown command. Run `scopeguard --help` (or `agentboard --help`) for usage.");
  process.exitCode = 1;
}

function normalizeArgs(args: string[]): string[] {
  if (args[0] === "--") {
    return args.slice(1);
  }

  return args;
}

function printHelp(): void {
  console.log(`ScopeGuard CLI\n\nUsage:\n  scopeguard <command> [options]\n  agentboard <command> [options] (legacy alias)\n\nCommands:\n  init          Initialize ScopeGuard in the current repository\n  migrate       Migrate legacy .agentboard data to .scopeguard\n  scan          Scan repository and generate project map\n  plan          Generate planner prompt from requirement markdown\n  validate-plan Validate planner JSON structure and safety rules\n  import-plan   Import planner JSON into task files\n  tasks         List imported tasks\n  next          Show safe-to-run tasks and blocked reasons\n  schedule      Build parallel-safe batches from ready tasks\n  doctor        Run environment and repository health checks\n  smoke         Run read-only MVP smoke checks\n  board         Start local ScopeGuard web board\n  tui           Open terminal board (read-only prototype)\n  run           Run one task in isolated Codex worktree\n  verify        Verify a task worktree, scope, and commands\n  review        Generate human review report for a task\n  approve       Mark a task as approved after successful verification\n  merge         Merge an approved task branch, or continue conflict resolution\n  fix-scope     Revert out-of-scope changes in a task worktree\n  close         Close a task and remove it from scheduling\n  reopen        Reopen a closed task back to ready\n  locks         List active file locks\n  unlock        Release active file locks for a task\n  discard       Discard task run artifacts/worktree/branch and reset task\n\nOptions:\n  -h, --help    Show help`);
}

function runInit(args: string[]): void {
  const force = args.includes("--force");
  const gitRoot = getGitRoot();
  const existing = resolveDataDir(gitRoot);
  const storageRoot = existing.dataDirName === ".agentboard" && existing.compatibilityMode
    ? existing.dataDir
    : join(gitRoot, ".scopeguard");
  const configPath = join(storageRoot, "config.json");
  const locksPath = join(storageRoot, "locks.json");
  const hasConfig = existsSync(configPath);

  mkdirSync(storageRoot, { recursive: true });

  for (const dirName of REQUIRED_DIRS) {
    mkdirSync(join(storageRoot, dirName), { recursive: true });
  }

  if (!hasConfig || force) {
    const config: AgentBoardConfig = {
      projectId: randomUUID(),
      projectName: basename(gitRoot),
      rootPath: normalizePath(gitRoot),
      defaultBranch: getDefaultBranch(gitRoot),
      createdAt: new Date().toISOString(),
    };

    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  if (!existsSync(locksPath)) {
    const locks: AgentBoardLocks = { locks: [] };
    writeFileSync(locksPath, `${JSON.stringify(locks, null, 2)}\n`, "utf-8");
  }

  if (hasConfig && !force) {
    console.log(`ScopeGuard already initialized at ${storageRoot}. Use --force to regenerate config.json.`);
    if (existing.compatibilityMode) {
      console.log("Using legacy .agentboard directory for compatibility.");
    }
    return;
  }

  if (force) {
    console.log(`ScopeGuard re-initialized at ${storageRoot}`);
    if (existing.compatibilityMode) {
      console.log("Using legacy .agentboard directory for compatibility.");
    }
    return;
  }

  console.log(`ScopeGuard initialized at ${storageRoot}`);
  if (existing.compatibilityMode) {
    console.log("Using legacy .agentboard directory for compatibility.");
  }
}

function runMigrate(args: string[]): void {
  const gitRoot = getGitRoot();
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const move = args.includes("--move");

  const result = migrateDataDir(gitRoot, { dryRun, force, move });
  console.log(formatMigrationResult(result));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function runScan(): void {
  const gitRoot = getGitRoot();

  try {
    const projectMap = buildProjectMap(gitRoot, getDataDirName(gitRoot));
    console.log(`Project map generated at ${joinDataDir(gitRoot, "project-map.json")}`);
    console.log(projectMap.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scan error";
    console.log(message);
    process.exitCode = 1;
  }
}

function runPlan(args: string[]): void {
  const requirementArg = args.find((arg) => !arg.startsWith("-"));
  if (!requirementArg) {
    console.log("Usage: scopeguard plan <requirement.md>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const config = loadPlannerConfig(gitRoot);
  const projectMap = loadProjectMap(gitRoot);
  const requirementPath = resolve(gitRoot, requirementArg);

  if (!existsSync(requirementPath)) {
    console.log(`Requirement file not found: ${requirementArg}`);
    process.exitCode = 1;
    return;
  }

  const requirementText = readFileSync(requirementPath, "utf-8");
  const requirementId = generateRequirementId();
  const plansDir = joinDataDir(gitRoot, "plans");
  const timestamp = formatDiscardTimestamp(new Date());
  const plannerPromptPath = join(plansDir, `${timestamp}-planner-prompt.md`);

  mkdirSync(plansDir, { recursive: true });

  const plannerPrompt = buildPlannerPrompt(projectMap, requirementText, {
    projectId: config.projectId,
    requirementId,
  });
  writeFileSync(plannerPromptPath, plannerPrompt, "utf-8");

  console.log("Planner prompt generated:");
  console.log(normalizePath(plannerPromptPath));
  console.log("");
  console.log("Next:");
  console.log("Paste this prompt into Codex / Claude / Gemini and save the returned JSON as plan.json.");
  console.log("Then run:");
  console.log("scopeguard validate-plan plan.json");
  console.log("scopeguard import-plan plan.json");
}

function runImportPlan(args: string[]): void {
  const planArg = args.find((arg) => !arg.startsWith("-"));
  if (!planArg) {
    console.log("Usage: scopeguard import-plan <plan.json>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const planPath = resolve(gitRoot, planArg);

  if (!existsSync(planPath)) {
    console.log(`Plan file not found: ${planArg}`);
    process.exitCode = 1;
    return;
  }

  const raw = readFileSync(planPath, "utf-8");
  const parsed = parsePlanJson(raw);
  if (!parsed) {
    console.log("Invalid plan JSON.");
    process.exitCode = 1;
    return;
  }
  const validation = validatePlan(parsed);
  if (validation.errors.length > 0) {
    printValidationResult("failed", validation);
    process.exitCode = 1;
    return;
  }
  if (validation.warnings.length > 0) {
    printValidationResult("passed", validation);
    console.log("");
  }

  let written = 0;
  let skipped = 0;

  for (const task of parsed.tasks) {
    const taskDir = joinDataDir(gitRoot, "tasks", task.id);
    const taskFilePath = join(taskDir, "task.json");

    if (existsSync(taskFilePath)) {
      skipped += 1;
      continue;
    }

    mkdirSync(taskDir, { recursive: true });

    const now = new Date().toISOString();
    const taskRecord: TaskRecord = {
      id: task.id,
      projectId: parsed.projectId,
      requirementId: parsed.requirementId,
      title: task.title,
      description: task.description,
      status: "ready",
      agentType: task.agentType,
      allowedFiles: task.allowedFiles,
      lockedFiles: task.lockedFiles,
      forbiddenFiles: task.forbiddenFiles,
      dependencies: task.dependencies,
      acceptanceCriteria: task.acceptanceCriteria,
      commands: task.commands,
      riskLevel: task.riskLevel,
      branchName: null,
      worktreePath: null,
      diffPath: null,
      testLogPath: null,
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(taskFilePath, `${JSON.stringify(taskRecord, null, 2)}\n`, "utf-8");
    written += 1;
  }

  console.log(`Imported ${written} task(s), skipped ${skipped} existing task(s)`);
}

function runValidatePlan(args: string[]): void {
  const planArg = args.find((arg) => !arg.startsWith("-"));
  if (!planArg) {
    console.log("Usage: scopeguard validate-plan <plan.json>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const planPath = resolve(gitRoot, planArg);
  if (!existsSync(planPath)) {
    console.log(`Plan file not found: ${planArg}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parsePlanJson(readFileSync(planPath, "utf-8"));
  if (!parsed) {
    console.log("Plan validation failed.");
    console.log("");
    console.log("Errors:");
    console.log("- Invalid JSON.");
    process.exitCode = 1;
    return;
  }

  const validation = validatePlan(parsed);
  if (validation.errors.length > 0) {
    printValidationResult("failed", validation);
    process.exitCode = 1;
    return;
  }

  printValidationResult("passed", validation, parsed.tasks.length);
}

function runTasks(): void {
  const gitRoot = getGitRoot();
  const tasksRoot = joinDataDir(gitRoot, "tasks");

  if (!existsSync(tasksRoot)) {
    console.log("No tasks found. Run `scopeguard import-plan <plan.json>` first.");
    return;
  }

  const entries = readdirSync(tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const rows: Array<{ id: string; status: string; agent: string; risk: string; title: string }> = [];

  for (const entry of entries) {
    const taskPath = join(tasksRoot, entry.name, "task.json");
    if (!existsSync(taskPath)) {
      continue;
    }

    try {
      const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
      rows.push({
        id: task.id,
        status: task.status,
        agent: task.agentType,
        risk: task.riskLevel,
        title: task.title,
      });
    } catch {
      continue;
    }
  }

  if (rows.length === 0) {
    console.log("No tasks found. Run `scopeguard import-plan <plan.json>` first.");
    return;
  }

  console.log("ID       Status      Agent       Risk      Title");
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`${pad(row.id, 8)} ${pad(row.status, 11)} ${pad(row.agent, 11)} ${pad(row.risk, 9)} ${row.title}`);
  }
}

function runNext(args: string[]): void {
  const gitRoot = getGitRoot();
  const asJson = args.includes("--json");
  const result = getNextTasks(gitRoot);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Safe to run now:");
  if (result.safeToRun.length === 0) {
    console.log("- (none)");
  } else {
    for (const task of result.safeToRun) {
      console.log(`- ${task.id} [${task.agentType}] ${task.title}`);
    }
  }

  console.log("");
  console.log("Blocked:");
  if (result.blocked.length === 0) {
    console.log("- (none)");
  } else {
    for (const task of result.blocked) {
      if (task.reasons.length === 0) {
        console.log(`- ${task.id} ${task.title}`);
        continue;
      }
      for (const reason of task.reasons) {
        console.log(`- ${task.id} ${reason}`);
      }
    }
  }

  console.log("");
  console.log("Not scheduled:");
  if (result.notScheduled.length === 0) {
    console.log("- (none)");
  } else {
    for (const task of result.notScheduled) {
      console.log(`- ${task.id} status: ${task.status}`);
    }
  }
}

function runSchedule(args: string[]): void {
  const gitRoot = getGitRoot();
  const asJson = args.includes("--json");
  const result = getSchedule(gitRoot);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.batches.length === 0) {
    console.log("No runnable ready tasks.");
  } else {
    for (let i = 0; i < result.batches.length; i += 1) {
      const batch = result.batches[i] ?? [];
      console.log(`Batch ${i + 1}:`);
      for (const task of batch) {
        console.log(`- ${task.id} [${task.agentType}] ${task.title}`);
      }
      console.log("");
    }
  }

  console.log("Blocked:");
  if (result.blocked.length === 0) {
    console.log("- (none)");
  } else {
    for (const task of result.blocked) {
      for (const reason of task.reasons) {
        console.log(`- ${task.id} ${reason}`);
      }
    }
  }
}

function runDoctorCommand(args: string[]): void {
  const gitRoot = getGitRoot();
  const asJson = args.includes("--json");
  const report = runDoctor(gitRoot);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }
  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

async function runSmokeCommand(args: string[]): Promise<void> {
  const gitRoot = getGitRoot();
  const asJson = args.includes("--json");
  const report = await runSmoke(gitRoot);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSmokeReport(report));
  }
  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

async function runBoard(args: string[]): Promise<void> {
  const gitRoot = getGitRoot();
  const port = parseBoardPort(args);

  try {
    const board = await startBoardServer(gitRoot, port);
    console.log(`ScopeGuard running at http://localhost:${port}`);
    await waitForBoardShutdown(board);
  } catch (error) {
    if (error instanceof Error && error.message.includes("EADDRINUSE")) {
      console.log("ScopeGuard board may already be running at:");
      console.log(`http://127.0.0.1:${port}`);
      console.log("");
      console.log("If you want to restart it, stop the existing process first.");
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to start board server.";
    console.log(message);
    process.exitCode = 1;
  }
}

function waitForBoardShutdown(board: { close: () => Promise<void> }): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const close = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      void board.close().finally(resolve);
    };

    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function runTui(): void {
  const gitRoot = getGitRoot();
  runTuiBoard(gitRoot);
}

function parseBoardPort(args: string[]): number {
  const defaultPort = 3737;
  const flagIndex = args.indexOf("--port");
  if (flagIndex === -1) {
    return defaultPort;
  }

  const value = args[flagIndex + 1];
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    console.log("Invalid --port value. Use a number between 1 and 65535.");
    process.exitCode = 1;
    process.exit();
  }

  return parsed;
}

function runTaskCommand(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard run <task-id> --runner codex");
    process.exitCode = 1;
    return;
  }

  const runnerIndex = args.indexOf("--runner");
  const runner = runnerIndex >= 0 ? args[runnerIndex + 1] : undefined;

  if (!runner) {
    console.log("Usage: scopeguard run <task-id> --runner codex");
    process.exitCode = 1;
    return;
  }

  if (runner !== "codex") {
    console.log(`Runner "${runner}" is not supported yet.`);
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const result = runTaskWithCodex(gitRoot, taskId);
  console.log(result.message);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function runVerify(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard verify <task-id> [--working-tree] [--include-dependencies] [--scope-only]");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const useWorkingTree = args.includes("--working-tree");
  const scopeOnly = args.includes("--scope-only");
  const includeDependencies = args.includes("--include-dependencies");
  const result = verifyTask(gitRoot, taskId, { workingTree: useWorkingTree, scopeOnly, includeDependencies });
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function runLocks(): void {
  const gitRoot = getGitRoot();
  const lockService = createFileLockService(gitRoot);
  const activeLocks = lockService.listLocks().filter((lock) => lock.status === "active");

  if (activeLocks.length === 0) {
    console.log("No active locks.");
    return;
  }

  console.log("Task     Pattern            Status");
  for (const lock of activeLocks) {
    console.log(`${pad(lock.taskId, 8)} ${pad(lock.pattern, 18)} ${lock.status}`);
  }
}

function runUnlock(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard unlock <task-id>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const lockService = createFileLockService(gitRoot);
  const releasedCount = lockService.releaseLocks(taskId);
  console.log(`Released ${releasedCount} lock(s) for task ${taskId}`);
}

function runDiscard(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard discard <task-id> [--to ready|backlog] [--keep-branch] [--keep-worktree]");
    process.exitCode = 1;
    return;
  }

  const keepBranch = args.includes("--keep-branch");
  const keepWorktree = args.includes("--keep-worktree");
  const toStatus = parseDiscardToStatus(args);
  if (!toStatus) {
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const result = discardTask(gitRoot, taskId, { toStatus, keepBranch, keepWorktree });
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function runClose(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard close <task-id> [--reason <reason>]");
    process.exitCode = 1;
    return;
  }

  const reasonIndex = args.indexOf("--reason");
  const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : "manual";
  const gitRoot = getGitRoot();
  const result = closeTask(gitRoot, taskId, reason);
  if (!result.ok) {
    console.log(result.message);
    process.exitCode = 1;
    return;
  }

  console.log(result.message);
  if (result.message.includes("already closed")) {
    return;
  }
  console.log("");
  console.log("Reason:");
  console.log((reason && reason.trim().length > 0 ? reason.trim() : "manual"));
  if (result.warning) {
    console.log("");
    console.log(result.warning);
  }
}

function runReopen(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard reopen <task-id>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const result = reopenTask(gitRoot, taskId);
  if (!result.ok) {
    console.log(result.message);
    process.exitCode = 1;
    return;
  }

  console.log(result.message);
  console.log("");
  console.log("Status:");
  console.log("ready");
}

function runReview(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard review <task-id> [--output <path>] [--working-tree]");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const outputPath = parseReviewOutputPath(gitRoot, taskId, args);
  if (!outputPath) {
    process.exitCode = 1;
    return;
  }
  const useWorkingTree = args.includes("--working-tree");
  const result = generateReviewReport(gitRoot, taskId, outputPath, { workingTree: useWorkingTree });
  if (!result.ok) {
    console.log(result.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Review report generated for ${taskId}:`);
  console.log(result.reviewPath);
  console.log("");
  console.log("Recommendation:");
  console.log(result.recommendation);
}

function runApprove(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard approve <task-id>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const taskDir = joinDataDir(gitRoot, "tasks", taskId);
  const taskPath = join(taskDir, "task.json");
  const verifyReportPath = join(taskDir, "verify-report.json");
  const reviewPath = join(taskDir, "review.md");

  if (!existsSync(taskPath)) {
    console.log(`Task ${taskId} not found.`);
    process.exitCode = 1;
    return;
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  if (task.status !== "needs_review") {
    console.log(`Task ${taskId} cannot be approved.`);
    console.log(`Reason: task status is ${task.status}.`);
    console.log(`Run: scopeguard verify ${taskId}`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(verifyReportPath)) {
    console.log(`Task ${taskId} cannot be approved.`);
    console.log("Reason: verification has not passed.");
    console.log(`Run: scopeguard verify ${taskId}`);
    process.exitCode = 1;
    return;
  }

  const verifyReport = JSON.parse(readFileSync(verifyReportPath, "utf-8")) as VerifyReport;
  if (verifyReport.status !== "passed") {
    console.log(`Task ${taskId} cannot be approved.`);
    console.log("Reason: verification has not passed.");
    console.log(`Run: scopeguard verify ${taskId}`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(reviewPath)) {
    console.log(`Task ${taskId} cannot be approved.`);
    console.log("Reason: review report is missing.");
    console.log(`Run: scopeguard review ${taskId}`);
    process.exitCode = 1;
    return;
  }

  task.status = "approved";
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  console.log(`Task ${taskId} approved.`);
  console.log("Next:");
  console.log(`scopeguard merge ${taskId}`);
}

function runMerge(args: string[]): void {
  const continueMode = args.includes("--continue");
  if (continueMode) {
    runMergeContinue(args);
    return;
  }

  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard merge <task-id> [--keep-worktree] [--keep-branch]");
    console.log("   or: scopeguard merge --continue <task-id>");
    process.exitCode = 1;
    return;
  }

  const keepWorktree = args.includes("--keep-worktree");
  const keepBranch = args.includes("--keep-branch");

  const gitRoot = getGitRoot();
  const taskDir = joinDataDir(gitRoot, "tasks", taskId);
  const taskPath = join(taskDir, "task.json");
  const verifyReportPath = join(taskDir, "verify-report.json");

  if (!existsSync(taskPath)) {
    console.log(`Task ${taskId} not found.`);
    process.exitCode = 1;
    return;
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  if (task.status !== "approved") {
    console.log(`Task ${taskId} is not approved and cannot be merged.`);
    process.exitCode = 1;
    return;
  }

  if (!task.branchName || !task.worktreePath) {
    console.log(`Task ${taskId} is missing branchName/worktreePath and cannot be merged.`);
    process.exitCode = 1;
    return;
  }

  const worktreeAbsPath = join(gitRoot, task.worktreePath);
  if (!existsSync(worktreeAbsPath)) {
    console.log(`Task worktree does not exist: ${task.worktreePath}`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(verifyReportPath)) {
    console.log(`Task ${taskId} cannot be merged because verification report is missing.`);
    process.exitCode = 1;
    return;
  }

  const verifyReport = JSON.parse(readFileSync(verifyReportPath, "utf-8")) as VerifyReport;
  if (verifyReport.status !== "passed") {
    console.log(`Task ${taskId} cannot be merged because verification has not passed.`);
    process.exitCode = 1;
    return;
  }

  const statusResult = runGitArgs(gitRoot, ["status", "--porcelain"]);
  if (statusResult.status !== 0) {
    console.log("Failed to check main working tree status.");
    process.exitCode = 1;
    return;
  }
  const dirtyPaths = parseGitPorcelainPaths(statusResult.stdout);
  const dataDirPrefix = `${getDataDirName(gitRoot)}/`;
  const nonAgentboardDirtyPaths = dirtyPaths.filter((path) => !normalizePath(path).startsWith(dataDirPrefix));
  if (nonAgentboardDirtyPaths.length > 0) {
    console.log("Main working tree is not clean. Commit, stash, or discard changes before merging.");
    process.exitCode = 1;
    return;
  }

  const sourceBranch = task.branchName;
  if (!branchExistsSafe(gitRoot, sourceBranch)) {
    console.log(`Task branch does not exist: ${sourceBranch}`);
    process.exitCode = 1;
    return;
  }

  const worktreeChangedFiles = parseChangedFiles(runGitArgs(worktreeAbsPath, ["diff", "--name-only"]).stdout);
  if (worktreeChangedFiles.length === 0) {
    console.log("No worktree diff to commit.");
  } else {
    const addResult = runGitArgs(worktreeAbsPath, ["add", "."]);
    if (addResult.status !== 0) {
      console.log("Failed to stage worktree changes before merge.");
      process.exitCode = 1;
      return;
    }

    const commitMessage = `ScopeGuard task ${task.id}: ${task.title}`;
    const commitResult = runGitArgs(worktreeAbsPath, ["commit", "-m", commitMessage]);
    if (commitResult.status !== 0) {
      const stderr = commitResult.stderr.trim();
      console.log(`Failed to commit worktree changes before merge.${stderr ? ` ${stderr}` : ""}`);
      process.exitCode = 1;
      return;
    }
  }

  const defaultBranch = resolveMergeTargetBranch(gitRoot);
  if (!defaultBranch) {
    console.log("Target branch could not be determined.");
    process.exitCode = 1;
    return;
  }
  if (!branchExistsSafe(gitRoot, defaultBranch)) {
    console.log(`Target branch does not exist: ${defaultBranch}`);
    process.exitCode = 1;
    return;
  }

  const checkoutResult = runGitArgs(gitRoot, ["checkout", defaultBranch]);
  if (checkoutResult.status !== 0) {
    console.log(`Failed to checkout ${defaultBranch}.`);
    process.exitCode = 1;
    return;
  }

  const mergeMessage = `Merge ScopeGuard task ${task.id}: ${task.title}`;
  const mergeResult = runGitArgs(gitRoot, ["merge", "--no-ff", sourceBranch, "-m", mergeMessage]);
  if (mergeResult.status !== 0) {
    task.status = "conflict";
    task.updatedAt = new Date().toISOString();
    writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

    console.log(`Merge conflict while merging ${taskId}.`);
    console.log("");
    console.log("Task status set to conflict.");
    console.log("");
    console.log("Resolve the conflict manually, then update the task or discard it.");
    process.exitCode = 1;
    return;
  }

  const cleanupNotes: string[] = [];
  const cleanupWarnings: string[] = [];

  if (keepWorktree) {
    cleanupNotes.push("worktree kept");
  } else {
    const result = cleanupTaskWorktreeSafe(gitRoot, task.id, task.worktreePath);
    if (result.ok) {
      cleanupNotes.push(result.removed ? "worktree removed" : result.message);
      if (result.removed) {
        task.worktreePath = null;
      }
    } else {
      cleanupWarnings.push(result.message);
    }
  }

  if (keepBranch) {
    cleanupNotes.push("branch kept");
  } else {
    const result = cleanupTaskBranchSafe(gitRoot, sourceBranch, defaultBranch);
    if (result.ok) {
      cleanupNotes.push(result.removed ? "branch deleted" : result.message);
      if (result.removed) {
        task.branchName = null;
      }
    } else {
      cleanupWarnings.push(result.message);
    }
  }

  const lockService = createFileLockService(gitRoot);
  lockService.releaseLocks(taskId);

  task.status = "merged";
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  console.log(`Merged task ${taskId}.`);
  console.log("");
  console.log("Merged branch:");
  console.log(sourceBranch);
  console.log("");
  console.log("Into:");
  console.log(defaultBranch);
  console.log("");
  console.log("Cleaned up:");
  for (const note of cleanupNotes) {
    console.log(`- ${note}`);
  }
  if (cleanupWarnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of cleanupWarnings) {
      console.log(`- ${warning}`);
    }
  }
  console.log("");
  console.log("Task status:");
  console.log("merged");
}

function runMergeContinue(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard merge --continue <task-id>");
    console.log("   or: scopeguard merge <task-id> --continue");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const taskDir = joinDataDir(gitRoot, "tasks", taskId);
  const taskPath = join(taskDir, "task.json");
  if (!existsSync(taskPath)) {
    console.log(`Task ${taskId} not found.`);
    process.exitCode = 1;
    return;
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  if (task.status === "merged") {
    console.log(`Task ${taskId} is already merged.`);
    return;
  }

  if (task.status !== "conflict") {
    console.log(`Task ${taskId} is not in conflict state.`);
    process.exitCode = 1;
    return;
  }

  const mergeHeadResult = runGitArgs(gitRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHeadResult.status === 0) {
    console.log("Merge is still in progress.");
    console.log("Run:");
    console.log("  git status");
    console.log("  git add <resolved-files>");
    console.log("  git commit");
    console.log("Then:");
    console.log(`  scopeguard merge --continue ${taskId}`);
    process.exitCode = 1;
    return;
  }

  const unresolvedResult = runGitArgs(gitRoot, ["diff", "--name-only", "--diff-filter=U"]);
  if (unresolvedResult.status !== 0) {
    console.log("Failed to check unresolved files.");
    process.exitCode = 1;
    return;
  }

  const unresolvedFiles = parseChangedFiles(unresolvedResult.stdout);
  if (unresolvedFiles.length > 0) {
    console.log("Unmerged files remain:");
    for (const file of unresolvedFiles) {
      console.log(`- ${file}`);
    }
    console.log("Resolve them before continuing.");
    process.exitCode = 1;
    return;
  }

  const cleanupNotes: string[] = [];
  const cleanupWarnings: string[] = [];

  const worktreeRelPath = task.worktreePath ?? `${getDataDirName(gitRoot)}/worktrees/${taskId}`;
  const worktreeResult = cleanupTaskWorktreeSafe(gitRoot, task.id, worktreeRelPath);
  if (worktreeResult.ok) {
    cleanupNotes.push(worktreeResult.removed ? "worktree removed" : worktreeResult.message);
    task.worktreePath = null;
  } else {
    cleanupWarnings.push(worktreeResult.message);
  }

  const sourceBranch = task.branchName ?? `agent/${taskId}`;
  const targetBranch = resolveMergeTargetBranch(gitRoot) ?? getCurrentBranchSafe(gitRoot) ?? "";
  const branchResult = cleanupTaskBranchSafe(gitRoot, sourceBranch, targetBranch);
  if (branchResult.ok) {
    cleanupNotes.push(branchResult.removed ? "branch deleted" : branchResult.message);
    task.branchName = null;
  } else {
    cleanupWarnings.push(branchResult.message);
  }

  const lockService = createFileLockService(gitRoot);
  const releasedLocks = lockService.releaseLocks(taskId);

  task.status = "merged";
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");

  console.log(`Continued merge for ${taskId}.`);
  console.log("");
  console.log("Task status:");
  console.log("merged");
  console.log("");
  console.log("Cleaned up:");
  if (cleanupNotes.length === 0) {
    console.log("- (none)");
  } else {
    for (const note of cleanupNotes) {
      console.log(`- ${note}`);
    }
  }
  if (cleanupWarnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of cleanupWarnings) {
      console.log(`- ${warning}`);
    }
  }
  console.log("");
  console.log("Released locks:");
  console.log(String(releasedLocks));
}

function resolveMergeTargetBranch(gitRoot: string): string | null {
  const orderedCandidates: string[] = [];

  const configDefault = readDefaultBranchFromStorage(gitRoot, "config.json");
  if (configDefault) {
    orderedCandidates.push(configDefault);
  }

  const legacyDefault = readDefaultBranchFromStorage(gitRoot, "agentboard.json");
  if (legacyDefault) {
    orderedCandidates.push(legacyDefault);
  }

  const current = getCurrentBranchSafe(gitRoot);
  if (current) {
    orderedCandidates.push(current);
  }

  orderedCandidates.push("main", "master");

  const seen = new Set<string>();
  for (const candidate of orderedCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (branchExistsSafe(gitRoot, candidate)) {
      return candidate;
    }
  }

  return null;
}

function readDefaultBranchFromStorage(gitRoot: string, fileName: string): string | null {
  const path = joinDataDir(gitRoot, fileName);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { defaultBranch?: unknown };
    if (typeof parsed.defaultBranch === "string" && parsed.defaultBranch.trim().length > 0) {
      return parsed.defaultBranch.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function getCurrentBranchSafe(gitRoot: string): string | null {
  const result = runGitArgs(gitRoot, ["branch", "--show-current"]);
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  if (value.length === 0) {
    return null;
  }
  return value;
}

function branchExistsSafe(gitRoot: string, branchName: string): boolean {
  const result = runGitArgs(gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  return result.status === 0;
}

function parseGitPorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    if (line.length < 4) {
      continue;
    }

    let rawPath = line.slice(3).trim();
    if (rawPath.includes(" -> ")) {
      rawPath = rawPath.split(" -> ").at(-1) ?? rawPath;
    }
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
      rawPath = rawPath.slice(1, -1);
    }

    paths.push(normalizePath(rawPath));
  }

  return paths;
}

function cleanupTaskWorktreeSafe(gitRoot: string, taskId: string, worktreeRelPath: string): CleanupResult {
  const expected = joinDataDir(gitRoot, "worktrees", taskId);
  const target = join(gitRoot, worktreeRelPath);
  const expectedNorm = normalizePath(expected);
  const targetNorm = normalizePath(target);

  if (expectedNorm !== targetNorm) {
    return { ok: false, message: `Skipped unsafe worktree path: ${worktreeRelPath}` };
  }

  if (!existsSync(target)) {
    runGitArgs(gitRoot, ["worktree", "prune"]);
    return { ok: true, message: "worktree already absent", removed: false };
  }

  const listed = runGitArgs(gitRoot, ["worktree", "list", "--porcelain"]);
  const registeredPaths = listed.status === 0 ? parseRegisteredWorktrees(listed.stdout) : new Set<string>();
  if (registeredPaths.has(expectedNorm)) {
    const remove = runGitArgs(gitRoot, ["worktree", "remove", target, "--force"]);
    if (remove.status !== 0) {
      return { ok: false, message: `Failed to remove worktree ${worktreeRelPath}: ${remove.stderr.trim()}` };
    }
  } else {
    rmSync(target, { recursive: true, force: true });
  }

  runGitArgs(gitRoot, ["worktree", "prune"]);
  return { ok: true, message: "worktree removed", removed: true };
}

function parseRegisteredWorktrees(output: string): Set<string> {
  const set = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const absPath = line.slice("worktree ".length).trim();
    if (absPath.length > 0) {
      set.add(normalizePath(absPath));
    }
  }
  return set;
}

function cleanupTaskBranchSafe(gitRoot: string, branchName: string, targetBranch: string): CleanupResult {
  if (branchName === "main" || branchName === "master") {
    return { ok: false, message: `Refusing to delete protected branch: ${branchName}` };
  }

  const currentBranch = getCurrentBranchSafe(gitRoot);
  if (currentBranch === branchName || targetBranch === branchName) {
    return { ok: false, message: `Refusing to delete current/target branch: ${branchName}` };
  }

  if (!branchExistsSafe(gitRoot, branchName)) {
    return { ok: true, message: "branch already absent", removed: false };
  }

  const del = runGitArgs(gitRoot, ["branch", "-D", branchName]);
  if (del.status !== 0) {
    return { ok: false, message: `Failed to delete branch ${branchName}: ${del.stderr.trim()}` };
  }

  return { ok: true, message: "branch deleted", removed: true };
}

function runFixScope(args: string[]): void {
  const taskId = args.find((arg) => !arg.startsWith("-"));
  if (!taskId) {
    console.log("Usage: scopeguard fix-scope <task-id>");
    process.exitCode = 1;
    return;
  }

  const gitRoot = getGitRoot();
  const result = fixScopeTask(gitRoot, taskId);
  console.log(result.message);
  if (result.revertedFiles && result.revertedFiles.length > 0) {
    console.log("");
    console.log("Reverted files:");
    for (const file of result.revertedFiles) {
      console.log(`- ${file}`);
    }
  }
  if (result.remainingChangedFiles) {
    console.log("");
    console.log("Remaining changed files:");
    if (result.remainingChangedFiles.length === 0) {
      console.log("- (none)");
    } else {
      for (const file of result.remainingChangedFiles) {
        console.log(`- ${file}`);
      }
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function collectRevertTargetsFromVerifyReport(verifyReportPath: string): VerifyScopeTargets {
  const raw = JSON.parse(readFileSync(verifyReportPath, "utf-8")) as unknown;
  const scopeCheck = resolveScopeCheck(raw);

  const outsideAllowedFiles = normalizeFileList(
    readScopeStringArray(scopeCheck, "outsideAllowedFiles", "outside_allowed_files"),
  );
  const forbiddenFilesChanged = normalizeFileList(
    readScopeStringArray(scopeCheck, "forbiddenFilesChanged", "forbidden_files_changed"),
  );
  const generatedArtifactsChanged = normalizeFileList(
    readScopeStringArray(scopeCheck, "generatedArtifactsChanged", "generated_artifacts_changed"),
  );

  const filesToRevert = dedupeFileList([
    ...outsideAllowedFiles,
    ...forbiddenFilesChanged,
    ...generatedArtifactsChanged,
  ]);

  return {
    outsideAllowedFiles,
    forbiddenFilesChanged,
    generatedArtifactsChanged,
    filesToRevert,
  };
}

function collectRevertTargetsFromDiffFallback(worktreeAbsPath: string, task: TaskRecord): string[] {
  const changedFiles = parseChangedFiles(runGitArgs(worktreeAbsPath, ["diff", "--name-only"]).stdout);
  const targets = new Set<string>();

  for (const file of changedFiles) {
    const outsideAllowed = !task.allowedFiles.some((pattern) => matchesGlob(file, pattern));
    const forbidden = task.forbiddenFiles.some((pattern) => matchesGlob(file, pattern));
    const generated = DEFAULT_GENERATED_FORBIDDEN_PATTERNS.some((pattern) => matchesGlob(file, pattern));
    if (outsideAllowed || forbidden || generated) {
      targets.add(file);
    }
  }

  return [...targets].sort();
}

function parseChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
}

function resolveScopeCheck(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as { scopeCheck?: unknown; scope_check?: unknown };
  return obj.scopeCheck ?? obj.scope_check;
}

function readScopeStringArray(scopeCheck: unknown, camelKey: string, snakeKey: string): string[] {
  if (!scopeCheck || typeof scopeCheck !== "object") {
    return [];
  }
  const obj = scopeCheck as Record<string, unknown>;
  return toStringArray(obj[camelKey] ?? obj[snakeKey]);
}

function normalizeFileList(files: string[]): string[] {
  return files.map((file) => normalizePath(file)).filter((file) => file.length > 0);
}

function dedupeFileList(files: string[]): string[] {
  const deduped = new Set<string>();
  for (const file of files) {
    deduped.add(file);
  }
  return [...deduped].sort();
}

function printDebugFileList(title: string, files: string[]): void {
  console.log(`${title}:`);
  if (files.length === 0) {
    console.log("- (none)");
    return;
  }
  for (const file of files) {
    console.log(`- ${file}`);
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
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

function matchesGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalizePath(filePath));
}

function runGitArgs(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const res = spawnSync("git", ["-c", "safe.directory=*", ...args], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });

  return {
    status: typeof res.status === "number" ? res.status : null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error as Error | undefined,
  };
}

function parseReviewOutputPath(gitRoot: string, taskId: string, args: string[]): string | null {
  const index = args.indexOf("--output");
  if (index === -1) {
    return joinDataDir(gitRoot, "tasks", taskId, "review.md");
  }

  const value = args[index + 1];
  if (!value) {
    console.log("Missing value for --output.");
    return null;
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

function getReviewRecommendation(
  taskStatus: string,
  verifyReport: VerifyReport | null,
  hasArtifacts: boolean,
): string {
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
    const lines = verifyReport.commands.map(
      (cmd) => `- \`${cmd.command}\` (exitCode: ${cmd.exitCode}, passed: ${String(cmd.passed)})`,
    );
    return lines.join("\n");
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
    return `status: ${result.status ?? "Not available."}
summary: ${result.summary ?? "Not available."}
files_changed:
${toListOrNotAvailable(result.files_changed)}
tests_run:
${toListOrNotAvailable((result.tests_run ?? []).map((item) => JSON.stringify(item)))}
blocked_changes:
${toListOrNotAvailable((result.blocked_changes ?? []).map((item) => JSON.stringify(item)))}
risks:
${toListOrNotAvailable(result.risks)}`;
  }

  if (stdout && stdout.trim().length > 0) {
    const lines = stdout.split(/\r?\n/);
    const tail = lines.slice(-80).join("\n");
    return `stdout (last 80 lines):\n\n\`\`\`\n${tail}\n\`\`\``;
  }

  if (stderr && stderr.trim().length > 0) {
    const lines = stderr.split(/\r?\n/);
    const tail = lines.slice(-80).join("\n");
    return `stderr (last 80 lines):\n\n\`\`\`\n${tail}\n\`\`\``;
  }

  return "Not available.";
}

function buildRisksSection(task: TaskRecord, result: CodexResult | null, verifyReport: VerifyReport | null): string {
  const risks: string[] = [];
  risks.push(`Task risk level: ${task.riskLevel}`);

  for (const risk of result?.risks ?? []) {
    risks.push(`Codex risk: ${risk}`);
  }
  for (const file of verifyReport?.scopeCheck.generatedArtifactsChanged ?? []) {
    risks.push(`Generated artifact changed: ${file}`);
  }
  for (const file of verifyReport?.scopeCheck.outsideAllowedFiles ?? []) {
    risks.push(`Outside allowed scope: ${file}`);
  }
  for (const file of verifyReport?.scopeCheck.forbiddenFilesChanged ?? []) {
    risks.push(`Forbidden file changed: ${file}`);
  }

  return risks.map((line) => `- ${line}`).join("\n");
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

function parseDiscardToStatus(args: string[]): "ready" | "backlog" | null {
  const index = args.indexOf("--to");
  if (index === -1) {
    return "ready";
  }

  const value = args[index + 1];
  if (value === "ready" || value === "backlog") {
    return value;
  }

  console.log("Invalid --to value. Allowed values: ready, backlog.");
  return null;
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
  const expected = joinDataDir(gitRoot, "worktrees", taskId);
  const target = join(gitRoot, worktreeRelPath);
  const expectedNorm = normalizePath(expected);
  const targetNorm = normalizePath(target);

  if (targetNorm !== expectedNorm) {
    return `Skipped unsafe worktree path: ${worktreeRelPath}`;
  }

  if (!existsSync(target)) {
    runGit(gitRoot, "worktree prune");
    return `${worktreeRelPath} (not found)`;
  }

  const registeredWorktrees = getRegisteredWorktrees(gitRoot);
  if (registeredWorktrees.has(expectedNorm)) {
    runGit(gitRoot, `worktree remove "${target}" --force`);
  } else {
    rmSync(target, { recursive: true, force: true });
  }

  runGit(gitRoot, "worktree prune");
  return worktreeRelPath;
}

function getRegisteredWorktrees(gitRoot: string): Set<string> {
  const output = runGit(gitRoot, "worktree list --porcelain");
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

  runGit(gitRoot, `branch -D ${branchName}`);
  return branchName;
}

function branchExists(gitRoot: string, branchName: string): boolean {
  try {
    runGit(gitRoot, `show-ref --verify --quiet refs/heads/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

function getCurrentBranch(gitRoot: string): string | null {
  try {
    const value = runGit(gitRoot, "rev-parse --abbrev-ref HEAD").trim();
    return value === "HEAD" ? null : value;
  } catch {
    return null;
  }
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

function loadConfig(gitRoot: string): AgentBoardConfig {
  const configPath = joinDataDir(gitRoot, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${getDataDirName(gitRoot)}/config.json. Run \`scopeguard init\` (or \`agentboard init\`) first.`);
  }

  return JSON.parse(readFileSync(configPath, "utf-8")) as AgentBoardConfig;
}

function loadPlannerConfig(gitRoot: string): { projectId: string } {
  const legacyPath = joinDataDir(gitRoot, "agentboard.json");
  if (existsSync(legacyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as { projectId?: unknown };
      if (typeof parsed.projectId === "string" && parsed.projectId.trim().length > 0) {
        return { projectId: parsed.projectId.trim() };
      }
    } catch {
      // fall through to config.json
    }
  }

  const config = loadConfig(gitRoot);
  return { projectId: config.projectId };
}

function loadProjectMap(gitRoot: string): ProjectMap {
  const mapPath = joinDataDir(gitRoot, "project-map.json");
  if (!existsSync(mapPath)) {
    throw new Error(`Missing ${getDataDirName(gitRoot)}/project-map.json. Run \`scopeguard scan\` (or \`agentboard scan\`) first.`);
  }

  return JSON.parse(readFileSync(mapPath, "utf-8")) as ProjectMap;
}

function buildPlannerPrompt(
  projectMap: ProjectMap,
  requirementText: string,
  context: { projectId: string; requirementId: string },
): string {
  const dependencyGraphSample = projectMap.dependencyGraph.slice(0, 100);
  const graphWasTruncated = projectMap.dependencyGraph.length > dependencyGraphSample.length;
  const projectMapSummary = {
    stack: projectMap.stack,
    areas: projectMap.areas,
    dependencyGraph: dependencyGraphSample,
    dependencyGraphNote: graphWasTruncated
      ? `Dependency graph truncated to first ${dependencyGraphSample.length} edges out of ${projectMap.dependencyGraph.length}.`
      : `Dependency graph includes ${dependencyGraphSample.length} edges.`,
  };
  const defaults = [
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.map",
    "**/*.tsbuildinfo",
  ];

  return `# ScopeGuard Planning Prompt

## Role
You are a senior software project planner and technical lead.

Your job is to convert a large product/development requirement into safe, scoped, verifiable implementation tasks for AI coding agents.

## Project Context
${JSON.stringify(projectMapSummary, null, 2)}

## Requirement
${requirementText}

## Planning Rules
- Split the requirement into small implementation tasks.
- Each task should be independently reviewable.
- Each task must have clear acceptance criteria.
- Each task must include allowedFiles.
- Each task must include lockedFiles.
- lockedFiles should usually be the same as allowedFiles or narrower.
- Tasks that touch overlapping lockedFiles must not run in parallel.
- Use dependencies to serialize tasks that touch overlapping files or depend on another task's output.
- Avoid broad allowedFiles like "**/*" unless absolutely necessary.
- Do not allow edits to generated artifacts.
- Generated artifacts include dist/**, build/**, .next/**, coverage/**, *.map, *.tsbuildinfo.
- Prefer source files over generated outputs.
- Include commands that verify the task.
- Use riskLevel = low | medium | high.
- High risk tasks should be smaller and have more explicit acceptance criteria.

## Agent Types
- backend
- frontend
- fullstack
- test
- docs
- infra
- refactor

## Output JSON Schema
{
  "projectId": "${context.projectId}",
  "requirementId": "${context.requirementId}",
  "summary": "...",
  "tasks": [
    {
      "id": "T-001",
      "title": "...",
      "description": "...",
      "agentType": "backend",
      "allowedFiles": ["apps/server/src/**"],
      "lockedFiles": ["apps/server/src/**"],
      "forbiddenFiles": ${JSON.stringify(defaults)},
      "dependencies": [],
      "acceptanceCriteria": ["..."],
      "commands": ["pnpm build"],
      "riskLevel": "low"
    }
  ]
}

## Output Requirements
Return only valid JSON.
Do not include markdown fences.
Do not include comments.
Do not include explanatory text.
Task IDs must be stable and sequential: T-001, T-002, ...
Every task must have at least one acceptance criterion.
Every task must have at least one command.
Every task must have allowedFiles and lockedFiles.
`;
}

function parsePlanJson(raw: string): PlanInput | null {
  try {
    return JSON.parse(raw) as PlanInput;
  } catch {
    return null;
  }
}

function printValidationResult(
  status: "passed" | "failed",
  validation: PlanValidationResult,
  taskCount?: number,
): void {
  if (status === "passed") {
    console.log("Plan validation passed.");
    if (typeof taskCount === "number") {
      console.log("");
      console.log(`Tasks: ${taskCount}`);
      console.log(`Warnings: ${validation.warnings.length}`);
    }
    if (validation.warnings.length > 0) {
      console.log("");
      console.log("Warnings:");
      for (const warning of validation.warnings) {
        console.log(`- ${warning}`);
      }
    }
    return;
  }

  console.log("Plan validation failed.");
  console.log("");
  console.log("Errors:");
  for (const error of validation.errors) {
    console.log(`- ${error}`);
  }
  if (validation.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of validation.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function validatePlan(plan: PlanInput): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan || typeof plan !== "object") {
    return { errors: ["plan must be a JSON object"], warnings: [] };
  }

  if (typeof plan.projectId !== "string" || plan.projectId.trim().length === 0) {
    errors.push("missing projectId.");
  }
  if (typeof plan.requirementId !== "string" || plan.requirementId.trim().length === 0) {
    errors.push("missing requirementId.");
  }
  if (typeof plan.summary !== "string" || plan.summary.trim().length === 0) {
    errors.push("missing summary.");
  }
  if (!Array.isArray(plan.tasks)) {
    errors.push("missing tasks array.");
    return { errors, warnings };
  }

  const agentTypes = new Set(["backend", "frontend", "fullstack", "test", "docs", "infra", "refactor"]);
  const riskLevels = new Set(["low", "medium", "high"]);
  const taskIdSet = new Set(plan.tasks.map((task) => task.id));
  const generatedDefaults = [
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.map",
    "**/*.tsbuildinfo",
  ];

  for (const task of plan.tasks) {
    if (!task || typeof task !== "object") {
      errors.push("task entry must be an object.");
      continue;
    }

    if (typeof task.id !== "string" || !/^T-\d{3}$/.test(task.id)) {
      errors.push(`${task.id ?? "(unknown)"} has invalid id format. Expected ^T-\\d{3}$.`);
    }
    if (typeof task.title !== "string" || task.title.trim().length === 0) {
      errors.push(`${task.id ?? "(unknown)"} missing title.`);
    }
    if (typeof task.description !== "string" || task.description.trim().length === 0) {
      errors.push(`${task.id ?? "(unknown)"} missing description.`);
    }
    if (typeof task.agentType !== "string" || !agentTypes.has(task.agentType)) {
      errors.push(`${task.id ?? "(unknown)"} has invalid agentType.`);
    }
    if (typeof task.riskLevel !== "string" || !riskLevels.has(task.riskLevel)) {
      errors.push(`${task.id ?? "(unknown)"} has invalid riskLevel.`);
    }

    const arrayFields: Array<{ key: keyof PlanInput["tasks"][number]; value: unknown }> = [
      { key: "allowedFiles", value: task.allowedFiles },
      { key: "lockedFiles", value: task.lockedFiles },
      { key: "forbiddenFiles", value: task.forbiddenFiles },
      { key: "dependencies", value: task.dependencies },
      { key: "acceptanceCriteria", value: task.acceptanceCriteria },
      { key: "commands", value: task.commands },
    ];
    for (const field of arrayFields) {
      if (!Array.isArray(field.value)) {
        errors.push(`${task.id ?? "(unknown)"} missing ${String(field.key)} array.`);
      }
    }

    if (!Array.isArray(task.allowedFiles) || task.allowedFiles.length === 0) {
      errors.push(`${task.id ?? "(unknown)"} missing allowedFiles.`);
    } else if (task.allowedFiles.some((p) => p === "**/*" || p === "*" || p === ".")) {
      warnings.push(`${task.id} allowedFiles is broad: ${task.allowedFiles.join(", ")}`);
    }

    if (!Array.isArray(task.lockedFiles) || task.lockedFiles.length === 0) {
      errors.push(`${task.id ?? "(unknown)"} missing lockedFiles.`);
    }

    if (!Array.isArray(task.commands) || task.commands.length === 0) {
      errors.push(`${task.id ?? "(unknown)"} missing commands.`);
    }
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      errors.push(`${task.id ?? "(unknown)"} missing acceptanceCriteria.`);
    }

    if (Array.isArray(task.dependencies)) {
      for (const dep of task.dependencies) {
        if (!taskIdSet.has(dep)) {
          errors.push(`${task.id} dependency ${dep} does not exist.`);
        }
      }
    }

    if (Array.isArray(task.forbiddenFiles)) {
      const missingDefaults = generatedDefaults.filter((pattern) => !task.forbiddenFiles.includes(pattern));
      if (missingDefaults.length > 0) {
        warnings.push(`${task.id} forbiddenFiles is missing generated-artifact patterns: ${missingDefaults.join(", ")}`);
      }
    }
  }

  for (let i = 0; i < plan.tasks.length; i += 1) {
    for (let j = i + 1; j < plan.tasks.length; j += 1) {
      const a = plan.tasks[i];
      const b = plan.tasks[j];
      if (!a || !b || !Array.isArray(a.lockedFiles) || !Array.isArray(b.lockedFiles)) {
        continue;
      }
      const overlap = findLockedFilesOverlap(a.lockedFiles, b.lockedFiles);
      if (!overlap) {
        continue;
      }
      const aDependsOnB = Array.isArray(a.dependencies) && a.dependencies.includes(b.id);
      const bDependsOnA = Array.isArray(b.dependencies) && b.dependencies.includes(a.id);
      if (!aDependsOnB && !bDependsOnA) {
        warnings.push(`Warning: ${a.id} and ${b.id} both lock ${overlap} but neither depends on the other.`);
      }
    }
  }

  return { errors, warnings };
}

function findLockedFilesOverlap(aPatterns: string[], bPatterns: string[]): string | null {
  for (const a of aPatterns) {
    for (const b of bPatterns) {
      if (lockedPatternsOverlap(a, b)) {
        return `${a} <-> ${b}`;
      }
    }
  }
  return null;
}

function lockedPatternsOverlap(a: string, b: string): boolean {
  const left = normalizeLockedPattern(a);
  const right = normalizeLockedPattern(b);

  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const leftBase = lockedPatternBase(left);
  const rightBase = lockedPatternBase(right);
  if (!leftBase || !rightBase) {
    return false;
  }
  if (leftBase === rightBase) {
    return true;
  }
  return leftBase.startsWith(`${rightBase}/`) || rightBase.startsWith(`${leftBase}/`);
}

function normalizeLockedPattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

function lockedPatternBase(pattern: string): string | null {
  const normalized = normalizeLockedPattern(pattern);
  if (normalized.includes("*")) {
    if (normalized.endsWith("/**")) {
      return normalized.slice(0, -3).replace(/\/+$/, "");
    }
    return null;
  }
  return normalized;
}

function generateRequirementId(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const short = randomUUID().split("-")[0] ?? "000";
  return `REQ-${yyyy}${mm}${dd}-${short}`;
}

function getLatestRequirementId(gitRoot: string): string {
  const reqRoot = joinDataDir(gitRoot, "requirements");
  if (!existsSync(reqRoot)) {
    return "UNKNOWN-REQUIREMENT";
  }

  const dirs = readdirSync(reqRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return dirs.at(-1) ?? "UNKNOWN-REQUIREMENT";
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }

  return `${value}${" ".repeat(width - value.length)}`;
}

function joinDataDir(gitRoot: string, ...parts: string[]): string {
  return join(resolveDataDir(gitRoot).dataDir, ...parts);
}

function getDataDirName(gitRoot: string): ".scopeguard" | ".agentboard" {
  return resolveDataDir(gitRoot).dataDirName;
}

function getGitRoot(): string {
  const lookupCwd = resolve(process.env.INIT_CWD ?? process.cwd());

  try {
    return runGit(lookupCwd, "rev-parse --show-toplevel").trim();
  } catch {
    console.log("Failed to resolve Git root. Make sure you run this inside a Git repository.");
    process.exitCode = 1;
    process.exit();
  }
}

function getDefaultBranch(gitRoot: string): string {
  try {
    const symbolicRef = runGit(gitRoot, "symbolic-ref --short refs/remotes/origin/HEAD").trim();
    const branch = symbolicRef.split("/").at(-1);
    return branch && branch.length > 0 ? branch : "main";
  } catch {
    try {
      const headBranch = runGit(gitRoot, "rev-parse --abbrev-ref HEAD").trim();
      return headBranch === "HEAD" ? "main" : headBranch;
    } catch {
      return "main";
    }
  }
}

function runGit(cwd: string, args: string): string {
  return execSync(`git -c safe.directory=* ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

