import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  closeTask,
  dataPath,
  discardTask,
  fixScopeTask,
  generateReviewReport,
  getNextTasks,
  getReviewReportContent,
  resolveDataDir,
  reopenTask,
  getSchedule,
  verifyTask,
} from "@scopeguard/core";
import type {
  DesktopExecutorId,
  DesktopTaskRunRecord,
  DesktopTaskRunStatus,
  DesktopLaunchMode,
  DesktopTaskReviewSummary,
  DesktopLatestRunResult,
  DesktopTaskDispatchInfo,
  DesktopConnectedClient,
  DesktopAssignmentRecord,
  DesktopAssignmentStatus,
  DesktopTaskHandoff,
  DesktopExecutorConfig,
  DesktopExecutorAdapter,
  DesktopProject,
  DesktopTaskListItem,
  DesktopTaskDetail,
  DesktopTaskContext,
  DesktopConversationThread,
  DesktopProjectSession,
  DesktopMessage,
  DesktopProjectRecentRun,
  DesktopPlanTask,
  CoreTaskStatus,
} from "@scopeguard/shared";

// ── Runtime identity ──

const SERVER_BUILD_TIME: string = (() => {
  try {
    const distStat = statSync(fileURLToPath(import.meta.url));
    return distStat.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
})();
const SERVER_BOOT_TIME: string = new Date().toISOString();
const SERVER_VERSION: string = "0.4.0-preview";

// ── Types ──

type TaskStatus =
  | "backlog"
  | "planned"
  | "ready"
  | "blocked"
  | "in_progress"
  | "needs_review"
  | "test_failed"
  | "conflict"
  | "approved"
  | "merged"
  | "closed";

type TaskRecord = {
  id: string;
  projectId: string;
  requirementId: string;
  title: string;
  description: string;
  status: TaskStatus;
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
  // Extended desktop fields
  preferredExecutor?: string;
  assignedExecutor?: string;
  dependsOn?: string[];
  parallelizable?: boolean;
  priority?: string;
  latestRunResult?: DesktopLatestRunResult | null;
  latestReviewSummary?: DesktopTaskReviewSummary | null;
};

type DesktopDraftTaskRecord = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: "Draft";
  riskLevel: "medium";
  createdAt: string;
  updatedAt: string;
  sourceThreadId: string | null;
  allowedFiles?: string[];
  acceptanceCriteria?: string[];
  commands?: string[];
  preferredExecutor?: string;
  assignedExecutor?: string;
  dependsOn?: string[];
  parallelizable?: boolean;
  priority?: string;
};

type RawPlanningTask = {
  title?: string;
  goal?: string;
  allowedFiles?: string[];
  acceptanceCriteria?: string[];
  commands?: string[];
  preferredExecutor?: string;
  assignedExecutor?: string;
  dependsOn?: string[];
  parallelizable?: boolean;
  priority?: string;
};

type NormalizedPlanningTask = {
  title: string;
  goal: string;
  allowedFiles: string[];
  acceptanceCriteria: string[];
  commands: string[];
  preferredExecutor: string;
  assignedExecutor: string | null;
  dependsOn: string[];
  parallelizable: boolean;
  priority: string;
};

type BoardServer = {
  close: () => Promise<void>;
};

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error: Error | null;
  signal: string | null;
};

type ResolvedCliCommand = {
  command: string;
  argsPrefix: string[];
  debugInfo?: Record<string, unknown>;
};

// ── Constants ──

const VALID_STATUSES: ReadonlySet<string> = new Set([
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

const DEFAULT_DESKTOP_FORBIDDEN_FILES = [
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.map",
  "**/*.tsbuildinfo",
];

const REQUIRED_DATA_DIRS = ["tasks", "logs", "worktrees", "requirements"];

const PROJECT_ASSISTANT_ACTIONS: ReadonlySet<string> = new Set(["start_task"]);

const TASK_ASSISTANT_ACTIONS: ReadonlySet<string> = new Set([
  "refine_task",
  "review_task",
  "approve_task",
  "handoff_task",
  "update_task_details",
]);

// ── Exported: startBoardServer ──

export async function startBoardServer(gitRoot: string, port: number): Promise<BoardServer> {
  const server = createServer(async (req, res) => {
    await handleRequest(gitRoot, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

// ── Request Router ──

async function handleRequest(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // ── Core routes ──
  if (req.method === "GET" && path === "/health") {
    sendText(res, 200, "OK", "text/plain; charset=utf-8");
    return;
  }

  if (req.method === "GET" && path === "/api/project") {
    handleGetProject(gitRoot, res);
    return;
  }

  // ── Desktop routes ──

  if (req.method === "GET" && path === "/api/desktop/projects") {
    handleGetDesktopProjects(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/runtime-info") {
    handleGetDesktopRuntimeInfo(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/session") {
    handleGetDesktopSession(gitRoot, res);
    return;
  }

  if (req.method === "PUT" && path === "/api/desktop/session") {
    await handlePutDesktopSession(gitRoot, req, res);
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/open-folder") {
    await handleDesktopOpenFolder(req, res);
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/initialize") {
    handleDesktopInitialize(gitRoot, res);
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/git-init") {
    handleDesktopGitInit(gitRoot, res);
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/conversations") {
    await handleCreateDesktopConversation(gitRoot, req, res);
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/assistant") {
    await handleDesktopAssistant(gitRoot, req, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/ai-config") {
    handleGetDesktopAIConfig(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/file-preview") {
    handleGetDesktopFilePreview(gitRoot, url, res);
    return;
  }

  if (req.method === "PUT" && path === "/api/desktop/ai-config") {
    await handlePutDesktopAIConfig(gitRoot, req, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/conversations/")) {
    const threadId = decodeURIComponent(path.slice("/api/desktop/conversations/".length));
    handleGetDesktopConversation(gitRoot, threadId, res);
    return;
  }

  if (req.method === "PUT" && path.startsWith("/api/desktop/conversations/")) {
    const threadId = decodeURIComponent(path.slice("/api/desktop/conversations/".length));
    await handlePutDesktopConversation(gitRoot, threadId, req, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/projects/") && path.endsWith("/tasks")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/tasks";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    handleGetDesktopProjectTasks(gitRoot, projectId, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/projects/") && path.endsWith("/memory")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/memory";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    handleGetDesktopProjectMemory(gitRoot, projectId, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/projects/") && path.endsWith("/memory")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/memory";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    await handlePostDesktopProjectMemory(gitRoot, projectId, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/projects/") && path.endsWith("/rename")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/rename";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    await handleRenameDesktopProject(gitRoot, projectId, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/projects/") && path.endsWith("/trust")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/trust";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    await handleSetDesktopProjectTrust(gitRoot, projectId, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/projects/") && path.endsWith("/start-task")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/start-task";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    await handleStartDesktopTask(gitRoot, projectId, req, res);
    return;
  }

  // NEW: DELETE /api/desktop/projects/:projectId/drafts
  const deleteDraftsMatch = path.match(/^\/api\/desktop\/projects\/([^/]+)\/drafts$/);
  if (req.method === "DELETE" && deleteDraftsMatch) {
    const projectId = decodeURIComponent(deleteDraftsMatch[1]);
    await handleDeleteDesktopProjectDrafts(gitRoot, projectId, res);
    return;
  }

  // NEW: POST /api/desktop/projects/:projectId/commit-plan
  const commitPlanMatch = path.match(/^\/api\/desktop\/projects\/([^/]+)\/commit-plan$/);
  if (req.method === "POST" && commitPlanMatch) {
    const projectId = decodeURIComponent(commitPlanMatch[1]);
    await handlePostDesktopProjectCommitPlan(gitRoot, projectId, req, res);
    return;
  }

  const normalizePlanMatch = path.match(/^\/api\/desktop\/projects\/([^/]+)\/normalize-plan$/);
  if (req.method === "POST" && normalizePlanMatch) {
    const projectId = decodeURIComponent(normalizePlanMatch[1]);
    await handlePostDesktopProjectNormalizePlan(gitRoot, projectId, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/projects/") && path.endsWith("/plan")) {
    const prefix = "/api/desktop/projects/";
    const suffix = "/plan";
    const projectId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    await handlePostDesktopProjectPlan(gitRoot, projectId, req, res);
    return;
  }

  // NEW: GET /api/desktop/projects/:projectId/connect-artifact
  const connectArtifactMatch = path.match(/^\/api\/desktop\/projects\/([^/]+)\/connect-artifact$/);
  if (req.method === "GET" && connectArtifactMatch) {
    const projectId = decodeURIComponent(connectArtifactMatch[1]);
    handleGetConnectArtifact(gitRoot, projectId, req, res);
    return;
  }

  // ── Project batch queue ──

  const batchQueueMatch = path.match(/^\/api\/desktop\/projects\/([^/]+)\/queue-ready$/);
  if (req.method === "POST" && batchQueueMatch) {
    const projectId = decodeURIComponent(batchQueueMatch[1]);
    await handlePostDesktopProjectBatchQueue(gitRoot, projectId, res);
    return;
  }

  // ── Project batch cancel ──

  const batchCancelMatch = path.match(/^\/api\/desktop\/projects\/([^/]+)\/cancel-dispatches$/);
  if (req.method === "POST" && batchCancelMatch) {
    const projectId = decodeURIComponent(batchCancelMatch[1]);
    await handlePostDesktopProjectBatchCancel(gitRoot, projectId, res);
    return;
  }

  // ── Desktop task routes (context, runs, run, queue-assignment, handoff, etc.) ──

  if (req.method === "GET" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/context")) {
    const prefix = "/api/desktop/tasks/";
    const suffix = "/context";
    const taskId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    handleGetDesktopTaskContext(gitRoot, taskId, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/executors")) {
    handleGetDesktopExecutors(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/executor-config") {
    handleGetDesktopExecutorConfig(gitRoot, res);
    return;
  }

  if (req.method === "PUT" && path === "/api/desktop/executor-config") {
    await handlePutDesktopExecutorConfig(gitRoot, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/executors/") && path.endsWith("/test")) {
    const execId = decodeURIComponent(path.slice("/api/desktop/executors/".length, -"/test".length));
    await handlePostDesktopExecutorTest(gitRoot, execId, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/executors/") && path.endsWith("/open")) {
    const execId = decodeURIComponent(path.slice("/api/desktop/executors/".length, -"/open".length));
    handlePostDesktopExecutorOpen(gitRoot, execId, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/runs/recent") {
    handleGetDesktopRecentRuns(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/summary") {
    handleGetDesktopSummary(gitRoot, res);
    return;
  }

  // ── External API (authenticated) ──

  if (req.method === "GET" && path === "/api/desktop/external/discovery") {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    handleGetDesktopExternalDiscovery(res);
    return;
  }

  if (req.method === "GET" && path === "/api/desktop/external/clients") {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    const clients = resolveConnectedClients(gitRoot);
    sendJson(res, 200, { clients });
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/external/initialize") {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    await handlePostDesktopExternalInitialize(gitRoot, req, res);
    return;
  }

  if (req.method === "POST" && path === "/api/desktop/external/ping") {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    await handlePostDesktopExternalPing(gitRoot, req, res);
    return;
  }

  // ── Task run / handoff / external operations ──

  if (req.method === "POST" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/run")) {
    const taskId = decodeURIComponent(path.slice("/api/desktop/tasks/".length, -"/run".length));
    await handlePostDesktopTaskRun(gitRoot, taskId, req, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/handoff")) {
    const taskId = decodeURIComponent(path.slice("/api/desktop/tasks/".length, -"/handoff".length));
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    handleGetDesktopTaskHandoff(gitRoot, taskId, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/external-run/start")) {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    const tid = decodeURIComponent(path.slice("/api/desktop/tasks/".length, -"/external-run/start".length));
    await handlePostDesktopExternalRunStart(gitRoot, tid, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/external-run/finish")) {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    const tid = decodeURIComponent(path.slice("/api/desktop/tasks/".length, -"/external-run/finish".length));
    await handlePostDesktopExternalRunFinish(gitRoot, tid, req, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/external-review")) {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header. External API requires a valid Bearer token." });
      return;
    }
    const tid = decodeURIComponent(path.slice("/api/desktop/tasks/".length, -"/external-review".length));
    await handlePostDesktopExternalReview(gitRoot, tid, req, res);
    return;
  }

  // ── External assignment queue ──

  if (req.method === "GET" && path === "/api/desktop/external/pending") {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header." });
      return;
    }
    const parsedUrl = new URL(req.url ?? "", "http://localhost");
    const executorId = parsedUrl.searchParams.get("executorId") ?? null;
    const pending = listAssignments(gitRoot, { status: "pending", executorId: executorId || undefined });
    // Filter out assignments whose task has unsatisfied dependsOn dependencies
    const filtered = pending.filter((a) => {
      if (!a.taskId || !a.kind || a.kind !== "execution") return true; // only check execution assignments
      const task = readTaskById(gitRoot, a.taskId);
      if (!task) return true;
      const deps = task.dependsOn ?? [];
      if (deps.length === 0) return true;
      // A dependency is unsatisfied if the referenced task is not in a terminal done state
      for (const depId of deps) {
        const depTask = readTaskById(gitRoot, depId);
        if (!depTask) continue; // dependency not found → skip filter (might be a title not an ID)
        if (depTask.status !== "approved" && depTask.status !== "merged" && depTask.status !== "closed") {
          return false; // dependency not completed → exclude this assignment
        }
      }
      return true;
    });
    // Filter by parallelizable: if a task has parallelizable === false and the executor
    // already has a **claimed** (actively executing) non-parallelizable task, exclude this one.
    // Pending (unclaimed) tasks do not block each other — the executor can only claim one at a time,
    // and once claimed the other becomes blocked naturally.
    const parallelizableFiltered = filtered.filter((a) => {
      if (!a.taskId || !a.kind || a.kind !== "execution") return true;
      const task = readTaskById(gitRoot, a.taskId);
      if (!task) return true;
      if (task.parallelizable !== false) return true; // true or undefined → allow
      // parallelizable === false: check if the executor is already actively executing another
      const hasClaimedExec = listAssignments(gitRoot).some((x) =>
        x.taskId !== a.taskId && x.kind === "execution" && x.status === "claimed"
        && x.assignedExecutor === a.assignedExecutor
      );
      if (hasClaimedExec) return false; // executor is busy with another non-parallelizable task
      return true; // no active execution → allow this one
    });
    sendJson(res, 200, { assignments: parallelizableFiltered });
    return;
  }

  const claimMatch = path.match(/^\/api\/desktop\/external\/pending\/([^/]+)\/claim$/);
  if (req.method === "POST" && claimMatch) {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header." });
      return;
    }
    const assignmentId = decodeURIComponent(claimMatch[1]);
    const bodyText = await readRequestBody(req);
    let claimPayload: { sessionId?: string };
    try {
      claimPayload = JSON.parse(bodyText);
    } catch {
      claimPayload = {};
    }
    if (!claimPayload.sessionId) {
      sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "sessionId is required to claim." });
      return;
    }
    // Verify caller's executor matches the assignment's assignedExecutor
    const session = readExternalSession(gitRoot, claimPayload.sessionId);
    const callerExecutorId = session && typeof session.executorId === "string" ? session.executorId : null;
    if (callerExecutorId) {
      const preCheckAssignment = readAssignment(gitRoot, assignmentId);
      if (preCheckAssignment && preCheckAssignment.assignedExecutor !== callerExecutorId) {
        sendJson(res, 403, { ok: false, code: "EXECUTOR_MISMATCH", message: `Claim rejected: assignment requires executor "${preCheckAssignment.assignedExecutor}" but caller is "${callerExecutorId}".` });
        return;
      }
    }
    const claimed = claimAssignment(gitRoot, assignmentId, claimPayload.sessionId);
    if (!claimed) {
      sendJson(res, 409, { ok: false, code: "CLAIM_FAILED", message: "Assignment could not be claimed (not found or already claimed)." });
      return;
    }
    const task = readTaskById(gitRoot, claimed.taskId);
    if (!task) {
      sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task ${claimed.taskId} not found.` });
      return;
    }
    const handoffStruct = buildTaskHandoffPayload(gitRoot, task);
    const handoffPrompt = buildExecutorHandoffPrompt(handoffStruct, claimed.assignedExecutor);
    sendJson(res, 200, { ok: true, assignment: claimed, handoff: handoffStruct, handoffPrompt });
    return;
  }

  const completeMatch = path.match(/^\/api\/desktop\/external\/pending\/([^/]+)\/complete$/);
  if (req.method === "POST" && completeMatch) {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header." });
      return;
    }
    const assignmentId = decodeURIComponent(completeMatch[1]);
    const preCheck = readAssignment(gitRoot, assignmentId) as DesktopAssignmentRecord | null;
    if (preCheck && preCheck.kind === "execution") {
      const task = preCheck.taskId ? readTaskById(gitRoot, preCheck.taskId) : null;
      const latestRun = task?.latestRunResult ?? null;
      const hasFinishedRun = latestRun?.status === "succeeded" || latestRun?.status === "failed";
      const claimedAt = preCheck.claimedAt ? Date.parse(preCheck.claimedAt) : 0;
      const finishedAt = latestRun?.finishedAt ? Date.parse(latestRun.finishedAt) : 0;
      if (!task || !hasFinishedRun || (claimedAt > 0 && finishedAt > 0 && finishedAt < claimedAt)) {
        sendJson(res, 422, { ok: false, code: "RUN_RESULT_REQUIRED", message: "Execution assignment must report a finished external run before it can be marked complete." });
        return;
      }
    }
    if (preCheck && preCheck.kind === "review") {
      const task = preCheck.taskId ? readTaskById(gitRoot, preCheck.taskId) : null;
      if (task) {
        const rev = (task as Record<string, unknown>).latestReviewSummary as Record<string, unknown> | null | undefined;
        const isRealReview = rev && typeof rev.reviewId === "string" && rev.reviewId.startsWith("external-");
        if (!isRealReview) {
          sendJson(res, 422, { ok: false, code: "REVIEW_REQUIRED", message: "Review assignment must be completed via scopeguard_submit_review before marking the assignment done." });
          return;
        }
      }
    }
    const done = completeAssignment(gitRoot, assignmentId);
    if (!done) {
      sendJson(res, 404, { ok: false, code: "ASSIGNMENT_NOT_FOUND", message: `Assignment ${assignmentId} not found.` });
      return;
    }
    sendJson(res, 200, { ok: true, assignment: done });
    return;
  }

  // ── Cancel assignment ──

  const cancelMatch = path.match(/^\/api\/desktop\/external\/pending\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    if (!validateExternalApiToken(gitRoot, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Missing or invalid Authorization header." });
      return;
    }
    const assignmentId = decodeURIComponent(cancelMatch[1]);
    const canceled = cancelAssignment(gitRoot, assignmentId);
    if (!canceled) {
      sendJson(res, 409, { ok: false, code: "CANCEL_FAILED", message: "Assignment could not be canceled (not found, already completed/canceled, not an execution assignment, or task is past the execution phase)." });
      return;
    }
    sendJson(res, 200, { ok: true, assignment: canceled });
    return;
  }

  // ── Queue assignment ──

  if (req.method === "POST" && path.endsWith("/queue-assignment")) {
    const taskId = decodeURIComponent(path.slice("/api/desktop/tasks/".length, -"/queue-assignment".length));
    const task = readTaskById(gitRoot, taskId) ?? readDesktopDraftTaskById(gitRoot, taskId);
    if (!task) {
      const fallbackTask = scanAllTasksForId(gitRoot, taskId);
      if (fallbackTask) {
        await processQueueAssignment(gitRoot, taskId, fallbackTask, res);
        return;
      }
      const fallbackDraft = scanAllDraftsForId(gitRoot, taskId);
      if (fallbackDraft) {
        await processQueueAssignment(gitRoot, taskId, fallbackDraft, res);
        return;
      }
      sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
      return;
    }
    await processQueueAssignment(gitRoot, taskId, task, res);
    return;
  }

  // ── Task runs ──

  if (req.method === "GET" && path.startsWith("/api/desktop/tasks/") && path.includes("/runs/")) {
    const runsIndex = path.lastIndexOf("/runs/");
    const taskId = decodeURIComponent(path.slice("/api/desktop/tasks/".length, runsIndex));
    const runId = decodeURIComponent(path.slice(runsIndex + "/runs/".length));
    handleGetDesktopTaskRun(gitRoot, taskId, runId, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/tasks/") && path.endsWith("/runs")) {
    const prefix = "/api/desktop/tasks/";
    const suffix = "/runs";
    const taskId = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    handleGetDesktopTaskRuns(gitRoot, taskId, res);
    return;
  }

  // NEW: DELETE /api/desktop/tasks/draft/:taskId
  if (req.method === "DELETE" && path.startsWith("/api/desktop/tasks/draft/")) {
    const taskId = decodeURIComponent(path.slice("/api/desktop/tasks/draft/".length));
    handleDeleteDesktopDraftTask(gitRoot, taskId, res);
    return;
  }

  // Test: POST /api/desktop/tasks/:taskId/simulate-needs-attention
  const simulateMatch = path.match(/^\/api\/desktop\/tasks\/([^/]+)\/simulate-needs-attention$/);
  if (req.method === "POST" && simulateMatch) {
    const taskId = decodeURIComponent(simulateMatch[1]);
    handlePostSimulateNeedsAttention(gitRoot, taskId, res);
    return;
  }

  // ── Desktop task action (rename, refine, review, approve, handoff, update-details) ──

  if (req.method === "POST" && path.startsWith("/api/desktop/tasks/")) {
    const match = parseDesktopTaskPath(path);
    if (!match) {
      sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: "Not found." });
      return;
    }
    await handleDesktopTaskAction(gitRoot, match.taskId, match.subPath, req, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/desktop/tasks/")) {
    const taskId = decodeURIComponent(path.slice("/api/desktop/tasks/".length));
    handleGetDesktopTask(gitRoot, taskId, res);
    return;
  }

  // ── Core task routes ──

  if (req.method === "GET" && path === "/api/tasks") {
    handleGetTasks(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/tasks/")) {
    const match = parseTaskPath(path);
    if (match && match.subPath === "review") {
      handleGetTaskReview(gitRoot, match.taskId, res);
      return;
    }
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length));
    handleGetTask(gitRoot, taskId, res);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/tasks/")) {
    const match = parseTaskPath(path);
    if (!match) {
      sendJson(res, 404, { ok: false, message: "Not found." });
      return;
    }
    await handleTaskAction(gitRoot, match.taskId, match.subPath, req, res);
    return;
  }

  if (req.method === "PATCH" && path.startsWith("/api/tasks/")) {
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length));
    await handlePatchTask(gitRoot, taskId, req, res);
    return;
  }

  if (req.method === "GET" && path === "/api/locks") {
    handleGetLocks(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/scheduler/next") {
    handleGetSchedulerNext(gitRoot, res);
    return;
  }

  if (req.method === "GET" && path === "/api/scheduler/schedule") {
    handleGetSchedulerSchedule(gitRoot, res);
    return;
  }

  handleStatic(path, res);
}

// ── Core Handlers ──

function handleGetProject(gitRoot: string, res: ServerResponse): void {
  const configPath = dataPath(gitRoot, "config.json");
  const mapPath = dataPath(gitRoot, "project-map.json");
  const dataDirName = resolveDataDir(gitRoot).dataDirName;

  if (!existsSync(configPath)) {
    sendJson(res, 400, { error: `Missing ${dataDirName}/config.json. Run scopeguard init first.` });
    return;
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  if (!existsSync(mapPath)) {
    sendJson(res, 200, {
      config,
      projectMap: null,
      warning: `Missing ${dataDirName}/project-map.json. Run scopeguard scan first.`,
    });
    return;
  }

  const projectMap = JSON.parse(readFileSync(mapPath, "utf-8"));
  sendJson(res, 200, { config, projectMap });
}

function handleGetTasks(gitRoot: string, res: ServerResponse): void {
  sendJson(res, 200, readAllTasks(gitRoot));
}

function handleGetTask(gitRoot: string, taskId: string, res: ServerResponse): void {
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    sendJson(res, 404, { error: `Task not found: ${taskId}` });
    return;
  }
  sendJson(res, 200, task);
}

function handleGetTaskReview(gitRoot: string, taskId: string, res: ServerResponse): void {
  const result = getReviewReportContent(gitRoot, taskId);
  if (!result.ok) {
    sendJson(res, 404, result);
    return;
  }
  sendJson(res, 200, result);
}

async function handlePatchTask(gitRoot: string, taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  if (!existsSync(taskPath)) {
    sendJson(res, 404, { error: `Task not found: ${taskId}` });
    return;
  }

  const bodyText = await readRequestBody(req);
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "status")) {
    sendJson(res, 400, { error: "PATCH body must include status." });
    return;
  }

  const { status } = payload as { status?: string };
  if (!status || !VALID_STATUSES.has(status)) {
    sendJson(res, 400, { error: "Invalid status value." });
    return;
  }

  const task = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  task.status = status as TaskStatus;
  task.updatedAt = new Date().toISOString();

  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");
  sendJson(res, 200, task);
}

function handleGetLocks(gitRoot: string, res: ServerResponse): void {
  const locksPath = dataPath(gitRoot, "locks.json");

  if (!existsSync(locksPath)) {
    sendJson(res, 200, { locks: [] });
    return;
  }

  const locks = JSON.parse(readFileSync(locksPath, "utf-8"));
  sendJson(res, 200, locks);
}

function handleGetSchedulerNext(gitRoot: string, res: ServerResponse): void {
  try {
    const result = getNextTasks(gitRoot);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to load scheduler next result.",
    });
  }
}

function handleGetSchedulerSchedule(gitRoot: string, res: ServerResponse): void {
  try {
    const result = getSchedule(gitRoot);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to load scheduler schedule result.",
    });
  }
}

async function handleTaskAction(
  gitRoot: string,
  taskId: string,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (action === "verify") {
    const result = verifyTask(gitRoot, taskId);
    const statusCode = result.ok ? 200 : result.message.startsWith("Task ") ? 404 : 422;
    sendJson(res, statusCode, {
      ok: result.ok,
      taskId,
      status: result.ok ? "passed" : "failed",
      message: result.message,
      reportPath: `${resolveDataDir(gitRoot).dataDirName}/tasks/${taskId}/verify-report.json`,
    });
    return;
  }

  if (action === "fix-scope") {
    const result = fixScopeTask(gitRoot, taskId);
    const statusCode = result.ok ? 200 : 422;
    sendJson(res, statusCode, result);
    return;
  }

  if (action === "review") {
    const result = generateReviewReport(gitRoot, taskId);
    const statusCode = result.ok ? 200 : 422;
    sendJson(res, statusCode, result);
    return;
  }

  if (action === "discard") {
    const result = discardTask(gitRoot, taskId, { toStatus: "ready" });
    const statusCode = result.ok ? 200 : 422;
    sendJson(res, statusCode, result);
    return;
  }

  if (action === "close") {
    const bodyText = await readRequestBody(req);
    let reason = "manual";
    if (bodyText.trim().length > 0) {
      try {
        const payload = JSON.parse(bodyText) as { reason?: unknown };
        if (typeof payload.reason === "string" && payload.reason.trim().length > 0) {
          reason = payload.reason.trim();
        }
      } catch {
        // keep default reason
      }
    }
    const result = closeTask(gitRoot, taskId, reason);
    const statusCode = result.ok ? 200 : 422;
    sendJson(res, statusCode, result);
    return;
  }

  if (action === "reopen") {
    const result = reopenTask(gitRoot, taskId);
    const statusCode = result.ok ? 200 : 422;
    sendJson(res, statusCode, result);
    return;
  }

  sendJson(res, 404, { ok: false, taskId, message: `Unknown action: ${action}` });
}

// ── Desktop Route Handlers ──

function handleGetDesktopProjects(gitRoot: string, res: ServerResponse): void {
  const project = buildDesktopProject(gitRoot);
  sendJson(res, 200, { projects: project ? [project] : [] });
}

function handleGetDesktopRuntimeInfo(gitRoot: string, res: ServerResponse): void {
  sendJson(res, 200, {
    serverVersion: SERVER_VERSION,
    buildTime: SERVER_BUILD_TIME,
    bootTime: SERVER_BOOT_TIME,
    pid: process.pid,
    cwd: process.cwd(),
    gitRoot,
    platform: process.platform,
    nodeVersion: process.version,
    arch: process.arch,
  });
}

function handleGetDesktopProjectMemory(gitRoot: string, projectId: string, res: ServerResponse): void {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  sendJson(res, 200, { ok: true, projectId, memories: readDesktopProjectMemory(gitRoot) });
}

function handleGetDesktopSession(gitRoot: string, res: ServerResponse): void {
  const session = readDesktopSession(gitRoot);
  sendJson(res, 200, { session });
}

function handleGetDesktopAIConfig(gitRoot: string, res: ServerResponse): void {
  sendJson(res, 200, { config: readDesktopAIConfig(gitRoot) });
}

function handleGetDesktopFilePreview(gitRoot: string, url: URL, res: ServerResponse): void {
  const relativePath = url.searchParams.get("path")?.trim() ?? "";
  if (!relativePath) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "path is required." });
    return;
  }
  if (relativePath.includes("..") || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "path must be a safe relative path." });
    return;
  }
  const absolutePath = resolve(gitRoot, relativePath);
  const normalizedRoot = normalizeSlashes(resolve(gitRoot));
  const normalizedPath = normalizeSlashes(absolutePath);
  if (!normalizedPath.startsWith(`${normalizedRoot}/`) && normalizedPath !== normalizedRoot) {
    sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: "Requested file is outside the current workspace." });
    return;
  }
  if (!existsSync(absolutePath)) {
    sendJson(res, 404, { ok: false, code: "FILE_NOT_FOUND", message: `File not found: ${relativePath}` });
    return;
  }
  try {
    const content = readFileSync(absolutePath, "utf-8");
    sendJson(res, 200, {
      ok: true,
      file: {
        path: normalizeSlashes(relativePath),
        content: content.length > 24000 ? `${content.slice(0, 24000)}\n\n... [truncated]` : content,
      },
    });
  } catch {
    sendJson(res, 422, { ok: false, code: "FILE_UNREADABLE", message: `Unable to read file: ${relativePath}` });
  }
}

async function handlePutDesktopSession(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { session?: unknown };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const session = payload?.session;
  if (!isDesktopProjectSession(session)) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid session payload." });
    return;
  }
  writeDesktopSession(gitRoot, session);
  sendJson(res, 200, { ok: true, session });
}

async function handlePutDesktopAIConfig(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { config?: unknown };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const config = sanitizeDesktopAIConfig((payload as { config?: unknown }).config);
  writeDesktopAIConfig(gitRoot, config);
  sendJson(res, 200, { ok: true, config });
}

async function handlePostDesktopProjectMemory(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { kind?: string; title?: string; content?: string; source?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const kind = payload.kind === "pattern" || payload.kind === "note" || payload.kind === "review" ? payload.kind : "note";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  const source = payload.source === "assistant" || payload.source === "system" ? payload.source : "user";
  if (!title || !content) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "title and content are required." });
    return;
  }
  const record = appendDesktopProjectMemory(gitRoot, { kind, title, content, source });
  sendJson(res, 200, { ok: true, projectId, memory: record });
}

async function handleDesktopOpenFolder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { folderPath?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const folderPath = typeof payload?.folderPath === "string" ? payload.folderPath : "";
  if (folderPath.trim().length === 0) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "folderPath is required." });
    return;
  }
  const result = inspectFolderForDesktop(folderPath);
  sendJson(res, result.ok ? 200 : 422, result);
}

function handleDesktopInitialize(gitRoot: string, res: ServerResponse): void {
  const result = initializeScopeGuardProject(gitRoot);
  sendJson(res, result.ok ? 200 : 422, result);
}

function handleDesktopGitInit(gitRoot: string, res: ServerResponse): void {
  const result = initializeGitRepositoryForDesktop(gitRoot);
  sendJson(res, result.ok ? 200 : 422, result);
}

async function handleRenameDesktopProject(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { title?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  if (!title) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "title is required." });
    return;
  }
  const result = renameDesktopProject(gitRoot, projectId, title);
  if (!result.ok) {
    sendJson(res, result.code === "PROJECT_NOT_FOUND" ? 404 : 422, result);
    return;
  }
  sendJson(res, 200, result);
}

async function handleSetDesktopProjectTrust(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { trusted?: boolean };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const trusted = typeof payload?.trusted === "boolean" ? payload.trusted : null;
  if (trusted === null) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "trusted must be a boolean." });
    return;
  }
  writeDesktopProjectMeta(gitRoot, {
    ...readDesktopProjectMeta(gitRoot),
    trusted,
  });
  sendJson(res, 200, {
    ok: true,
    project: buildDesktopProject(gitRoot),
  });
}

async function handleStartDesktopTask(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { userGoal?: string; sourceThreadId?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const userGoal = typeof payload?.userGoal === "string" ? payload.userGoal.trim() : "";
  const sourceThreadId = typeof payload?.sourceThreadId === "string" ? payload.sourceThreadId : null;
  if (!userGoal) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "userGoal is required." });
    return;
  }
  const draftTask = createDesktopDraftTask(gitRoot, projectId, userGoal, sourceThreadId);
  const thread = createDraftTaskConversation(gitRoot, draftTask, "Task created. Continue here to define the first concrete changes and then start editing files.");
  sendJson(res, 200, { ok: true, draftTask, thread });
}

function handleGetDesktopConversation(gitRoot: string, threadId: string, res: ServerResponse): void {
  const thread = readDesktopConversation(gitRoot, threadId);
  if (!thread) {
    sendJson(res, 404, { ok: false, code: "THREAD_NOT_FOUND", message: `Conversation not found: ${threadId}` });
    return;
  }
  sendJson(res, 200, { thread });
}

async function handlePutDesktopConversation(gitRoot: string, threadId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { thread?: unknown };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const thread = payload?.thread;
  if (!isDesktopConversationThread(thread) || (thread as { id: string }).id !== threadId) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid thread payload." });
    return;
  }
  writeDesktopConversation(gitRoot, thread as DesktopConversationThread);
  sendJson(res, 200, { ok: true, thread });
}

async function handleCreateDesktopConversation(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { projectId?: string; kind?: string; taskId?: string; title?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
  const kind = payload.kind === "project" || payload.kind === "task" ? payload.kind : null;
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!projectId || !kind || !title) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "projectId, kind, and title are required." });
    return;
  }
  if (kind === "task" && !taskId) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "taskId is required for task conversations." });
    return;
  }
  const now = new Date().toISOString();
  const threadId = kind === "task" ? `task-${taskId}` : `project-${projectId}`;
  const existing = readDesktopConversation(gitRoot, threadId);
  if (existing) {
    sendJson(res, 200, { ok: true, threadId, thread: existing });
    return;
  }
  const thread: DesktopConversationThread = {
    id: threadId,
    projectId,
    kind,
    taskId,
    title,
    status: "active",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeDesktopConversation(gitRoot, thread);
  sendJson(res, 200, { ok: true, threadId, thread });
}

async function handleDesktopAssistant(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const aiConfig = resolveEffectiveAIConfig(gitRoot);
  if (aiConfig.provider !== "codex-account" && !aiConfig.apiKey) {
    sendJson(res, 503, {
      ok: false,
      code: "LLM_NOT_CONFIGURED",
      message: "API_KEY is not set. Configure AI_PROVIDER / API_KEY / BASE_URL before using the desktop LLM assistant.",
    });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { scope?: string; userText?: string; projectId?: string; taskId?: string; stream?: boolean };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const scope = payload.scope === "project" || payload.scope === "task" ? payload.scope : null;
  const userText = typeof payload.userText === "string" ? payload.userText.trim() : "";
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  const shouldStream = payload.stream === true;
  if (!scope || !userText) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "scope and userText are required." });
    return;
  }
  const project = buildDesktopProject(gitRoot);
  if (!project || (scope === "project" && projectId && project.id !== projectId)) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId ?? "unknown"}` });
    return;
  }
  if (!project.isTrusted) {
    sendJson(res, 403, {
      ok: false,
      code: "TRUST_REQUIRED",
      message: "Trust this workspace before ScopeGuard reads project files and answers with full context.",
    });
    return;
  }
  if (shouldStream) {
    await handleDesktopAssistantStream(gitRoot, aiConfig, scope, projectId, taskId, userText, res);
    return;
  }
  try {
    const assistantTurn = scope === "project"
      ? await runProjectAssistantTurn(gitRoot, aiConfig, projectId, userText)
      : await runTaskAssistantTurn(gitRoot, aiConfig, taskId, userText);
    sendJson(res, 200, { ok: true, ...assistantTurn });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      code: "LLM_REQUEST_FAILED",
      message: error instanceof Error ? error.message : "Desktop assistant request failed.",
    });
  }
}

async function handleDesktopAssistantStream(
  gitRoot: string,
  aiConfig: AIConfig,
  scope: string,
  projectId: string | null,
  taskId: string | null,
  userText: string,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  const sendSSE = (data: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const project = buildDesktopProject(gitRoot);
    if (scope === "project" && (!project || (projectId && project.id !== projectId))) {
      throw new Error(`Project not found: ${projectId ?? "unknown"}`);
    }
    const taskList: DesktopTaskListItem[] = scope === "project" && project
      ? (() => {
        const tasks = readAllTasks(gitRoot)
          .filter((t) => t.projectId === project.id)
          .filter((t) => !["merged", "closed"].includes(t.status))
          .map((t) => toDesktopTaskListItem(gitRoot, t));
        const drafts = readDesktopDraftTasks(gitRoot, project.id).map((d) => toDesktopTaskListItemFromDraft(gitRoot, d));
        return drafts.concat(tasks);
      })()
      : [];
    const rawTaskRecord = scope === "task" && taskId
      ? (readTaskById(gitRoot, taskId) ?? readDesktopDraftTaskById(gitRoot, taskId))
      : null;
    const taskDetail = rawTaskRecord
      ? ("status" in rawTaskRecord && rawTaskRecord.status !== "Draft"
        ? toDesktopTaskDetail(gitRoot, rawTaskRecord as TaskRecord)
        : toDesktopTaskDetailFromDraft(gitRoot, rawTaskRecord as DesktopDraftTaskRecord))
      : null;
    const taskCtx = rawTaskRecord
      ? ("status" in rawTaskRecord && rawTaskRecord.status !== "Draft"
        ? toDesktopTaskContext(gitRoot, rawTaskRecord as TaskRecord)
        : toDesktopTaskContextFromDraft(rawTaskRecord as DesktopDraftTaskRecord))
      : null;
    const thread = scope === "task" && taskId
      ? readDesktopConversation(gitRoot, `task-${taskId}`)
      : scope === "project" && project
        ? readDesktopConversation(gitRoot, `project-${project.id}`)
        : null;
    const projectMemory = readDesktopProjectMemory(gitRoot);
    if (scope === "project" && project) {
      const memoryIntent = detectProjectMemoryIntent(projectMemory, userText);
      if (memoryIntent?.type === "show") {
        sendSSE({ done: true, message: buildScopeGuardMessage("summary", formatProjectMemorySummary(projectMemory)), memories: projectMemory });
        return;
      }
    }
    const promptContext = {
      project: project ? { name: project.name, rootPath: project.rootPath } : null,
      tasks: taskList as unknown as Record<string, unknown>[],
      task: taskDetail as unknown as Record<string, unknown> | null,
      taskContext: taskCtx as unknown as Record<string, unknown> | null,
      projectMemory: projectMemory.slice(-5),
      recentMessages: (thread?.messages ?? []).slice(-8).map((m) => ({ role: m.role, text: m.text })),
    };
    const prompts = buildAssistantPrompts(scope, promptContext, userText);
    let fullText = "";
    if (aiConfig.provider === "codex-account") {
      fullText = requestCodexCliAssistant(aiConfig, prompts.systemPrompt, prompts.rawPrompt);
      sendSSE({ chunk: fullText });
    } else {
      const stream = aiConfig.provider === "anthropic"
        ? streamAnthropicCompatible(aiConfig, prompts.systemPrompt, prompts.rawPrompt)
        : streamOpenAICompatible(aiConfig, prompts.systemPrompt, prompts.rawPrompt);
      for await (const chunk of stream) {
        fullText += chunk;
        sendSSE({ chunk });
      }
    }
    const parsed = parseAssistantJsonResponse(fullText);
    const typedRawTask = rawTaskRecord as (TaskRecord | DesktopDraftTaskRecord) | null;
    const isFormal = typedRawTask && "status" in typedRawTask && typedRawTask.status !== "Draft";
    const isDraft = typedRawTask && "status" in typedRawTask && typedRawTask.status === "Draft";
    const assistantTurn = scope === "project"
      ? applyProjectAssistantResult(gitRoot, project, null, userText, parsed)
      : applyTaskAssistantResult(
        gitRoot,
        taskId ?? "",
        userText,
        isFormal ? (typedRawTask as TaskRecord) : null,
        isDraft ? (typedRawTask as DesktopDraftTaskRecord) : null,
        parsed,
      );
    sendSSE({ done: true, ...assistantTurn });
  } catch (error) {
    sendSSE({ error: true, message: error instanceof Error ? error.message : "Stream request failed." });
  } finally {
    res.end();
  }
}

async function handleDesktopTaskAction(gitRoot: string, taskId: string, action: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (action === "rename") {
    const bodyText = await readRequestBody(req);
    let payload: { title?: string };
    try {
      payload = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
      return;
    }
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    if (!title) {
      sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "title is required." });
      return;
    }
    const result = renameDesktopTask(gitRoot, taskId, title);
    if (!result.ok) {
      sendJson(res, result.code === "TASK_NOT_FOUND" ? 404 : 422, result);
      return;
    }
    sendJson(res, 200, result);
    return;
  }
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    const draftTask = readDesktopDraftTaskById(gitRoot, taskId);
    if (draftTask && action === "refine") {
      const promotedTask = promoteDesktopDraftTask(gitRoot, draftTask);
      sendJson(res, 200, {
        ok: true,
        taskId,
        rawStatus: promotedTask.status,
        task: toDesktopTaskDetail(gitRoot, promotedTask),
        context: toDesktopTaskContext(gitRoot, promotedTask),
        message: buildScopeGuardMessage("summary", promotedTask.status === "ready"
          ? "Draft refined into a ready task."
          : "Draft refined into a planned task.", { taskId, rawStatus: promotedTask.status }),
      });
      return;
    }
    if (draftTask) {
      sendJson(res, 422, { ok: false, code: "DRAFT_TASK", message: `Draft task ${taskId} must be refined before ${action}.` });
      return;
    }
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  if (action === "review") {
    const result = generateReviewReport(gitRoot, taskId);
    if (!result.ok) {
      sendJson(res, 422, { ok: false, code: "REVIEW_FAILED", message: result.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      taskId,
      reviewPath: result.reviewPath,
      message: buildScopeGuardMessage("review", "Review is ready.", {
        taskId,
        reportPath: result.reviewPath,
        rawStatus: task.status,
      }),
    });
    return;
  }
  if (action === "approve") {
    const approvedTask = approveDesktopTask(gitRoot, taskId);
    if (!approvedTask.ok) {
      sendJson(res, 422, { ok: false, code: "APPROVAL_FAILED", message: approvedTask.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      taskId,
      rawStatus: "approved",
      message: buildScopeGuardMessage("approval_result", "Approval recorded.", {
        taskId,
        rawStatus: "approved",
      }),
    });
    return;
  }
  if (action === "archive") {
    const archivedTask = closeTask(gitRoot, taskId, "archived");
    if (!archivedTask.ok) {
      sendJson(res, 422, { ok: false, code: "ARCHIVE_FAILED", message: archivedTask.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      taskId,
      rawStatus: "closed",
      message: buildScopeGuardMessage("summary", "Task archived.", {
        taskId,
        rawStatus: "closed",
      }),
    });
    return;
  }
  if (action === "refine") {
    if (task.status === "approved" || task.status === "merged" || task.status === "closed") {
      sendJson(res, 422, { ok: false, code: "TASK_NOT_REFINABLE", message: `Task ${taskId} cannot be refined because status is ${task.status}.` });
      return;
    }
    const nextStatus: TaskStatus = task.allowedFiles.length > 0 ? "ready" : "planned";
    const suggestion = typeof task.latestReviewSummary?.suggestion === "string"
      ? task.latestReviewSummary.suggestion.trim()
      : "";
    task.status = nextStatus;
    task.resultSummary = suggestion
      ? `[Refine] Review feedback acknowledged: ${suggestion}`
      : "Review feedback acknowledged. Task is ready for another pass.";
    // Clear old review and run state so the next cycle starts fresh
    delete (task as Record<string, unknown>).latestReviewSummary;
    delete (task as Record<string, unknown>).latestRunResult;
    task.updatedAt = new Date().toISOString();
    writeTaskById(gitRoot, taskId, task);
    // Complete any active (pending/claimed) assignments so they don't
    // block the next cycle's dispatch or queue. This includes both
    // execution and review assignments from the previous cycle.
    const allActive = listAssignments(gitRoot).filter((a) => a.taskId === taskId && (a.status === "pending" || a.status === "claimed"));
    for (const activeAssignment of allActive) {
      completeAssignment(gitRoot, activeAssignment.assignmentId);
      console.log("[scopeguard-server] refine: completed lingering assignment " + activeAssignment.assignmentId + " kind=" + activeAssignment.kind + " for task " + taskId);
    }
    sendJson(res, 200, {
      ok: true,
      taskId,
      rawStatus: task.status,
      task: toDesktopTaskDetail(gitRoot, task),
      context: toDesktopTaskContext(gitRoot, task),
      message: buildScopeGuardMessage("summary", "Review feedback acknowledged. The task is ready for another pass.", {
        taskId,
        rawStatus: task.status,
      }),
    });
    return;
  }
  if (action === "handoff") {
    const bodyText = await readRequestBody(req);
    let target = "codex";
    if (bodyText.trim().length > 0) {
      try {
        const payload = JSON.parse(bodyText) as { target?: string };
        if (typeof payload.target === "string" && payload.target.trim().length > 0) {
          target = payload.target.trim();
        }
      } catch {
        // keep default target
      }
    }
    const handoffText = buildDesktopHandoff(gitRoot, task, target);
    sendJson(res, 200, {
      ok: true,
      taskId,
      target,
      handoffText,
      message: buildScopeGuardMessage("handoff", `Handoff for ${target} is ready.`, {
        taskId,
        handoffTarget: target,
        rawStatus: task.status,
      }),
    });
    return;
  }
  if (action === "update-details") {
    const bodyText = await readRequestBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
      return;
    }
    const updatedTask = updateDesktopTaskDetails(gitRoot, task, payload);
    sendJson(res, 200, {
      ok: true,
      taskId,
      task: toDesktopTaskDetail(gitRoot, updatedTask),
      context: toDesktopTaskContext(gitRoot, updatedTask),
      message: buildScopeGuardMessage("summary", "Task details updated.", { taskId, rawStatus: updatedTask.status }),
    });
    return;
  }
  sendJson(res, 404, { ok: false, code: "INVALID_REQUEST", message: `Unknown desktop task action: ${action}` });
}

// ── External API Handlers ──

function handleGetDesktopExternalDiscovery(res: ServerResponse): void {
  sendJson(res, 200, {
    protocol: "scopeguard-external-v1",
    protocolVersions: ["scopeguard-external-v1"],
    server: {
      name: "ScopeGuard",
      version: "0.4.1",
      note: "Base URL is the host serving this ScopeGuard server. In development this is typically http://localhost:3000 or the port you started the server on.",
      hint: "Extract the base URL from window.location in the browser, or from the environment variable SCOPEGUARD_PORT.",
    },
    capabilities: {
      taskHandoff: true,
      externalRunReporting: true,
      reviewReporting: true,
      sessionInit: true,
      heartbeat: true,
      connectedExecutor: true,
    },
    endpoints: {
      initialize: {
        method: "POST",
        path: "/api/desktop/external/initialize",
        description: "Establish a session. Required: clientName. Optional: clientVersion, protocolVersion, executorId, mode.",
        body: "DesktopExternalInitRequest { clientName: string; clientVersion?: string; protocolVersion?: string; executorId?: string; mode?: 'connected' }",
        response: "DesktopExternalInitResponse { ok: true; sessionId: string; acceptedProtocolVersion: string; serverCapabilities: {...}; availableEndpoints: string[]; heartbeatIntervalMs: number }",
      },
      ping: {
        method: "POST",
        path: "/api/desktop/external/ping",
        description: "Lightweight heartbeat to keep a session alive. Required: sessionId. Optional: clientName.",
        body: "DesktopExternalPingRequest { sessionId: string; clientName?: string }",
        response: "DesktopExternalPingResponse { ok: true; serverTime: string; sessionId: string }",
      },
      taskHandoff: {
        method: "GET",
        path: "/api/desktop/tasks/{taskId}/handoff",
        description: "Returns full task handoff payload (goal, allowedFiles, forbiddenFiles, acceptanceCriteria, commands, projectMemory, recentContext). Use to get full task context.",
        response: "DesktopTaskHandoff",
      },
      externalRunStart: {
        method: "POST",
        path: "/api/desktop/tasks/{taskId}/external-run/start",
        description: "Create a connected run record. Required: executorId, externalSessionId. Returns 409 if task already has an active run.",
        body: "DesktopExternalRunStart { executorId: string; externalSessionId: string; sessionId?: string }",
        response: "DesktopTaskRunRecord (status: starting)",
      },
      externalRunFinish: {
        method: "POST",
        path: "/api/desktop/tasks/{taskId}/external-run/finish",
        description: "Mark a connected run as succeeded or failed. Advances task status. Writes latestRunResult and latestReviewSummary.",
        body: "DesktopExternalRunFinish { executorId: string; externalSessionId: string; success: boolean; stdout?: string; stderr?: string; resultSummary?: string; changedFiles?: string[]; exitCode?: number; sessionId?: string }",
        response: "DesktopTaskRunRecord (status: succeeded | failed)",
      },
      externalReview: {
        method: "POST",
        path: "/api/desktop/tasks/{taskId}/external-review",
        description: "Submit a structured review for a task. Can advance task to needs_review.",
        body: "DesktopExternalReview { executorId: string; externalSessionId: string; status: 'ready_for_review' | 'needs_attention'; suggestion: string; sessionId?: string }",
        response: "DesktopTaskReviewSummary",
      },
    },
    types: {
      DesktopExecutorId: '"codex-cli" | "claude-cli"',
      DesktopTaskRunStatus: '"starting" | "running" | "succeeded" | "failed"',
      DesktopLaunchMode: '"managed" | "connected"',
    },
    usage: {
      description: "A connected executor integration follows this 7-step flow:",
      steps: [
        "1. GET /api/desktop/external/discovery — discover capabilities and endpoints",
        "2. POST /api/desktop/external/initialize — establish a session, receive sessionId",
        "3. GET /api/desktop/tasks/{taskId}/handoff — fetch full task context (recommended)",
        "4. POST /api/desktop/tasks/{taskId}/external-run/start — register a run, receive runId",
        "5. Execute the task in your external tool (Codex, Claude CLI, custom MCP bridge, etc.)",
        "6. POST /api/desktop/tasks/{taskId}/external-run/finish — report results back to ScopeGuard",
        "7. POST /api/desktop/external/ping — heartbeat to keep session alive (recommended every 30s)",
      ],
      optional: "An external-review step can follow step 6 for structured feedback.",
    },
  });
}

async function handlePostDesktopExternalInitialize(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { clientName?: string; clientVersion?: string; protocolVersion?: string; executorId?: string; mode?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  if (!payload.clientName || typeof payload.clientName !== "string" || !payload.clientName.trim()) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "clientName is required and must be a non-empty string." });
    return;
  }
  const SUPPORTED_PROTOCOL_VERSIONS = ["scopeguard-external-v1"];
  const requestedVersion = payload.protocolVersion && typeof payload.protocolVersion === "string"
    ? payload.protocolVersion
    : "scopeguard-external-v1";
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    sendJson(res, 409, {
      ok: false,
      code: "UNSUPPORTED_PROTOCOL_VERSION",
      message: `Unsupported protocol version: "${requestedVersion}". Supported versions: [${SUPPORTED_PROTOCOL_VERSIONS.map((v) => `"${v}"`).join(", ")}].`,
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    });
    return;
  }
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const session = {
    sessionId,
    clientName: payload.clientName.trim(),
    clientVersion: payload.clientVersion && typeof payload.clientVersion === "string" ? payload.clientVersion : null,
    protocolVersion: requestedVersion,
    executorId: payload.executorId && typeof payload.executorId === "string" ? payload.executorId : null,
    mode: "connected",
    heartbeatIntervalMs: 30000,
    status: "connected",
    createdAt: now,
    lastSeenAt: now,
  };
  writeExternalSession(gitRoot, session);
  sendJson(res, 200, {
    ok: true,
    sessionId,
    acceptedProtocolVersion: requestedVersion,
    serverCapabilities: {
      taskHandoff: true,
      externalRunReporting: true,
      reviewReporting: true,
      sessionInit: true,
      heartbeat: true,
      connectedExecutor: true,
    },
    availableEndpoints: [
      "/api/desktop/external/discovery",
      "/api/desktop/external/initialize",
      "/api/desktop/external/ping",
      "/api/desktop/tasks/{taskId}/handoff",
      "/api/desktop/tasks/{taskId}/external-run/start",
      "/api/desktop/tasks/{taskId}/external-run/finish",
      "/api/desktop/tasks/{taskId}/external-review",
    ],
    heartbeatIntervalMs: 30000,
    message: "Session established. Please include sessionId in subsequent calls via the sessionId field.",
  });
}

async function handlePostDesktopExternalPing(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { sessionId?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  if (!payload.sessionId || typeof payload.sessionId !== "string") {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "sessionId is required." });
    return;
  }
  const found = touchExternalSession(gitRoot, payload.sessionId);
  if (!found) {
    sendJson(res, 404, { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found or expired: " + payload.sessionId });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    serverTime: new Date().toISOString(),
    sessionId: payload.sessionId,
    message: "pong",
  });
}

// ── Connect Artifact Handler ──

function handleGetConnectArtifact(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): void {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const token = readOrGenerateExternalApiToken(gitRoot);
  const artifact = ensureProjectConnectArtifacts(gitRoot, project, token);

  sendJson(res, 200, {
    ok: true,
    projectId,
    envFile: artifact.envFile,
    jsonFile: artifact.jsonFile,
    envContent: artifact.envContent,
    jsonConfig: artifact.jsonConfig,
    token,
    baseUrl: artifact.baseUrl,
  });
}

async function handlePostDesktopProjectBatchQueue(gitRoot: string, projectId: string, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const allTasks = readAllTasks(gitRoot).filter((task) => task.projectId === projectId);
  const queued: string[] = [];
  const skipped: Array<{ taskId: string; title: string; code: string; message: string }> = [];

  for (const task of allTasks) {
    // Skip tasks not in "ready" status or that are drafts
    if (task.status !== "ready") continue;
    if (task.id.startsWith("DRAFT-")) continue;

    // Check dispatch readiness: executor assigned + client online
    const dispatchInfo = resolveTaskDispatchInfo(gitRoot, task);
    if (dispatchInfo.status !== "ready") {
      let msg: string;
      if (dispatchInfo.status === "no_client") {
        msg = `Executor "${dispatchInfo.assignedExecutor}" has no client connected.`;
      } else if (dispatchInfo.status === "idle") {
        msg = `Executor "${dispatchInfo.assignedExecutor}" is not online.`;
      } else {
        msg = "Task is not dispatch-ready.";
      }
      skipped.push({ taskId: task.id, title: task.title, code: "NOT_DISPATCH_READY", message: msg });
      continue;
    }

    // Attempt via queueSingleTask (checks executor, duplicates, dependsOn)
    const result = queueSingleTask(gitRoot, task.id, task);
    if (result.ok) {
      queued.push(task.id);
    } else {
      skipped.push({ taskId: task.id, title: task.title, code: result.code, message: result.message });
    }
  }

  sendJson(res, 200, {
    ok: true,
    queued,
    skipped,
    summary: {
      queuedCount: queued.length,
      skippedCount: skipped.length,
      totalEligible: allTasks.filter((t) => t.status === "ready" && !t.id.startsWith("DRAFT-")).length,
    },
  });
}

async function handlePostDesktopProjectBatchCancel(gitRoot: string, projectId: string, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const allTasks = readAllTasks(gitRoot).filter((task) => task.projectId === projectId);
  const taskIds = new Set(allTasks.map((t) => t.id));
  const canceled: string[] = [];
  const skipped: Array<{ taskId: string; message: string }> = [];

  // Scan all assignments; cancel active execution ones belonging to this project's tasks
  const allAssignments = listAssignments(gitRoot);
  for (const a of allAssignments) {
    if (a.kind !== "execution") continue;
    if (a.status !== "pending" && a.status !== "claimed") continue;
    if (!a.taskId || !taskIds.has(a.taskId)) continue;
    // Reuse the existing single-assignment cancel logic
    const result = cancelAssignment(gitRoot, a.assignmentId);
    if (result && result.status === "canceled") {
      canceled.push(a.taskId);
    } else {
      skipped.push({ taskId: a.taskId, message: result ? "Cancel returned unexpected status: " + result.status : "Assignment not found during cancel" });
    }
  }

  sendJson(res, 200, {
    ok: true,
    canceled,
    skipped,
    summary: {
      canceledCount: canceled.length,
      skippedCount: skipped.length,
    },
  });
}

function ensureProjectConnectArtifacts(
  gitRoot: string,
  project: DesktopProject,
  token: string,
): { envFile: string; jsonFile: string; envContent: string; jsonConfig: Record<string, unknown>; baseUrl: string } {
  const rootPath = normalizeSlashes(project.rootPath);
  const portStr = process.env.SCOPEGUARD_PORT || "3737";
  const baseUrl = `http://127.0.0.1:${portStr}`;
  const envContent = [
    `# ScopeGuard project-local MCP bridge configuration`,
    `# Generated for: ${rootPath}`,
    `# Project: ${project.name}`,
    ``,
    `SCOPEGUARD_BASE_URL=${baseUrl}`,
    `SCOPEGUARD_TOKEN=${token}`,
    `SCOPEGUARD_EXECUTOR_ID=claude-cli`,
    ``,
    `# Pass these env vars to the MCP bridge script:`,
    `#   node scripts/scopeguard-mcp-bridge.js`,
    `# Or configure in Claude Desktop MCP config as env block.`,
  ].join("\n") + "\n";

  const connectDir = dataPath(gitRoot, "desktop");
  mkdirSync(connectDir, { recursive: true });
  const envPath = join(connectDir, "connect-claude-cli.env");
  writeFileSync(envPath, envContent, "utf-8");

  const jsonConfig = {
    command: "node",
    args: [normalizeSlashes(resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "scripts", "scopeguard-mcp-bridge.js"))],
    env: {
      SCOPEGUARD_BASE_URL: baseUrl,
      SCOPEGUARD_TOKEN: token,
      SCOPEGUARD_EXECUTOR_ID: "claude-cli",
    },
    description: `ScopeGuard MCP bridge for project: ${project.name}`,
  };
  const jsonPath = join(connectDir, "claude-desktop-mcp.json");
  writeFileSync(jsonPath, JSON.stringify(jsonConfig, null, 2) + "\n", "utf-8");
  return {
    envFile: normalizeSlashes(envPath),
    jsonFile: normalizeSlashes(jsonPath),
    envContent,
    jsonConfig,
    baseUrl,
  };
}

function readOrGenerateExternalApiToken(gitRoot: string): string {
  const tokenPath = dataPath(gitRoot, "config", "external-api-token.json");
  if (existsSync(tokenPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tokenPath, "utf-8")) as { token?: string };
      if (parsed.token && typeof parsed.token === "string" && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch { /* fall through to generate */ }
  }
  const { randomUUID } = require("node:crypto");
  const newToken = randomUUID() + "-" + randomUUID();
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: newToken }, null, 2) + "\n", "utf-8");
  return newToken;
}

// ── Project Plan Handler ──

async function handlePostDesktopProjectPlan(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const bodyText = await readRequestBody(req);
  let userGoal = "";
  try {
    const payload = JSON.parse(bodyText);
    userGoal = typeof payload.userGoal === "string" ? payload.userGoal.trim() : "";
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  if (!userGoal) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "userGoal is required." });
    return;
  }

  try {
    const planAttempt = await requestProjectPlan(gitRoot, project, userGoal);
    const rawText = planAttempt.rawText.trim();
    const planningData = extractPlanningPayload(rawText);
    const toProposalItem = (pt: RawPlanningTask, index: number): DesktopTaskListItem => {
      const normalized = normalizePlanTask(pt);
      return {
        id: `IMPORTED-${Date.now()}-${index}`,
        projectId,
        title: normalized.title || `Proposal task ${index + 1}`,
        subtitle: normalized.goal || normalized.title || "Proposal item",
        status: "Draft",
        rawStatus: "planned" as CoreTaskStatus,
        riskLevel: "medium",
        updatedAt: new Date().toISOString(),
        hasConversation: false,
        preferredExecutor: (normalized.preferredExecutor ?? null) as DesktopExecutorId | null,
        assignedExecutor: (normalized.assignedExecutor ?? normalized.preferredExecutor ?? null) as DesktopExecutorId | null,
        goal: normalized.goal || normalized.title || "",
        allowedFiles: normalized.allowedFiles ?? [],
        acceptanceCriteria: normalized.acceptanceCriteria ?? [],
        commands: normalized.commands ?? [],
        dependsOn: normalized.dependsOn ?? [],
        priority: normalized.priority ?? "medium",
        parallelizable: normalized.parallelizable ?? false,
        reviewAssignmentStatus: "none",
        reviewStatus: "none",
      };
    };
    if (!planningData || !Array.isArray(planningData.tasks) || planningData.tasks.length === 0) {
      sendJson(res, 200, {
        ok: true,
        plan: rawText.slice(0, 1000),
        tasks: [toProposalItem({ title: userGoal, goal: userGoal }, 0)],
        planSource: "fallback",
        plannerError: planAttempt.error,
      });
      return;
    }
    const createdTasks = planningData.tasks
      .map((rawPt, index) => toProposalItem(rawPt as RawPlanningTask, index))
      .filter((task) => Boolean(task.title));
    if (createdTasks.length === 0) {
      sendJson(res, 200, {
        ok: true,
        plan: rawText.slice(0, 1000),
        tasks: [toProposalItem({ title: userGoal, goal: userGoal }, 0)],
        planSource: "fallback",
        plannerError: planAttempt.error,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      plan: rawText.slice(0, 1000),
      tasks: createdTasks,
      planSource: planAttempt.source,
      plannerError: planAttempt.error,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      code: "PLAN_FAILED",
      message: `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ── NEW: Commit Plan Handler ──

async function handlePostDesktopProjectCommitPlan(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { tasks?: RawPlanningTask[] };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const rawTasks = payload.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "tasks array is required and must not be empty." });
    return;
  }
  const committed: TaskRecord[] = [];
  const errors: { title?: string; error: string }[] = [];
  for (const rawTask of rawTasks) {
    try {
      const normalized = normalizePlanTask(rawTask);
      const formalTask = createFormalTaskFromPlanTask(gitRoot, projectId, normalized);
      committed.push(formalTask);
    } catch (err) {
      errors.push({
        title: rawTask.title ?? "(untitled)",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  sendJson(res, 200, { ok: true, committed, errors, projectId });
}

// ── NEW: Delete Draft Task Handler ──

async function handlePostDesktopProjectNormalizePlan(gitRoot: string, projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { tasks?: RawPlanningTask[] };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const rawTasks = payload.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "tasks array is required and must not be empty." });
    return;
  }
  const tasks = rawTasks.map((task) => normalizePlanTask(task));
  const readiness = computeProposalReadiness(tasks);
  sendJson(res, 200, { ok: true, projectId, tasks, readiness });
}

function handleDeleteDesktopDraftTask(gitRoot: string, taskId: string, res: ServerResponse): void {
  const draftPath = getDesktopDraftTaskPath(gitRoot, taskId);
  console.log("[scopeguard-server] delete draft: taskId=" + taskId + " path=" + draftPath + " exists=" + existsSync(draftPath));
  if (!existsSync(draftPath)) {
    console.log("[scopeguard-server] delete draft: NOT_FOUND taskId=" + taskId);
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: "Draft task not found: " + taskId });
    return;
  }
  try {
    rmSync(draftPath, { force: true });
    console.log("[scopeguard-server] delete draft: DELETED taskId=" + taskId);
    sendJson(res, 200, { ok: true, taskId: taskId });
  } catch (err) {
    console.log("[scopeguard-server] delete draft: ERROR taskId=" + taskId + " err=" + (err instanceof Error ? err.message : String(err)));
    sendJson(res, 500, {
      ok: false,
      code: "DELETE_FAILED",
      message: "Failed to delete draft task: " + (err instanceof Error ? err.message : String(err)),
    });
  }
}

// ── NEW: Delete All Project Drafts Handler ──

async function handleDeleteDesktopProjectDrafts(gitRoot: string, projectId: string, res: ServerResponse): Promise<void> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const drafts = readDesktopDraftTasks(gitRoot, projectId);
  let deletedCount = 0;
  for (const draft of drafts) {
    const draftPath = getDesktopDraftTaskPath(gitRoot, draft.id);
    try {
      if (existsSync(draftPath)) {
        rmSync(draftPath, { force: true });
        deletedCount++;
      }
    } catch {
      // skip individual delete failures
    }
  }
  sendJson(res, 200, { ok: true, projectId, deletedCount });
}

// ── NEW: normalizePlanTask ──

type ProjectPlanAttempt = {
  source: "local-llm" | "claude-cli";
  rawText: string;
  error?: string;
};

async function requestProjectPlan(gitRoot: string, project: DesktopProject, userGoal: string): Promise<ProjectPlanAttempt> {
  const prompts = buildPlanningPrompts(project, userGoal);
  const localAttempt = await requestProjectPlanWithLocalLLM(gitRoot, prompts.systemPrompt, prompts.rawPrompt);
  if (localAttempt?.rawText && extractPlanningPayload(localAttempt.rawText)) {
    return localAttempt;
  }

  const cliAttempt = requestProjectPlanWithClaudeCli(gitRoot, prompts.rawPrompt);
  if (cliAttempt?.rawText && extractPlanningPayload(cliAttempt.rawText)) {
    return localAttempt?.error
      ? { ...cliAttempt, error: `Local LLM failed first: ${localAttempt.error}` }
      : cliAttempt;
  }

  const error = [localAttempt?.error, cliAttempt?.error].filter(Boolean).join(" | ");
  return {
    source: localAttempt?.rawText ? localAttempt.source : (cliAttempt?.source ?? "local-llm"),
    rawText: localAttempt?.rawText || cliAttempt?.rawText || "",
    error: error || "No structured planning payload returned.",
  };
}

function buildPlanningPrompts(project: DesktopProject, userGoal: string): { systemPrompt: string; rawPrompt: string } {
  const systemPrompt = [
    "You are ScopeGuard's project planner.",
    "Create a structured plan proposal for a coding project.",
    "Return only valid JSON. No markdown, no commentary.",
    "Every task must be concrete enough to become a ScopeGuard task.",
  ].join(" ");
  const rawPrompt = [
    "Return this JSON object:",
    "{",
    '  "summary": "One sentence plan summary",',
    '  "tasks": [',
    "    {",
    '      "title": "Short task title",',
    '      "goal": "Concrete task goal",',
    '      "allowedFiles": ["README.md"],',
    '      "acceptanceCriteria": ["Observable acceptance criterion"],',
    '      "commands": ["git diff -- README.md"],',
    '      "preferredExecutor": "claude-cli",',
    '      "assignedExecutor": "claude-cli",',
    '      "dependsOn": [],',
    '      "parallelizable": false,',
    '      "priority": "medium"',
    "    }",
    "  ]",
    "}",
    "",
    "Planning rules:",
    "- Prefer 1-5 tasks. Use one task for a small single-file goal.",
    "- Infer explicit filenames from the user goal into allowedFiles.",
    "- Include acceptanceCriteria for every task.",
    "- Include a lightweight verification command when possible.",
    "- Use claude-cli for normal editing/docs tasks unless the goal explicitly requests codex.",
    "- Use dependsOn as task titles only when a real dependency exists.",
    "",
    `Project: ${project.name}`,
    `Goal: ${userGoal}`,
  ].join("\n");
  return { systemPrompt, rawPrompt };
}

async function requestProjectPlanWithLocalLLM(gitRoot: string, systemPrompt: string, rawPrompt: string): Promise<ProjectPlanAttempt | null> {
  const aiConfig = resolveEffectiveAIConfig(gitRoot);
  try {
    if (aiConfig.provider === "codex-account") {
      return { source: "local-llm", rawText: requestCodexCliAssistant(aiConfig, systemPrompt, rawPrompt) };
    }
    const rawText = aiConfig.provider === "anthropic"
      ? await requestAnthropicCompatible(aiConfig, systemPrompt, rawPrompt)
      : await requestOpenAICompatible(aiConfig, systemPrompt, rawPrompt);
    return { source: "local-llm", rawText };
  } catch (err) {
    return { source: "local-llm", rawText: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function requestProjectPlanWithClaudeCli(gitRoot: string, planningPrompt: string): ProjectPlanAttempt | null {
  const executor = resolveExecutorAdapter(gitRoot, "claude-cli");
  if (!executor) {
    return { source: "claude-cli", rawText: "", error: "Claude CLI executor not available." };
  }
  try {
    const cli = resolveCliCommand(executor.command, ["-p", planningPrompt]);
    const result = runCliSync(gitRoot, cli, executor.buildEnv(gitRoot), 1000 * 60 * 3);
    if (result.status !== 0 || result.error) {
      const errText = result.stderr || result.stdout || (result.error ? result.error.message : "") || `Claude CLI exited with status ${result.status}`;
      return { source: "claude-cli", rawText: result.stdout ?? "", error: errText.slice(0, 500) };
    }
    return { source: "claude-cli", rawText: (result.stdout ?? "").trim() };
  } catch (err) {
    return { source: "claude-cli", rawText: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizePlanTask(task: RawPlanningTask): NormalizedPlanningTask {
  const title = task.title ?? "";
  const goal = task.goal ?? task.title ?? "";
  const combinedText = `${title} ${goal}`.toLowerCase();

  // Extract explicit file paths from goal text
  const explicitPaths = extractExplicitPaths(`${title} ${goal}`);

  // Build inferred allowed files
  const inferredAllowed = new Set<string>([
    ...sanitizeStringArray(task.allowedFiles),
    ...explicitPaths,
  ]);

  // Keyword matching
  if (/\bREADME\b/i.test(combinedText) || /\breadme\b/.test(combinedText)) {
    inferredAllowed.add("README.md");
    inferredAllowed.add("README.zh-CN.md");
  }
  if (/\bfrontend\b/i.test(combinedText) || /\bui\b/i.test(combinedText) || /\bhomepage\b/.test(combinedText) || /\bhome page\b/.test(combinedText)) {
    inferredAllowed.add("apps/web/static/**");
  }
  if (/\bserver\b/i.test(combinedText) || /\bbackend\b/i.test(combinedText) || /\bapi\b/i.test(combinedText)) {
    inferredAllowed.add("apps/server/src/**");
  }
  if (/\bdoc\b/i.test(combinedText)) {
    inferredAllowed.add("docs/**");
  }

  const allowedFiles = [...inferredAllowed];
  const hasFiles = allowedFiles.length > 0;
  const acceptanceCriteria = sanitizeStringArray(task.acceptanceCriteria);
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push("The task goal is implemented without unrelated changes.");
    acceptanceCriteria.push(hasFiles
      ? "The final diff stays within the allowed file scope."
      : "The implementation is small enough to review before execution.");
  }

  let commands = sanitizeStringArray(task.commands);
  if (commands.length === 0 && hasFiles) {
    if (allowedFiles.some((pattern) => /^README(?:\.|$)/i.test(pattern))) {
      commands = ["git diff -- " + allowedFiles.filter((pattern) => !pattern.includes("*")).join(" ")];
    } else if (allowedFiles.some((pattern) => pattern.startsWith("apps/web/static"))) {
      commands = ["node --check apps/web/static/app.js"];
    } else if (allowedFiles.some((pattern) => pattern.startsWith("apps/server/src"))) {
      commands = ["pnpm --filter @scopeguard/server typecheck"];
    } else if (allowedFiles.some((pattern) => pattern.endsWith(".md"))) {
      commands = ["git diff -- " + allowedFiles.filter((pattern) => !pattern.includes("*")).join(" ")];
    }
  }

  // Default executor: claude-cli unless text mentions "codex"
  let preferredExecutor = task.preferredExecutor ?? "claude-cli";
  if (/\bcodex\b/i.test(combinedText) && (!task.preferredExecutor || task.preferredExecutor === "claude-cli")) {
    preferredExecutor = "codex-cli";
  }

  const assignedExecutor = task.assignedExecutor ?? preferredExecutor;

  return {
    title,
    goal,
    allowedFiles,
    acceptanceCriteria,
    commands,
    preferredExecutor,
    assignedExecutor,
    dependsOn: task.dependsOn ?? [],
    parallelizable: task.parallelizable ?? false,
    priority: task.priority ?? "medium",
  };
}


/**
 * Proposal task readiness.
 *
 * Schema tiers:
 *   Required:      title, goal
 *   Strongly expected: allowedFiles, acceptanceCriteria, preferredExecutor
 *   Optional:      commands, assignedExecutor, dependsOn, parallelizable, priority
 */
type ProposalTaskReadiness = "ready" | "needs-review" | "too-vague";

type ProposalTaskReadinessResult = {
  readiness: ProposalTaskReadiness;
  missingStrong: string[];
  missingOptional: string[];
  hint: string;
};

function computeProposalTaskReadiness(task: RawPlanningTask | NormalizedPlanningTask): ProposalTaskReadinessResult {
  const hasTitle = typeof task.title === "string" && task.title.trim().length > 0;
  const hasGoal = typeof task.goal === "string" && task.goal.trim().length > 0;
  const hasFiles = Array.isArray(task.allowedFiles) && task.allowedFiles.length > 0;
  const hasCriteria = Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0;
  const hasExecutor = typeof task.preferredExecutor === "string" && task.preferredExecutor.length > 0;
  const hasCommands = Array.isArray(task.commands) && task.commands.length > 0;

  const missingStrong: string[] = [];
  const missingOptional: string[] = [];

  if (!hasFiles) missingStrong.push("allowedFiles (file scope)");
  if (!hasCriteria) missingStrong.push("acceptanceCriteria");
  if (!hasExecutor) missingStrong.push("preferredExecutor");
  if (!hasCommands) missingOptional.push("commands (auto-fillable)");

  // Too vague: barely any structural fields beyond title
  if (!hasFiles && !hasCriteria && !hasExecutor && !hasCommands) {
    return {
      readiness: "too-vague",
      missingStrong,
      missingOptional,
      hint: "This task lacks file scope, criteria, executor, and commands. Refine before committing.",
    };
  }

  // Needs review: missing at least one strongly expected field
  if (missingStrong.length > 0) {
    return {
      readiness: "needs-review",
      missingStrong,
      missingOptional,
      hint: "Missing: " + missingStrong.join(", ") + ". These can often be auto-filled.",
    };
  }

  // Ready to commit
  return {
    readiness: "ready",
    missingStrong: [],
    missingOptional,
    hint: hasCommands ? "All required fields present." : "Missing optional fields (commands) — will be auto-filled on commit.",
  };
}

/**
 * Aggregated proposal readiness across all proposal tasks.
 */
type ProposalReadiness = "ready-to-commit" | "needs-review" | "too-vague";

type ProposalReadinessResult = {
  readiness: ProposalReadiness;
  taskResults: ProposalTaskReadinessResult[];
  summary: string;
};

function computeProposalReadiness(tasks: (RawPlanningTask | NormalizedPlanningTask)[]): ProposalReadinessResult {
  if (tasks.length === 0) {
    return { readiness: "too-vague" as ProposalReadiness, taskResults: [], summary: "No tasks in proposal." };
  }

  const taskResults = tasks.map(computeProposalTaskReadiness);
  const anyTooVague = taskResults.some(function (r) { return r.readiness === "too-vague"; });
  const anyNeedsReview = taskResults.some(function (r) { return r.readiness === "needs-review"; });
  const allReady = taskResults.every(function (r) { return r.readiness === "ready"; });

  let readiness: ProposalReadiness;
  let summary: string;

  if (anyTooVague) {
    const count = taskResults.filter(function (r) { return r.readiness === "too-vague"; }).length;
    readiness = "too-vague";
    summary = String(count) + " task(s) are too vague \u2014 refine before committing.";
  } else if (anyNeedsReview) {
    const count = taskResults.filter(function (r) { return r.readiness === "needs-review"; }).length;
    readiness = "needs-review";
    summary = String(count) + " task(s) need review \u2014 missing scope, criteria, or executor.";
  } else if (allReady) {
    readiness = "ready-to-commit";
    const missingCmd = taskResults.some(function (r) { return r.missingOptional.length > 0; });
    summary = missingCmd
      ? "All required fields present. Commands will be auto-filled on commit."
      : "Proposal is ready to commit.";
  } else {
    readiness = "needs-review";
    summary = "Some tasks need review.";
  }

  return { readiness: readiness, taskResults: taskResults, summary: summary };
}

// ── createFormalTaskFromPlanTask ──


function createFormalTaskFromPlanTask(gitRoot: string, projectId: string, task: NormalizedPlanningTask): TaskRecord {
  const id = `TASK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const taskDir = dataPath(gitRoot, "tasks", id);
  const taskPath = join(taskDir, "task.json");

  const taskRecord: TaskRecord = {
    id,
    projectId,
    requirementId: "plan-commit",
    title: task.title,
    description: task.goal,
    status: "ready",
    agentType: "fullstack",
    allowedFiles: task.allowedFiles,
    lockedFiles: [...task.allowedFiles],
    forbiddenFiles: [...DEFAULT_DESKTOP_FORBIDDEN_FILES],
    dependencies: task.dependsOn,
    acceptanceCriteria: task.acceptanceCriteria,
    commands: task.commands,
    riskLevel: "medium",
    branchName: null,
    worktreePath: null,
    diffPath: null,
    testLogPath: null,
    resultSummary: null,
    createdAt: now,
    updatedAt: now,
    preferredExecutor: task.preferredExecutor,
    assignedExecutor: task.assignedExecutor ?? undefined,
    dependsOn: task.dependsOn,
    parallelizable: task.parallelizable,
    priority: task.priority,
  };

  mkdirSync(taskDir, { recursive: true });
  writeFileSync(taskPath, `${JSON.stringify(taskRecord, null, 2)}\n`, "utf-8");

  return taskRecord;
}

// ── Plan extraction helper ──

function extractPlanningPayload(text: string): { tasks: Array<Record<string, unknown>> } | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        return parsed;
      }
      if (Array.isArray(parsed)) {
        return { tasks: parsed };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ── Test: Simulate Needs Attention (dev-only) ──

function handlePostSimulateNeedsAttention(gitRoot: string, taskId: string, res: ServerResponse): void {
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  if (task.status === "approved" || task.status === "merged" || task.status === "closed") {
    sendJson(res, 422, { ok: false, code: "TASK_INVALID_STATE", message: `Cannot simulate needs_attention on task with status ${task.status}.` });
    return;
  }
  console.log("[scopeguard-server] simulate-needs-attention: taskId=" + taskId + " status=" + task.status + " title=" + task.title);
  task.status = "blocked";
  task.resultSummary = "[Test] Reviewer requested changes: README needs clearer installation guidance before approval.";
  (task as Record<string, unknown>).latestReviewSummary = {
    reviewId: "test-review-" + Date.now(),
    taskId,
    runId: null,
    status: "needs_attention",
    runSucceeded: null,
    changedFileCount: 0,
    hasAcceptanceCriteria: task.acceptanceCriteria.length > 0,
    hasCommands: task.commands.length > 0,
    suggestion: "Test review: README needs clearer installation guidance before approval.",
    createdAt: new Date().toISOString(),
  };
  task.updatedAt = new Date().toISOString();
  writeTaskById(gitRoot, taskId, task);
  console.log("[scopeguard-server] simulate-needs-attention: DONE taskId=" + taskId + " newStatus=blocked");
  sendJson(res, 200, { ok: true, taskId, task: toDesktopTaskDetail(gitRoot, task) });
}

// ── Task Run Handlers ──

function handleGetDesktopTaskRuns(gitRoot: string, taskId: string, res: ServerResponse): void {
  const runs = listTaskRuns(gitRoot, taskId);
  sendJson(res, 200, { taskId, runs });
}

function handleGetDesktopTaskRun(gitRoot: string, taskId: string, runId: string, res: ServerResponse): void {
  const record = readTaskRun(gitRoot, taskId, runId);
  if (!record) {
    sendJson(res, 404, { ok: false, code: "RUN_NOT_FOUND", message: `Run not found: ${runId}` });
    return;
  }
  sendJson(res, 200, { run: record });
}

async function handlePostDesktopTaskRun(gitRoot: string, taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let formalTask = readTaskById(gitRoot, taskId);
  const draftTask = formalTask ? null : readDesktopDraftTaskById(gitRoot, taskId);
  if (!formalTask && !draftTask) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  const checkTaskId = formalTask ? formalTask.id : taskId;
  const activeRuns = listTaskRuns(gitRoot, checkTaskId)
    .filter((r) => r.status === "starting" || r.status === "running");
  if (activeRuns.length > 0) {
    sendJson(res, 409, {
      ok: false,
      code: "RUN_ALREADY_ACTIVE",
      message: `Task already has an active run (${activeRuns[0]?.executorId ?? "unknown"}). Wait for it to finish before starting a new one.`,
    });
    return;
  }
  const bodyText = await readRequestBody(req);
  let payload: { executorId?: string; userText?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const executorId = typeof payload.executorId === "string" ? payload.executorId : "";
  const userText = typeof payload.userText === "string" ? payload.userText.trim() : "";
  const executor = resolveExecutorAdapter(gitRoot, executorId);
  if (!executor) {
    sendJson(res, 400, { ok: false, code: "UNKNOWN_EXECUTOR", message: `Unknown executor: ${executorId}` });
    return;
  }
  const taskForRun = formalTask ?? draftTask!;
  const args = executor.buildArgs({
    title: taskForRun.title,
    description: taskForRun.description,
    acceptanceCriteria: formalTask ? formalTask.acceptanceCriteria : [],
    commands: formalTask ? formalTask.commands : [],
    preferredExecutor: formalTask?.preferredExecutor ?? draftTask?.preferredExecutor,
    userText: userText || undefined,
  });
  const env = executor.buildEnv(gitRoot);
  const cli = resolveCliCommand(executor.command, args);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnCli(gitRoot, cli, env);
  } catch (spawnErr) {
    sendJson(res, 500, {
      ok: false,
      code: "SPAWN_FAILED",
      message: `Failed to start ${executor.displayName}: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
    });
    return;
  }
  const runId = randomUUID();
  const now = new Date().toISOString();
  const record: DesktopTaskRunRecord = {
    runId,
    taskId: formalTask ? formalTask.id : taskId,
    executorId: executor.id,
    status: "starting",
    startedAt: now,
    finishedAt: null,
    stdout: "",
    stderr: "",
    exitCode: null,
    resultSummary: null,
    changedFiles: [],
    launchMode: "managed",
    externalSessionId: null,
  };
  writeTaskRun(gitRoot, record);

  let spawnErrMsg = "";
  let stdout = "";
  let stderr = "";
  const earlyStdoutListener = (chunk: Buffer): void => {
    stdout += chunk.toString("utf-8");
  };
  const earlyStderrListener = (chunk: Buffer): void => {
    stderr += chunk.toString("utf-8");
  };
  const startupErrorListener = (err: Error): void => {
    spawnErrMsg = err.message ?? String(err);
  };
  child.stdout?.on("data", earlyStdoutListener);
  child.stderr?.on("data", earlyStderrListener);
  child.on("error", startupErrorListener);

  await new Promise((resolve) => setTimeout(resolve, 80));

  if (spawnErrMsg) {
    child.stdout?.off("data", earlyStdoutListener);
    child.stderr?.off("data", earlyStderrListener);
    child.off("error", startupErrorListener);
    record.status = "failed";
    record.finishedAt = new Date().toISOString();
    record.stderr = spawnErrMsg;
    writeTaskRun(gitRoot, record);
    sendJson(res, 500, {
      ok: false,
      code: "SPAWN_FAILED",
      message: `Failed to start ${executor.displayName}: ${spawnErrMsg}`,
    });
    return;
  }

  let effectiveTaskId = taskId;
  let promotedFromDraft: string | undefined;
  if (draftTask && !formalTask) {
    formalTask = promoteDesktopDraftTask(gitRoot, draftTask);
    effectiveTaskId = formalTask.id;
    promotedFromDraft = taskId;
  }

  record.taskId = effectiveTaskId;
  record.status = "running";
  record.stdout = stdout;
  record.stderr = stderr;
  writeTaskRun(gitRoot, record);

  let lastFlush = Date.now();
  function flushRunRecord(): void {
    const t = Date.now();
    if (t - lastFlush < 250) return;
    lastFlush = t;
    writeTaskRun(gitRoot, record);
  }

  child.stdout?.off("data", earlyStdoutListener);
  child.stderr?.off("data", earlyStderrListener);
  child.off("error", startupErrorListener);

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stdout += text;
    record.stdout = stdout;
    flushRunRecord();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderr += text;
    record.stderr = stderr;
    flushRunRecord();
  });

  child.on("close", (code: number | null) => {
    record.status = code === 0 ? "succeeded" : "failed";
    record.exitCode = code;
    record.finishedAt = new Date().toISOString();
    record.stdout = stdout;
    record.stderr = stderr;
    record.resultSummary = buildRunResultSummary(executor.displayName, code === 0, stdout, stderr);
    record.changedFiles = extractChangedFiles(stdout);
    writeTaskRun(gitRoot, record);
    advanceTaskStatusAfterRun(gitRoot, effectiveTaskId, code === 0);
    const taskAfterRun = readTaskById(gitRoot, effectiveTaskId);
    if (taskAfterRun) {
      const review = buildTaskReviewSummary(taskAfterRun, record);
      taskAfterRun.resultSummary = `[Review] ${review.suggestion}`;
      (taskAfterRun as TaskRecord & { latestReviewSummary: unknown }).latestReviewSummary = review;
      (taskAfterRun as TaskRecord & { latestRunResult: unknown }).latestRunResult = {
        runId: record.runId,
        executorId: record.executorId,
        status: record.status,
        exitCode: record.exitCode,
        resultSummary: record.resultSummary,
        changedFiles: record.changedFiles,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      };
      taskAfterRun.updatedAt = new Date().toISOString();
      writeTaskById(gitRoot, effectiveTaskId, taskAfterRun);
    }
  });

  child.on("error", (err: Error) => {
    record.status = "failed";
    record.exitCode = -1;
    record.finishedAt = new Date().toISOString();
    record.stdout = stdout;
    record.stderr = stderr + "\n[run error] " + (err.message ?? String(err));
    record.resultSummary = `${executor.displayName} run failed: ${err.message ?? "unknown error"}`;
    record.changedFiles = [];
    writeTaskRun(gitRoot, record);
    advanceTaskStatusAfterRun(gitRoot, effectiveTaskId, false);
    const taskAfterRun = readTaskById(gitRoot, effectiveTaskId);
    if (taskAfterRun) {
      const review = buildTaskReviewSummary(taskAfterRun, record);
      taskAfterRun.resultSummary = `[Review] ${review.suggestion}`;
      (taskAfterRun as TaskRecord & { latestReviewSummary: unknown }).latestReviewSummary = review;
      (taskAfterRun as TaskRecord & { latestRunResult: unknown }).latestRunResult = {
        runId: record.runId,
        executorId: record.executorId,
        status: record.status,
        exitCode: record.exitCode,
        resultSummary: record.resultSummary,
        changedFiles: record.changedFiles,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      };
      taskAfterRun.updatedAt = new Date().toISOString();
      writeTaskById(gitRoot, effectiveTaskId, taskAfterRun);
    }
  });

  sendJson(res, 200, { ok: true, run: record, promotedFromDraft });
}

// ── External Run Handlers ──

function handleGetDesktopTaskHandoff(gitRoot: string, taskId: string, res: ServerResponse): void {
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  const handoff = buildTaskHandoffPayload(gitRoot, task);
  sendJson(res, 200, { ok: true, taskId, title: task.title, handoff });
}

async function handlePostDesktopExternalRunStart(gitRoot: string, taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { executorId?: string; externalSessionId?: string; sessionId?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  if (!payload.executorId || !payload.externalSessionId) {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "executorId and externalSessionId are required." });
    return;
  }
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  // Verify caller's executor matches the task's assigned executor
  const taskExecutor = resolveEffectiveTaskExecutor(task);
  if (taskExecutor && payload.executorId !== taskExecutor) {
    sendJson(res, 403, { ok: false, code: "EXECUTOR_MISMATCH", message: `Run rejected: task requires executor "${taskExecutor}" but caller is "${payload.executorId}".` });
    return;
  }
  if (payload.sessionId) {
    if (!touchExternalSession(gitRoot, payload.sessionId)) {
      sendJson(res, 404, { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found: " + payload.sessionId });
      return;
    }
  }
  const activeRuns = listTaskRuns(gitRoot, taskId)
    .filter((r) => r.status === "starting" || r.status === "running");
  if (activeRuns.length > 0) {
    sendJson(res, 409, {
      ok: false,
      code: "RUN_ALREADY_ACTIVE",
      message: `Task already has an active run (${activeRuns[0]?.executorId ?? "unknown"}). Wait for it to finish before starting a new one.`,
    });
    return;
  }
  const runId = randomUUID();
  const now = new Date().toISOString();
  const record: DesktopTaskRunRecord = {
    runId,
    taskId,
    executorId: payload.executorId as DesktopExecutorId,
    status: "starting",
    startedAt: now,
    finishedAt: null,
    stdout: "",
    stderr: "",
    exitCode: null,
    resultSummary: null,
    changedFiles: [],
    launchMode: "connected",
    externalSessionId: payload.externalSessionId,
  };
  writeTaskRun(gitRoot, record);
  sendJson(res, 200, { ok: true, run: record });
}

async function handlePostDesktopExternalRunFinish(gitRoot: string, taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: {
    executorId?: string;
    externalSessionId?: string;
    success?: boolean;
    stdout?: string;
    stderr?: string;
    resultSummary?: string;
    changedFiles?: string[];
    exitCode?: number;
    sessionId?: string;
  };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const existingRuns = listTaskRuns(gitRoot, taskId).filter(
    (r) => (r.status === "starting" || r.status === "running") && r.launchMode === "connected" && r.externalSessionId === payload.externalSessionId,
  );
  const run = existingRuns[0];
  if (!run) {
    sendJson(res, 404, { ok: false, code: "RUN_NOT_FOUND", message: `No active connected run found for session: ${payload.externalSessionId}` });
    return;
  }
  if (payload.sessionId) {
    if (!touchExternalSession(gitRoot, payload.sessionId)) {
      sendJson(res, 404, { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found: " + payload.sessionId });
      return;
    }
  }
  run.status = payload.success ? "succeeded" : "failed";
  run.exitCode = payload.exitCode ?? (payload.success ? 0 : 1);
  run.finishedAt = new Date().toISOString();
  if (payload.stdout !== undefined) run.stdout = payload.stdout;
  if (payload.stderr !== undefined) run.stderr = payload.stderr;
  if (payload.resultSummary !== undefined) run.resultSummary = payload.resultSummary;
  if (payload.changedFiles !== undefined) run.changedFiles = payload.changedFiles;
  writeTaskRun(gitRoot, run);
  advanceTaskStatusAfterRun(gitRoot, taskId, payload.success ?? false);
  // Auto-complete the claimed execution assignment now that the run is finished
  try {
    const execAssignments = listAssignments(gitRoot).filter((a) =>
      a.taskId === taskId && a.kind === "execution" && a.status === "claimed"
    );
    if (execAssignments.length > 0) {
      for (const ea of execAssignments) {
        completeAssignment(gitRoot, ea.assignmentId);
      }
    }
  } catch (e) {
    // non-critical — don't fail the run-finish for assignment bookkeeping errors
  }
  const task = readTaskById(gitRoot, taskId);
  if (task) {
    (task as TaskRecord & { latestRunResult: unknown }).latestRunResult = {
      runId: run.runId,
      executorId: run.executorId,
      status: run.status,
      exitCode: run.exitCode,
      resultSummary: run.resultSummary,
      changedFiles: run.changedFiles,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
    const review = buildTaskReviewSummary(task, run);
    task.resultSummary = `[Review] ${review.suggestion}`;
    (task as TaskRecord & { latestReviewSummary: unknown }).latestReviewSummary = review;
    task.updatedAt = new Date().toISOString();
    writeTaskById(gitRoot, taskId, task);
  }
  // Auto-create review assignment if run succeeded and task advanced to needs_review
  if (payload.success) {
    const taskAfterRun = readTaskById(gitRoot, taskId);
    if (taskAfterRun && taskAfterRun.status === "needs_review") {
      // Prevent duplicate: don't create if there's already an active (pending/claimed) review assignment
      const activeReview = findTaskAssignment(gitRoot, taskId, "review");
      if (activeReview) {
        console.log("[scopeguard-server] review assignment already exists: " + activeReview.assignmentId + " for task: " + taskId + " (status=" + activeReview.status + ") — skipping duplicate");
      } else {
        try {
          const reviewHandoff = "Review assignment for: " + taskAfterRun.title + " — evaluate execution result and submit structured review via external-review.";
          const reviewExecutor = resolveEffectiveTaskExecutor(taskAfterRun) || "claude-cli";
          const reviewAssignment = createTaskAssignment(gitRoot, taskId, taskAfterRun.projectId, reviewExecutor, reviewHandoff, "review");
          console.log("[scopeguard-server] auto-created review assignment: " + reviewAssignment.assignmentId + " for task: " + taskId);
        } catch (reviewErr) {
          console.log("[scopeguard-server] auto-create review assignment FAILED: " + (reviewErr instanceof Error ? reviewErr.message : String(reviewErr)));
        }
      }
    }
  }
  sendJson(res, 200, { ok: true, run });
}

async function handlePostDesktopExternalReview(gitRoot: string, taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { executorId?: string; externalSessionId?: string; status?: string; suggestion?: string; sessionId?: string };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  if (payload.sessionId) {
    if (!touchExternalSession(gitRoot, payload.sessionId)) {
      sendJson(res, 404, { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found: " + payload.sessionId });
      return;
    }
  }
  if (payload.status === "ready_for_review" && task.status !== "merged" && task.status !== "closed") {
    task.status = "needs_review";
  } else if (payload.status === "needs_attention") {
    task.status = "blocked";
  }
  task.resultSummary = `[Review] ${payload.suggestion}`;
  task.updatedAt = new Date().toISOString();
  (task as TaskRecord & { latestReviewSummary: unknown }).latestReviewSummary = {
    reviewId: `external-${Date.now()}`,
    taskId,
    runId: null,
    status: payload.status === "ready_for_review" ? "ready_for_review" : "needs_attention",
    runSucceeded: payload.status === "ready_for_review" ? true : null,
    changedFileCount: 0,
    hasAcceptanceCriteria: task.acceptanceCriteria.length > 0,
    hasCommands: task.commands.length > 0,
    suggestion: payload.suggestion ?? "",
    createdAt: new Date().toISOString(),
  };
  writeTaskById(gitRoot, taskId, task);
  sendJson(res, 200, { ok: true, taskId, review: (task as TaskRecord & { latestReviewSummary: unknown }).latestReviewSummary });
}

// ── Project Tasks / Task Detail / Context Handlers ──

function handleGetDesktopProjectTasks(gitRoot: string, projectId: string, res: ServerResponse): void {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    sendJson(res, 404, { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
    return;
  }
  const allTasks = readAllTasks(gitRoot).filter((task) => task.projectId === projectId);
  const activeTasks = allTasks.filter((task) => !["merged", "closed"].includes(task.status));
  const taskItems = activeTasks.map((task) => toDesktopTaskListItem(gitRoot, task));
  const draftTasks = readDesktopDraftTasks(gitRoot, projectId)
    .map((draftTask) => toDesktopTaskListItemFromDraft(gitRoot, draftTask));

  // Compute summary counts across ALL non-draft tasks (including merged/closed)
  let readyToQueue = 0;
  let queued = 0;
  let awaitingReview = 0;
  let blockedByDependency = 0;
  let needsAttention = 0;
  let approved = 0;
  let notReady = 0;

  for (const task of allTasks) {
    if (task.id.startsWith("DRAFT-")) continue; // skip drafts in summary
    const dispatchInfo = resolveTaskDispatchInfo(gitRoot, task);
    const reviewStatus = resolveTaskReviewStatus(task);

    if (task.status === "approved" || task.status === "merged" || task.status === "closed") {
      approved++;
    } else if (reviewStatus === "needs_attention") {
      needsAttention++;
    } else if (task.status === "needs_review") {
      awaitingReview++;
    } else if (dispatchInfo.status === "dispatched") {
      queued++;
    } else if (task.status === "ready") {
      // Check dependsOn FIRST, regardless of dispatch status
      const deps = task.dependsOn ?? [];
      const depBlocked = deps.some((depId) => {
        const depTask = allTasks.find((t) => t.id === depId);
        return depTask && depTask.status !== "approved" && depTask.status !== "merged" && depTask.status !== "closed";
      });
      if (depBlocked) {
        blockedByDependency++;
      } else if (dispatchInfo.status === "ready") {
        readyToQueue++;
      } else {
        notReady++;
      }
    } else {
      notReady++;
    }
  }

  sendJson(res, 200, {
    projectId,
    tasks: draftTasks.concat(taskItems),
    summary: {
      readyToQueue,
      queued,
      awaitingReview,
      blockedByDependency,
      needsAttention,
      approved,
      notReady,
      total: allTasks.filter((t) => !t.id.startsWith("DRAFT-")).length,
    },
  });
}

function handleGetDesktopTask(gitRoot: string, taskId: string, res: ServerResponse): void {
  const task = readTaskById(gitRoot, taskId);
  if (task) {
    sendJson(res, 200, { task: toDesktopTaskDetail(gitRoot, task) });
    return;
  }
  const draftTask = readDesktopDraftTaskById(gitRoot, taskId);
  if (!draftTask) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  sendJson(res, 200, { task: toDesktopTaskDetailFromDraft(gitRoot, draftTask) });
}

function handleGetDesktopTaskContext(gitRoot: string, taskId: string, res: ServerResponse): void {
  const task = readTaskById(gitRoot, taskId);
  if (task) {
    sendJson(res, 200, { context: toDesktopTaskContext(gitRoot, task) });
    return;
  }
  const draftTask = readDesktopDraftTaskById(gitRoot, taskId);
  if (!draftTask) {
    sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` });
    return;
  }
  sendJson(res, 200, { context: toDesktopTaskContextFromDraft(draftTask) });
}

// ── Executor abstraction ──

function resolveExecutorAdapters(gitRoot: string): DesktopExecutorAdapter[] {
  const cfg = readDesktopExecutorConfig(gitRoot);
  const envFn = (workspaceRoot: string): Record<string, string> => {
    const nextEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== "string") continue;
      if (key.toLowerCase() === "npm_config_recursive") continue;
      nextEnv[key] = value;
    }
    nextEnv.PROJECT_ROOT = workspaceRoot;
    return nextEnv;
  };
  const buildArgsFor = (executorId: string) => (task: { title: string; description: string; acceptanceCriteria: string[]; commands: string[]; preferredExecutor?: string; userText?: string }): string[] => {
    const handoff = buildTaskHandoffFromMinimal(gitRoot, task);
    const prompt = buildExecutorHandoffPrompt(handoff, executorId, task.userText);
    return executorId === "codex-cli" ? ["exec", prompt] : ["-p", prompt];
  };
  return [
    {
      id: "codex-cli",
      displayName: "Codex CLI",
      command: cfg.codexCommand || "codex",
      buildArgs: buildArgsFor("codex-cli"),
      buildEnv: envFn,
    },
    {
      id: "claude-cli",
      displayName: "Claude CLI",
      command: cfg.claudeCommand || "claude",
      buildArgs: buildArgsFor("claude-cli"),
      buildEnv: envFn,
    },
  ];
}

function resolveExecutorAdapter(gitRoot: string, executorId: string): DesktopExecutorAdapter | null {
  return resolveExecutorAdapters(gitRoot).find((e) => e.id === executorId) ?? null;
}

// ── Unified task handoff ──

function buildTaskHandoffFromMinimal(
  gitRoot: string,
  task: { title: string; description: string; acceptanceCriteria: string[]; commands: string[]; preferredExecutor?: string; userText?: string },
): DesktopTaskHandoff {
  const project = buildDesktopProject(gitRoot);
  const projectMemory = readDesktopProjectMemory(gitRoot).slice(-5).map((m) => ({ title: m.title, content: m.content }));
  return {
    taskId: "",
    title: task.title,
    goal: task.description,
    allowedFiles: [],
    forbiddenFiles: [],
    acceptanceCriteria: task.acceptanceCriteria,
    commands: task.commands,
    preferredExecutor: (task.preferredExecutor as DesktopExecutorId) ?? null,
    projectName: project?.name ?? "",
    projectRoot: project?.rootPath ?? gitRoot,
    projectMemory,
    recentContext: [],
  };
}

function buildTaskHandoffPayload(gitRoot: string, task: TaskRecord): DesktopTaskHandoff {
  const project = buildDesktopProject(gitRoot);
  const projectMemory = readDesktopProjectMemory(gitRoot).slice(-5).map((m) => ({ title: m.title, content: m.content }));
  const thread = readDesktopConversation(gitRoot, `task-${task.id}`);
  const recentContext = (thread?.messages ?? []).slice(-6).map((m) => ({ role: m.role, text: m.text }));
  const draftTask = readDesktopDraftTaskById(gitRoot, task.id);
  return {
    taskId: task.id,
    title: task.title,
    goal: task.description,
    allowedFiles: task.allowedFiles,
    forbiddenFiles: task.forbiddenFiles,
    acceptanceCriteria: task.acceptanceCriteria,
    commands: task.commands,
    preferredExecutor: (task.preferredExecutor ?? draftTask?.preferredExecutor) as DesktopExecutorId | null,
    projectName: project?.name ?? "",
    projectRoot: project?.rootPath ?? gitRoot,
    projectMemory,
    recentContext,
  };
}

function buildExecutorHandoffPrompt(handoff: DesktopTaskHandoff, executorId: string, userText?: string): string {
  const lines: string[] = [];
  lines.push(`Task: ${handoff.title}`);
  if (handoff.goal) {
    lines.push("");
    lines.push(`Goal: ${handoff.goal}`);
  }
  if (handoff.projectName) {
    lines.push(`Project: ${handoff.projectName} (${handoff.projectRoot})`);
  }
  if (handoff.preferredExecutor) {
    lines.push(`Planned for: ${handoff.preferredExecutor}`);
  }
  if (handoff.allowedFiles.length > 0) {
    lines.push("");
    lines.push("Allowed files:");
    for (const f of handoff.allowedFiles) lines.push(`  ${f}`);
  }
  if (handoff.forbiddenFiles.length > 0) {
    lines.push("");
    lines.push("Forbidden files:");
    for (const f of handoff.forbiddenFiles) lines.push(`  ${f}`);
  }
  if (handoff.acceptanceCriteria.length > 0) {
    lines.push("");
    lines.push("Acceptance criteria:");
    for (const c of handoff.acceptanceCriteria) lines.push(`  - ${c}`);
  }
  if (handoff.commands.length > 0) {
    lines.push("");
    lines.push("Verification commands:");
    for (const c of handoff.commands) lines.push(`  $ ${c}`);
  }
  if (handoff.projectMemory.length > 0) {
    lines.push("");
    lines.push("Project memory:");
    for (const m of handoff.projectMemory) lines.push(`  [${m.title}] ${m.content}`);
  }
  if (handoff.recentContext.length > 0) {
    lines.push("");
    lines.push("Recent conversation:");
    for (const m of handoff.recentContext) lines.push(`  [${m.role}] ${m.text.slice(0, 200)}`);
  }
  if (userText) {
    lines.push("");
    lines.push("Follow-up instruction:");
    lines.push(userText);
  }
  if (executorId === "claude-cli") {
    lines.push("");
    lines.push("Execute the task above. Modify files as needed to satisfy the acceptance criteria. Run the verification commands when done.");
  }
  return lines.join("\n");
}

// ── Run result helpers ──

function buildRunResultSummary(executorName: string, success: boolean, stdout: string, stderr: string): string {
  const truncated = stdout.slice(-500).trim() || stderr.slice(-500).trim();
  const result = success ? "succeeded" : "failed";
  let summary = `${executorName} run ${result}.`;
  if (truncated) {
    const lastLine = truncated.split(/\r?\n/).pop()?.trim() || "";
    if (lastLine && lastLine.length < 200) {
      summary += ` Last output: ${lastLine}`;
    }
  }
  return summary;
}

function extractChangedFiles(stdout: string): string[] {
  const files = new Set<string>();
  const lines = stdout.split(/\r?\n/);
  const diffMatch = /^diff --git a\/(.+?) b\/(.+?)$/;
  for (const line of lines) {
    const m = diffMatch.exec(line);
    if (m?.[1] && m[1] !== "/dev/null") {
      files.add(m[1]);
    }
  }
  const filePathRe = /(?:created|modified|updated|changed|wrote|written)\s+(?:file\s+)?['"]?([^\s'"]{3,200})['"]?/gi;
  let match: RegExpExecArray | null;
  while ((match = filePathRe.exec(stdout)) !== null) {
    const path = match[1].replace(/[()]/g, "").trim();
    if (path && !path.includes(" ") && path.length > 2) {
      files.add(path);
    }
  }
  return Array.from(files).slice(0, 20);
}

function advanceTaskStatusAfterRun(gitRoot: string, taskId: string, success: boolean): void {
  const task = readTaskById(gitRoot, taskId);
  if (!task) return;
  const ADVANCEABLE_STATUSES = new Set(["backlog", "planned", "ready", "in_progress", "needs_review", "test_failed"]);
  if (!ADVANCEABLE_STATUSES.has(task.status)) return;
  const newStatus = success ? "needs_review" : "blocked";
  if (task.status === newStatus) return;
  task.status = newStatus as TaskStatus;
  task.updatedAt = new Date().toISOString();
  writeTaskById(gitRoot, taskId, task);
}

// ── Review summary ──

function buildTaskReviewSummary(task: TaskRecord, run: DesktopTaskRunRecord | null): DesktopTaskReviewSummary {
  const runSucceeded = run ? run.exitCode === 0 : null;
  const changedFileCount = run?.changedFiles?.length ?? 0;
  const hasAcceptance = task.acceptanceCriteria.length > 0;
  const hasCommands = task.commands.length > 0;
  const ready = runSucceeded === true && (hasAcceptance || hasCommands);
  const suggestion = ready
    ? "Acceptance criteria met. Ready for review."
    : runSucceeded === false
      ? "Run failed. Review logs and refine before retrying."
      : runSucceeded === true
        ? "Run passed. No criteria specified — verify manually."
        : "Task not yet executed.";
  return {
    reviewId: `review-${task.id}-${Date.now()}`,
    taskId: task.id,
    runId: run?.runId ?? null,
    status: ready ? "ready_for_review" : "needs_attention",
    runSucceeded,
    changedFileCount,
    hasAcceptanceCriteria: hasAcceptance,
    hasCommands,
    suggestion,
    createdAt: new Date().toISOString(),
  };
}

// ── Project-level recent runs ──

function projectRecentRuns(gitRoot: string): DesktopProjectRecentRun[] {
  const all: DesktopProjectRecentRun[] = [];
  const tasksRoot = dataPath(gitRoot, "tasks");
  if (!existsSync(tasksRoot)) return [];
  const taskDirs = readdirSync(tasksRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of taskDirs) {
    const taskId = entry.name;
    const task = readTaskById(gitRoot, taskId);
    if (!task) continue;
    const runs = listTaskRuns(gitRoot, taskId);
    for (const run of runs) {
      all.push({
        runId: run.runId,
        taskId,
        taskTitle: task.title,
        executorId: run.executorId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        resultSummary: run.resultSummary,
      });
    }
  }
  return all
    .sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt))
    .slice(0, 10);
}

function handleGetDesktopRecentRuns(gitRoot: string, res: ServerResponse): void {
  const runs = projectRecentRuns(gitRoot);
  sendJson(res, 200, { runs });
}

function handleGetDesktopSummary(gitRoot: string, res: ServerResponse): void {
  const project = buildDesktopProject(gitRoot);
  if (!project) {
    sendJson(res, 200, { ok: true, summary: { text: "No project open.", counts: {} } });
    return;
  }
  const tasks = readAllTasks(gitRoot).filter((t) => t.projectId === project.id);
  const draftTasks = readDesktopDraftTasks(gitRoot, project.id);
  const allRecords = (draftTasks as ({ id: string } | TaskRecord)[]).concat(tasks);
  const activeTasks = tasks.filter((t) => !["merged", "closed"].includes(t.status));
  const openCount = activeTasks.filter((t) => ["backlog", "planned", "ready"].includes(t.status)).length;
  const reviewCount = activeTasks.filter((t) => t.status === "needs_review").length;
  const blockedCount = activeTasks.filter((t) => t.status === "blocked").length;
  const inProgressCount = activeTasks.filter((t) => t.status === "in_progress").length;
  const doneCount = tasks.filter((t) => ["merged", "closed"].includes(t.status)).length;
  const draftCount = draftTasks.length;
  let runningCount = 0;
  for (const t of allRecords) {
    const tRuns = listTaskRuns(gitRoot, t.id);
    for (const r of tRuns) {
      if (r.status === "starting" || r.status === "running") {
        runningCount += 1;
        break;
      }
    }
  }
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${String(runningCount)} task(s) currently executing`);
  if (reviewCount > 0) parts.push(`${String(reviewCount)} task(s) ready for review`);
  if (blockedCount > 0) parts.push(`${String(blockedCount)} task(s) blocked`);
  if (openCount > 0) parts.push(`${String(openCount)} task(s) ready to start`);
  if (inProgressCount > 0) parts.push(`${String(inProgressCount)} task(s) in progress`);
  const text = parts.length > 0
    ? parts.join(". ") + "."
    : draftCount > 0
      ? `${String(draftCount)} draft task(s) — start a run to begin.`
      : "No tasks yet. Run a planning session to get started.";
  sendJson(res, 200, {
    ok: true,
    summary: {
      text,
      counts: { open: openCount, inProgress: inProgressCount, review: reviewCount, blocked: blockedCount, done: doneCount, running: runningCount, draft: draftCount },
    },
  });
}

function handleGetDesktopExecutors(gitRoot: string, res: ServerResponse): void {
  const adapters = resolveExecutorAdapters(gitRoot);
  sendJson(res, 200, {
    executors: adapters.map((e) => ({ id: e.id, displayName: e.displayName })),
  });
}

// ── External session / assignment ──

function externalSessionsDir(gitRoot: string): string {
  const dir = join(gitRoot, ".scopeguard", "config", "external-sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function externalTokenConfigPath(gitRoot: string): string {
  return join(gitRoot, ".scopeguard", "config", "external-api-token.json");
}

function readExternalApiToken(gitRoot: string): string {
  const tokenPath = externalTokenConfigPath(gitRoot);
  if (existsSync(tokenPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tokenPath, "utf-8")) as { token?: string };
      if (parsed.token && typeof parsed.token === "string" && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch {
      // fall through to generate
    }
  }
  const newToken = randomUUID() + "-" + randomUUID();
  writeExternalApiToken(gitRoot, newToken);
  return newToken;
}

function writeExternalApiToken(gitRoot: string, token: string): void {
  mkdirSync(dirname(externalTokenConfigPath(gitRoot)), { recursive: true });
  writeFileSync(externalTokenConfigPath(gitRoot), JSON.stringify({ token }, null, 2) + "\n", "utf-8");
}

function validateExternalApiToken(gitRoot: string, authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  if (!authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7);
  const expected = readExternalApiToken(gitRoot);
  return provided === expected;
}

function externalSessionPath(gitRoot: string, sessionId: string): string {
  return join(externalSessionsDir(gitRoot), `${sessionId}.json`);
}

function readExternalSession(gitRoot: string, sessionId: string): Record<string, unknown> | null {
  const filePath = externalSessionPath(gitRoot, sessionId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeExternalSession(gitRoot: string, session: Record<string, unknown>): void {
  writeFileSync(externalSessionPath(gitRoot, session.sessionId as string), JSON.stringify(session, null, 2) + "\n", "utf-8");
}

function listExternalSessions(gitRoot: string): Record<string, unknown>[] {
  const dir = externalSessionsDir(gitRoot);
  if (!existsSync(dir)) return [];
  const sessions: Record<string, unknown>[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const filePath = join(dir, entry);
      try {
        const session = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
        if (session && session.sessionId) {
          sessions.push(session);
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // ignore
  }
  return sessions;
}

function resolveConnectedClients(gitRoot: string): DesktopConnectedClient[] {
  const sessions = listExternalSessions(gitRoot);
  const stalenessMs = 45_000; // 45s — bridge sends heartbeats every 25s, so 2 missed = stale
  const now = Date.now();
  return sessions
    .filter((s) => s.mode === "connected")
    .map((s) => {
      const lastSeen = new Date(s.lastSeenAt as string).getTime();
      const elapsed = now - lastSeen;
      return {
        sessionId: s.sessionId as string,
        clientName: s.clientName as string,
        clientVersion: (s.clientVersion as string | null) ?? null,
        executorId: (s.executorId as DesktopExecutorId | null) ?? null,
        mode: s.mode as string,
        status: (elapsed < stalenessMs ? "online" : "stale") as "online" | "stale",
        lastSeenAt: s.lastSeenAt as string,
        createdAt: s.createdAt as string,
        protocolVersion: s.protocolVersion as string,
      };
    });
}

function resolveEffectiveTaskExecutor(task: TaskRecord | DesktopDraftTaskRecord): string | null {
  return (task as TaskRecord).assignedExecutor ?? (task as DesktopDraftTaskRecord).assignedExecutor ?? (task as TaskRecord).preferredExecutor ?? (task as DesktopDraftTaskRecord).preferredExecutor ?? null;
}

function resolveTaskDispatchInfo(gitRoot: string, task: TaskRecord | DesktopDraftTaskRecord): DesktopTaskDispatchInfo {
  const assignedExecutor = resolveEffectiveTaskExecutor(task);
  const existingAssignment = task.id ? findTaskAssignment(gitRoot, task.id) : null;
  if (existingAssignment) {
    return {
      status: "dispatched",
      assignedExecutor: assignedExecutor as DesktopExecutorId | null,
      matchingClient: null,
    };
  }
  if (!assignedExecutor) {
    return { status: "idle", assignedExecutor: null, matchingClient: null };
  }
  const clients = resolveConnectedClients(gitRoot);
  const matchingClient = clients.find((c) => c.executorId === assignedExecutor && c.status === "online") ?? null;
  if (matchingClient) {
    return { status: "ready", assignedExecutor: assignedExecutor as DesktopExecutorId | null, matchingClient };
  }
  const staleClient = clients.find((c) => c.executorId === assignedExecutor) ?? null;
  return { status: staleClient ? "idle" : "no_client", assignedExecutor: assignedExecutor as DesktopExecutorId | null, matchingClient: null };
}

function touchExternalSession(gitRoot: string, sessionId: string): boolean {
  const session = readExternalSession(gitRoot, sessionId);
  if (!session) return false;
  session.lastSeenAt = new Date().toISOString();
  session.status = "connected";
  writeExternalSession(gitRoot, session);
  return true;
}

// ── External assignment queue ──

function externalAssignmentsDir(gitRoot: string): string {
  return join(gitRoot, ".scopeguard", "config", "external-assignments");
}

function assignmentFilePath(gitRoot: string, assignmentId: string): string {
  return join(externalAssignmentsDir(gitRoot), `${assignmentId}.json`);
}

function readAssignment(gitRoot: string, assignmentId: string): Record<string, unknown> | null {
  const filePath = assignmentFilePath(gitRoot, assignmentId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeAssignment(gitRoot: string, assignment: Record<string, unknown>): void {
  mkdirSync(dirname(assignmentFilePath(gitRoot, assignment.assignmentId as string)), { recursive: true });
  writeFileSync(assignmentFilePath(gitRoot, assignment.assignmentId as string), JSON.stringify(assignment, null, 2) + "\n", "utf-8");
}

function listAssignments(gitRoot: string, filter?: { status?: string; executorId?: string }): DesktopAssignmentRecord[] {
  const dir = externalAssignmentsDir(gitRoot);
  if (!existsSync(dir)) return [];
  const results: DesktopAssignmentRecord[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, entry), "utf-8")) as Record<string, unknown>;
        if (!record || !record.assignmentId) continue;
        if (filter?.status && record.status !== filter.status) continue;
        if (filter?.executorId && record.assignedExecutor !== filter.executorId) continue;
        results.push(record as unknown as DesktopAssignmentRecord);
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function findTaskAssignment(gitRoot: string, taskId: string, kind?: "execution" | "review"): DesktopAssignmentRecord | null {
  const all = listAssignments(gitRoot);
  return all.find((a) => a.taskId === taskId && (a.status === "pending" || a.status === "claimed") && (kind ? a.kind === kind : true)) ?? null;
}

function createTaskAssignment(gitRoot: string, taskId: string, projectId: string, assignedExecutor: string, handoffText: string, kind?: "execution" | "review"): DesktopAssignmentRecord {
  const assignment = {
    assignmentId: randomUUID(),
    taskId,
    projectId,
    assignedExecutor: assignedExecutor as DesktopExecutorId,
    sessionTarget: null,
    status: "pending" as DesktopAssignmentStatus,
    kind: kind ?? "execution",
    handoffSnapshot: handoffText,
    createdAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null,
  };
  writeAssignment(gitRoot, assignment as unknown as Record<string, unknown>);
  return assignment;
}

function claimAssignment(gitRoot: string, assignmentId: string, sessionId: string): DesktopAssignmentRecord | null {
  const assignment = readAssignment(gitRoot, assignmentId);
  if (!assignment) return null;
  if (assignment.status !== "pending") return null;
  assignment.status = "claimed";
  assignment.sessionTarget = sessionId;
  assignment.claimedAt = new Date().toISOString();
  writeAssignment(gitRoot, assignment);
  return assignment as unknown as DesktopAssignmentRecord;
}

function completeAssignment(gitRoot: string, assignmentId: string): DesktopAssignmentRecord | null {
  const assignment = readAssignment(gitRoot, assignmentId);
  if (!assignment) return null;
  assignment.status = "completed";
  assignment.completedAt = new Date().toISOString();
  writeAssignment(gitRoot, assignment);
  return assignment as unknown as DesktopAssignmentRecord;
}

function cancelAssignment(gitRoot: string, assignmentId: string): DesktopAssignmentRecord | null {
  const assignmentRaw = readAssignment(gitRoot, assignmentId);
  if (!assignmentRaw) return null;
  if (assignmentRaw.status !== "pending" && assignmentRaw.status !== "claimed") return null;
  if (assignmentRaw.kind !== "execution") return null;
  const assignment = assignmentRaw as unknown as DesktopAssignmentRecord;
  // Task-level guard: reject if task is past the execution phase
  if (assignment.taskId) {
    const task = readTaskById(gitRoot, assignment.taskId);
    if (task && (task.status === "needs_review" || task.status === "approved" || task.status === "merged" || task.status === "closed")) return null;
  }
  // Mark canceled (terminal, preserves history; completedAt reused as terminal timestamp)
  assignment.status = "canceled" as DesktopAssignmentStatus;
  assignment.completedAt = new Date().toISOString();
  writeAssignment(gitRoot, assignment);
  // Reset task to ready; clear only cached summaries (underlying run/assignment records on disk preserved)
  if (assignment.taskId) {
    const task = readTaskById(gitRoot, assignment.taskId);
    if (task) {
      task.status = "ready" as TaskStatus;
      delete (task as Record<string, unknown>).latestRunResult;
      delete (task as Record<string, unknown>).latestReviewSummary;
      task.updatedAt = new Date().toISOString();
      writeTaskById(gitRoot, assignment.taskId, task);
    }
    // Mark any active (starting/running) runs as failed (run records preserved, not deleted)
    const activeRuns = listTaskRuns(gitRoot, assignment.taskId)
      .filter((r) => r.status === "starting" || r.status === "running");
    for (const run of activeRuns) {
      run.status = "failed" as DesktopTaskRunStatus;
      run.exitCode = -1;
      run.finishedAt = new Date().toISOString();
      run.resultSummary = "Canceled.";
      run.stderr = (run.stderr || "") + "\n[Canceled] Assignment was canceled before the run completed.";
      writeTaskRun(gitRoot, run);
    }
  }
  return assignment;
}

// ── Queue-assignment helpers ──

function scanAllTasksForId(gitRoot: string, targetTaskId: string): TaskRecord | null {
  const tasksRoot = dataPath(gitRoot, "tasks");
  if (!existsSync(tasksRoot)) return null;
  try {
    const entries = readdirSync(tasksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskPath = join(tasksRoot, entry.name, "task.json");
      if (!existsSync(taskPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
        if (raw.id === targetTaskId) return raw;
      } catch {
        // skip malformed
      }
    }
  } catch {
    // skip unreadable
  }
  return null;
}

function scanAllDraftsForId(gitRoot: string, targetTaskId: string): DesktopDraftTaskRecord | null {
  const draftsRoot = getDesktopDraftTasksRoot(gitRoot);
  if (!existsSync(draftsRoot)) return null;
  try {
    const entries = readdirSync(draftsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const draftPath = join(draftsRoot, entry.name);
      try {
        const raw = JSON.parse(readFileSync(draftPath, "utf-8")) as DesktopDraftTaskRecord;
        if (raw.id === targetTaskId) return raw;
      } catch {
        // skip malformed
      }
    }
  } catch {
    // skip unreadable
  }
  return null;
}

/**
 * Synchronously queues a single task by validating executor, checking for
 * duplicate assignments, verifying dependency satisfaction, and creating
 * the assignment record. Never sends HTTP responses.
 *
 * Returns:
 *   { ok: true, assignment }   -- the assignment was created.
 *   { ok: false, code, message } -- the task cannot be queued.
 *
 * Error codes:
 *   "NO_EXECUTOR"         -- task has no assigned/preferred executor.
 *   "ALREADY_QUEUED"      -- an existing pending/claimed assignment exists.
 *   "DEPENDENCY_NOT_MET"  -- a dependency is not in a terminal state.
 */
function queueSingleTask(
  gitRoot: string,
  taskId: string,
  task: TaskRecord | DesktopDraftTaskRecord,
): { ok: true; assignment: DesktopAssignmentRecord } | { ok: false; code: string; message: string } {
  const executor = resolveEffectiveTaskExecutor(task);
  if (!executor) {
    return { ok: false, code: "NO_EXECUTOR", message: "Task has no assigned executor." };
  }
  const existingAssignment = findTaskAssignment(gitRoot, taskId);
  if (existingAssignment) {
    return { ok: false, code: "ALREADY_QUEUED", message: "Task already has a pending/claimed assignment." };
  }
  // Check dependsOn: every depId must be in a terminal state (approved/merged/closed)
  // or not found (orphaned dependency — treat as satisfied).
  const deps = task.dependsOn ?? [];
  for (const depId of deps) {
    const depTask = readTaskById(gitRoot, depId);
    if (depTask && depTask.status !== "approved" && depTask.status !== "merged" && depTask.status !== "closed") {
      return { ok: false, code: "DEPENDENCY_NOT_MET", message: `Waiting on dependent task "${depTask.title}" (${depId}) to be approved.` };
    }
  }
  const handoffString = buildDesktopHandoff(gitRoot, task, executor);
  const assignment = createTaskAssignment(gitRoot, taskId, task.projectId, executor, handoffString);
  return { ok: true, assignment };
}

async function processQueueAssignment(gitRoot: string, taskId: string, task: TaskRecord | DesktopDraftTaskRecord, res: ServerResponse, kind?: "execution" | "review"): Promise<void> {
  const result = queueSingleTask(gitRoot, taskId, task);
  if (!result.ok) {
    const httpCode = result.code === "ALREADY_QUEUED" ? 409 : 400;
    sendJson(res, httpCode, result);
    return;
  }
  sendJson(res, 200, result);
}

// ── Task run persistence ──

function taskRunsDir(gitRoot: string, taskId: string): string {
  const dir = join(gitRoot, ".scopeguard", "tasks", taskId, "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function taskRunPath(gitRoot: string, taskId: string, runId: string): string {
  return join(taskRunsDir(gitRoot, taskId), `${runId}.json`);
}

function readTaskRun(gitRoot: string, taskId: string, runId: string): DesktopTaskRunRecord | null {
  const filePath = taskRunPath(gitRoot, taskId, runId);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as DesktopTaskRunRecord;
    if (typeof parsed.runId === "string" && typeof parsed.taskId === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeTaskRun(gitRoot: string, record: DesktopTaskRunRecord): void {
  writeFileSync(taskRunPath(gitRoot, record.taskId, record.runId), JSON.stringify(record, null, 2) + "\n", "utf-8");
}

function listTaskRuns(gitRoot: string, taskId: string): DesktopTaskRunRecord[] {
  const dir = taskRunsDir(gitRoot, taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf-8")) as DesktopTaskRunRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is DesktopTaskRunRecord => r !== null && typeof r.runId === "string")
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

// ── Windows binary resolution ──

function resolveWindowsBinary(rawCommand: string): { path: string; type: string } {
  if (!rawCommand.includes("\\") && !rawCommand.includes("/") && !rawCommand.endsWith(".cmd")) {
    try {
      const npmPrefix = execSync("npm prefix -g", { encoding: "utf8", windowsHide: true, timeout: 2000 }).trim();
      const npmCmd = join(npmPrefix, rawCommand + ".cmd");
      if (existsSync(npmCmd)) return { path: npmCmd, type: "cmd" };
    } catch {
      // fall through
    }
  }
  for (const ext of [".cmd", ".bat", ".exe"]) {
    const candidate = rawCommand.endsWith(ext) ? rawCommand : rawCommand + ext;
    try {
      const output = execSync(`where "${candidate}" 2>nul`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 2000,
      }).trim().split(/\r?\n/)[0];
      if (output && existsSync(output)) {
        return { path: output, type: ext.slice(1) };
      }
    } catch {
      // try next
    }
  }
  if (rawCommand.includes("\\") || rawCommand.includes("/")) {
    if (existsSync(rawCommand)) {
      const m = rawCommand.match(/\.(cmd|bat|exe)$/i);
      return { path: rawCommand, type: m ? m[1].toLowerCase() : "bare" };
    }
  }
  return { path: rawCommand, type: "bare" };
}

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function buildPowerShellInvocation(binaryPath: string, args: string[]): string {
  const prelude = [
    "Remove-Item Env:npm_config_recursive -ErrorAction SilentlyContinue;",
    "Remove-Item Env:NPM_CONFIG_RECURSIVE -ErrorAction SilentlyContinue;",
  ].join(" ");
  return prelude + " & " + psQuote(binaryPath) + (args.length > 0 ? " " + args.map(psQuote).join(" ") : "");
}

function resolveCliCommand(rawCommand: string, extraArgs: string[]): ResolvedCliCommand {
  const debugInfo: Record<string, unknown> = { resolvedFrom: "bare", rawCommand };
  if (process.platform !== "win32") {
    return { command: rawCommand, argsPrefix: extraArgs, debugInfo };
  }
  const bin = resolveWindowsBinary(rawCommand);
  debugInfo.resolvedFrom = bin.type;
  if (bin.type === "exe" || bin.type === "bare") {
    return { command: bin.path, argsPrefix: extraArgs, debugInfo };
  }
  const psCmd = buildPowerShellInvocation(bin.path, extraArgs);
  return {
    command: "powershell.exe",
    argsPrefix: ["-NoProfile", "-Command", psCmd],
    debugInfo,
  };
}

function spawnCli(gitRoot: string, resolved: ResolvedCliCommand, env: Record<string, string>): ReturnType<typeof spawn> {
  return spawn(resolved.command, resolved.argsPrefix, {
    cwd: gitRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function runCliSync(gitRoot: string, resolved: ResolvedCliCommand, env: Record<string, string>, timeoutMs: number): CliResult {
  const result = spawnSync(resolved.command, resolved.argsPrefix, {
    cwd: gitRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
    error: result.error ?? null,
    signal: result.signal ?? null,
  };
}

// ── Path helpers / Core task I/O ──

function parseTaskPath(path: string): { taskId: string; subPath: string } | null {
  const raw = path.slice("/api/tasks/".length);
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  return {
    taskId: decodeURIComponent(parts[0] ?? ""),
    subPath: decodeURIComponent(parts[1] ?? ""),
  };
}

function parseDesktopTaskPath(path: string): { taskId: string; subPath: string } | null {
  const raw = path.slice("/api/desktop/tasks/".length);
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  return {
    taskId: decodeURIComponent(parts[0] ?? ""),
    subPath: decodeURIComponent(parts[1] ?? ""),
  };
}

function readAllTasks(gitRoot: string): TaskRecord[] {
  const tasksRoot = dataPath(gitRoot, "tasks");
  if (!existsSync(tasksRoot)) return [];
  const tasks: TaskRecord[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskPath = join(tasksRoot, entry.name, "task.json");
    if (!existsSync(taskPath)) continue;
    try {
      tasks.push(JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord);
    } catch {
      // skip malformed task files
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

function readTaskById(gitRoot: string, taskId: string): TaskRecord | null {
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  if (!existsSync(taskPath)) return null;
  try {
    return JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  } catch {
    return null;
  }
}

function writeTaskById(gitRoot: string, taskId: string, task: TaskRecord): void {
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  mkdirSync(dirname(taskPath), { recursive: true });
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");
}

// ── Desktop project / folder inspection ──

function buildDesktopProject(gitRoot: string): DesktopProject | null {
  const resolvedRoot = findGitRoot(gitRoot);
  const workspaceRoot = normalizeSlashes(resolve(gitRoot));
  const projectMeta = readDesktopProjectMeta(gitRoot);
  if (!resolvedRoot) {
    return {
      id: buildLocalWorkspaceProjectId(workspaceRoot),
      name: projectMeta.displayName || basename(workspaceRoot),
      rootPath: workspaceRoot,
      defaultBranch: null,
      isGitRepo: false,
      isInitialized: false,
      isTrusted: projectMeta.trusted,
      taskCount: 0,
      activeTaskCount: 0,
      updatedAt: null,
      source: "local-folder",
    };
  }
  const configPath = dataPath(gitRoot, "config.json");
  if (!existsSync(configPath)) {
    const normalizedRoot = normalizeSlashes(resolvedRoot);
    return {
      id: buildUninitializedProjectId(normalizedRoot),
      name: projectMeta.displayName || basename(resolvedRoot),
      rootPath: normalizedRoot,
      defaultBranch: getDefaultBranch(resolvedRoot),
      isGitRepo: true,
      isInitialized: false,
      isTrusted: projectMeta.trusted,
      taskCount: 0,
      activeTaskCount: 0,
      updatedAt: null,
      source: "new-folder",
    };
  }
  ensureProjectAgentCommandFiles(resolvedRoot);
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as { projectId: string; projectName: string; rootPath: string; defaultBranch?: string };
  const tasks = readAllTasks(gitRoot);
  const activeTaskCount = tasks.filter((task) => !["merged", "closed"].includes(task.status)).length;
  const updatedAt = tasks.length > 0
    ? tasks.map((task) => task.updatedAt).sort().at(-1) ?? null
    : null;
  const project: DesktopProject = {
    id: config.projectId,
    name: config.projectName,
    rootPath: config.rootPath,
    defaultBranch: config.defaultBranch ?? null,
    isGitRepo: true,
    isInitialized: true,
    isTrusted: projectMeta.trusted,
    taskCount: tasks.length,
    activeTaskCount,
    updatedAt,
    source: "scopeguard",
  };
  ensureProjectConnectArtifacts(resolvedRoot, project, readOrGenerateExternalApiToken(resolvedRoot));
  return project;
}

function inspectFolderForDesktop(folderPath: string): Record<string, unknown> {
  const gitRoot = findGitRoot(folderPath);
  if (!gitRoot) {
    const workspaceRoot = normalizeSlashes(resolve(folderPath));
    const projectMeta = readDesktopProjectMeta(workspaceRoot);
    return {
      ok: true,
      mode: "workspace-folder",
      project: {
        id: buildLocalWorkspaceProjectId(workspaceRoot),
        name: projectMeta.displayName || workspaceRoot.replace(/^.*[\\/]/, ""),
        rootPath: workspaceRoot,
        defaultBranch: null,
        isGitRepo: false,
        isInitialized: false,
        isTrusted: projectMeta.trusted,
        taskCount: 0,
        activeTaskCount: 0,
        updatedAt: null,
        source: "local-folder",
      },
      message: "Opened a local workspace folder. Git-backed project features can be enabled later.",
    };
  }
  const configPath = join(gitRoot, ".scopeguard", "config.json");
  if (!existsSync(configPath)) {
    const normalizedRoot = normalizeSlashes(gitRoot);
    const projectMeta = readDesktopProjectMeta(gitRoot);
    return {
      ok: true,
      mode: "new-project",
      project: {
        id: buildUninitializedProjectId(normalizedRoot),
        name: projectMeta.displayName || gitRoot.replace(/^.*[\\/]/, ""),
        rootPath: normalizedRoot,
        defaultBranch: null,
        isGitRepo: true,
        isInitialized: false,
        isTrusted: projectMeta.trusted,
        taskCount: 0,
        activeTaskCount: 0,
        updatedAt: null,
        source: "new-folder",
      },
    };
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as { projectId: string; projectName: string; rootPath: string; defaultBranch?: string };
  const tasks = readAllTasks(gitRoot);
  return {
    ok: true,
    mode: "existing-project",
    project: {
      id: config.projectId,
      name: config.projectName,
      rootPath: config.rootPath,
      defaultBranch: config.defaultBranch ?? null,
      isInitialized: true,
      isTrusted: readDesktopProjectMeta(gitRoot).trusted,
      taskCount: tasks.length,
      activeTaskCount: tasks.filter((task) => !["merged", "closed"].includes(task.status)).length,
      updatedAt: tasks.map((task) => task.updatedAt).sort().at(-1) ?? null,
      source: "scopeguard",
    },
  };
}

function initializeScopeGuardProject(gitRoot: string): Record<string, unknown> {
  if (!findGitRoot(gitRoot)) {
    return {
      ok: false,
      code: "NOT_A_REPO",
      message: `No git repository found for: ${gitRoot}. Initialize git first, then enable the managed ScopeGuard project.`,
    };
  }
  const storageRoot = join(gitRoot, ".scopeguard");
  const configPath = join(storageRoot, "config.json");
  const locksPath = join(storageRoot, "locks.json");
  mkdirSync(storageRoot, { recursive: true });
  for (const dirName of REQUIRED_DATA_DIRS) {
    mkdirSync(join(storageRoot, dirName), { recursive: true });
  }
  if (!existsSync(configPath)) {
    const projectMeta = readDesktopProjectMeta(gitRoot);
    writeFileSync(configPath, `${JSON.stringify({
      projectId: randomUUID(),
      projectName: projectMeta.displayName || basename(gitRoot),
      rootPath: normalizeSlashes(gitRoot),
      defaultBranch: getDefaultBranch(gitRoot),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf-8");
  }
  if (!existsSync(locksPath)) {
    writeFileSync(locksPath, `${JSON.stringify({ locks: [] }, null, 2)}\n`, "utf-8");
  }
  ensureProjectAgentCommandFiles(gitRoot);
  const project = buildDesktopProject(gitRoot);
  if (!project) {
    return {
      ok: false,
      code: "INITIALIZE_FAILED",
      message: "ScopeGuard metadata was written, but the project could not be loaded.",
    };
  }
  return {
    ok: true,
    project,
    message: "ScopeGuard initialized for this repository.",
  };
}

function initializeGitRepositoryForDesktop(gitRoot: string): Record<string, unknown> {
  const existingGitRoot = findGitRoot(gitRoot);
  if (existingGitRoot) {
    const project = buildDesktopProject(gitRoot);
    if (!project) {
      return {
        ok: false,
        code: "GIT_INIT_FAILED",
        message: "Git repository detected, but the project could not be loaded.",
      };
    }
    return {
      ok: true,
      project,
      message: "Git is already initialized for this folder.",
    };
  }
  const result = spawnSync("git", ["init"], {
    cwd: gitRoot,
    encoding: "utf-8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      code: "GIT_INIT_FAILED",
      message: result.stderr?.trim() || result.stdout?.trim() || "Failed to initialize git for this folder.",
    };
  }
  const project = buildDesktopProject(gitRoot);
  if (!project) {
    return {
      ok: false,
      code: "GIT_INIT_FAILED",
      message: "Git was initialized, but the project could not be reloaded.",
    };
  }
  return {
    ok: true,
    project,
    message: "Git initialized for this folder.",
  };
}

// ── Desktop view-model mappers ──

function resolveTaskReviewStatus(task: TaskRecord): "none" | "ready_for_review" | "needs_attention" {
  const r = (task as Record<string, unknown>).latestReviewSummary as Record<string, unknown> | null;
  if (!r || typeof r.status !== "string") return "none";
  if (r.status === "ready_for_review") return "ready_for_review";
  if (r.status === "needs_attention") return "needs_attention";
  return "none";
}

function resolveReviewAssignmentStatus(gitRoot: string, taskId: string): "none" | "pending" | "claimed" {
  const all = listAssignments(gitRoot, { status: "pending" }).filter(function (a: DesktopAssignmentRecord) { return a.taskId === taskId && a.kind === "review"; });
  if (all.length > 0) return "pending";
  const claimed = listAssignments(gitRoot).filter(function (a: DesktopAssignmentRecord) { return a.taskId === taskId && a.kind === "review" && (a.status === "claimed" || a.status === "pending"); });
  if (claimed.length > 0) return "claimed";
  return "none";
}
function toDesktopTaskListItem(gitRoot: string, task: TaskRecord): DesktopTaskListItem {
  const effectiveExecutor = resolveEffectiveTaskExecutor(task);
  // Compute display status reflecting dispatch state
  const hasActiveExec = task.id ? findTaskAssignment(gitRoot, task.id, "execution") !== null : false;
  let displayStatus = mapCoreStatusToDesktopStatus(task.status);
  if (displayStatus === "Ready" && hasActiveExec) {
    displayStatus = "In Progress";
  }
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    subtitle: buildTaskSubtitle(gitRoot, task),
    status: displayStatus,
    rawStatus: task.status as CoreTaskStatus,
    riskLevel: task.riskLevel,
    updatedAt: task.updatedAt,
    hasConversation: hasTaskConversation(gitRoot, task.id),
    preferredExecutor: (task.preferredExecutor ?? effectiveExecutor) as DesktopExecutorId | null,
    assignedExecutor: effectiveExecutor as DesktopExecutorId | null,
    goal: task.description,
    allowedFiles: task.allowedFiles,
    acceptanceCriteria: task.acceptanceCriteria,
    commands: task.commands,
    dependsOn: task.dependsOn ?? task.dependencies ?? [],
    depBlocked: (task.dependsOn ?? []).some((depId) => {
      const depTask = readTaskById(gitRoot, depId);
      return depTask && depTask.status !== "approved" && depTask.status !== "merged" && depTask.status !== "closed";
    }),
    priority: task.priority ?? "medium",
    parallelizable: task.parallelizable ?? false,
    reviewAssignmentStatus: resolveReviewAssignmentStatus(gitRoot, task.id),
    reviewStatus: resolveTaskReviewStatus(task),
  };
}

function toDesktopTaskListItemFromDraft(gitRoot: string, draftTask: DesktopDraftTaskRecord): DesktopTaskListItem {
  return {
    id: draftTask.id,
    projectId: draftTask.projectId,
    title: draftTask.title,
    subtitle: "Created from project conversation",
    status: "Draft",
    rawStatus: "planned" as CoreTaskStatus,
    riskLevel: draftTask.riskLevel,
    updatedAt: draftTask.updatedAt,
    hasConversation: hasTaskConversation(gitRoot, draftTask.id),
    preferredExecutor: (draftTask.preferredExecutor ?? null) as DesktopExecutorId | null,
    assignedExecutor: (draftTask.assignedExecutor ?? null) as DesktopExecutorId | null,
    goal: draftTask.description,
    allowedFiles: draftTask.allowedFiles ?? [],
    acceptanceCriteria: draftTask.acceptanceCriteria ?? [],
    commands: draftTask.commands ?? [],
    dependsOn: draftTask.dependsOn ?? [],
    depBlocked: false,
    priority: draftTask.priority ?? "medium",
    parallelizable: draftTask.parallelizable ?? false,
    reviewAssignmentStatus: "none",
    reviewStatus: "none",
  };
}



function toDesktopTaskDetail(gitRoot: string, task: TaskRecord): DesktopTaskDetail {
  const effectiveExecutor = resolveEffectiveTaskExecutor(task);
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    uiStatus: mapCoreStatusToDesktopStatus(task.status),
    rawStatus: task.status as CoreTaskStatus,
    riskLevel: task.riskLevel,
    acceptanceCriteria: task.acceptanceCriteria,
    commands: task.commands,
    dependencies: task.dependencies,
    branchName: task.branchName,
    worktreePath: task.worktreePath,
    resultSummary: task.resultSummary,
    preferredExecutor: (task.preferredExecutor ?? effectiveExecutor) as DesktopExecutorId | null,
    assignedExecutor: effectiveExecutor as DesktopExecutorId | null,
    dependsOn: task.dependsOn ?? [],
    depBlocked: (task.dependsOn ?? []).some((depId) => {
      const depTask = readTaskById(gitRoot, depId);
      return depTask && depTask.status !== "approved" && depTask.status !== "merged" && depTask.status !== "closed";
    }),
    parallelizable: task.parallelizable ?? false,
    priority: task.priority ?? "medium",
    latestRunResult: task.latestRunResult ?? null,
    latestReviewSummary: task.latestReviewSummary ?? null,
    dispatchInfo: resolveTaskDispatchInfo(gitRoot, task),
    assignmentId: findTaskAssignment(gitRoot, task.id)?.assignmentId ?? null,
    activeExecutionAssignmentId: findTaskAssignment(gitRoot, task.id, "execution")?.assignmentId ?? null,
    reviewAssignmentStatus: resolveReviewAssignmentStatus(gitRoot, task.id),
    reviewStatus: resolveTaskReviewStatus(task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toDesktopTaskDetailFromDraft(gitRoot: string, draftTask: DesktopDraftTaskRecord): DesktopTaskDetail {
  return {
    id: draftTask.id,
    projectId: draftTask.projectId,
    title: draftTask.title,
    description: draftTask.description,
    uiStatus: "Draft",
    rawStatus: "planned" as CoreTaskStatus,
    riskLevel: draftTask.riskLevel,
    isDraft: true,
    acceptanceCriteria: draftTask.acceptanceCriteria ?? [],
    commands: draftTask.commands ?? [],
    dependencies: [],
    branchName: null,
    worktreePath: null,
    resultSummary: null,
    preferredExecutor: (draftTask.preferredExecutor ?? null) as DesktopExecutorId | null,
    assignedExecutor: (draftTask.assignedExecutor ?? null) as DesktopExecutorId | null,
    dependsOn: draftTask.dependsOn ?? [],
    depBlocked: false,
    parallelizable: draftTask.parallelizable ?? false,
    priority: draftTask.priority ?? "medium",
    latestRunResult: null,
    latestReviewSummary: null,
    dispatchInfo: resolveTaskDispatchInfo(gitRoot, draftTask),
    assignmentId: findTaskAssignment(gitRoot, draftTask.id)?.assignmentId ?? null,
    activeExecutionAssignmentId: null,
    reviewAssignmentStatus: "none",
    reviewStatus: "none",
    createdAt: draftTask.createdAt,
    updatedAt: draftTask.updatedAt,
  };
}

function toDesktopTaskContext(gitRoot: string, task: TaskRecord): DesktopTaskContext {
  const verifyReportPath = dataPath(gitRoot, "tasks", task.id, "verify-report.json");
  const reviewPath = dataPath(gitRoot, "tasks", task.id, "review.md");
  const latestStatus = existsSync(verifyReportPath)
    ? readVerifyReportStatus(verifyReportPath)
    : task.status === "needs_review" || task.status === "approved"
      ? "pending"
      : "unknown";
  return {
    taskId: task.id,
    allowedFiles: task.allowedFiles,
    lockedFiles: task.lockedFiles,
    forbiddenFiles: task.forbiddenFiles,
    referenceFiles: collectTaskReferenceFiles(gitRoot, task.allowedFiles),
    validationSummary: {
      latestStatus,
      latestReportPath: existsSync(verifyReportPath)
        ? `${resolveDataDir(gitRoot).dataDirName}/tasks/${task.id}/verify-report.json`
        : null,
      summaryText: existsSync(reviewPath)
        ? "Review artifact exists for this task."
        : task.resultSummary ?? null,
    },
    activitySummary: {
      lastEvent: buildLastEvent(task),
      lastEventAt: task.updatedAt,
      eventCount: countTaskArtifacts(gitRoot, task.id),
    },
  };
}

function toDesktopTaskContextFromDraft(draftTask: DesktopDraftTaskRecord): DesktopTaskContext {
  return {
    taskId: draftTask.id,
    allowedFiles: draftTask.allowedFiles ?? [],
    lockedFiles: [],
    forbiddenFiles: [],
    referenceFiles: [],
    validationSummary: {
      latestStatus: "unknown",
      latestReportPath: null,
      summaryText: draftTask.allowedFiles && draftTask.allowedFiles.length > 0
        ? `${String(draftTask.allowedFiles.length)} file patterns set from planning.`
        : "Draft task created. Refine scope before execution.",
    },
    activitySummary: {
      lastEvent: draftTask.allowedFiles && draftTask.allowedFiles.length > 0
        ? `Draft task with ${String(draftTask.allowedFiles.length)} file patterns from planning`
        : "Draft task created",
      lastEventAt: draftTask.updatedAt,
      eventCount: 1,
    },
  };
}

function collectTaskReferenceFiles(gitRoot: string, allowedFiles: string[]): Array<{ path: string; label: string }> {
  const candidates = [
    "AGENTS.md",
    ".scopeguard/AGENTS.md",
    "README.md",
    "README.zh-CN.md",
    "docs/QUICKSTART.md",
    "docs/COMMANDS.md",
  ];
  for (const allowedFile of allowedFiles) {
    if (!/[*?]/.test(allowedFile)) {
      candidates.push(normalizeSlashes(allowedFile));
    }
  }
  const unique: Array<{ path: string; label: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const relativePath = normalizeSlashes(candidate);
    if (seen.has(relativePath)) continue;
    const absolutePath = resolve(gitRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    seen.add(relativePath);
    unique.push({ path: relativePath, label: basename(relativePath) });
  }
  return unique.slice(0, 12);
}

function mapCoreStatusToDesktopStatus(status: string): "Draft" | "Ready" | "In Progress" | "Awaiting Review" | "Approved" | "Blocked" {
  switch (status) {
    case "backlog":
    case "planned":
      return "Draft";
    case "ready":
      return "Ready";
    case "in_progress":
      return "In Progress";
    case "needs_review":
      return "Awaiting Review";
    case "approved":
      return "Approved";
    case "blocked":
    case "test_failed":
    case "conflict":
    case "merged":
    case "closed":
    default:
      return "Blocked";
  }
}

function ensureProjectAgentCommandFiles(gitRoot: string): void {
  const claudeCommandsDir = join(gitRoot, ".claude", "commands");
  const scopeguardRunPath = join(claudeCommandsDir, "scopeguard-run.md");
  const scopeguardRunContents = [
    "Immediately run one ScopeGuard task workflow using the four MCP tools (scopeguard_status, scopeguard_list_pending, scopeguard_claim_assignment, scopeguard_finish_assignment).",
    "",
    "Do not explain this command or discuss tool availability. Call the first tool now.",
    "",
    "1. Call scopeguard_status now. If the call fails because the tool is unavailable in this session, report that and stop.",
    "2. Call scopeguard_list_pending. If there are no pending assignments, report idle and stop.",
    "3. Claim exactly one assignment via scopeguard_claim_assignment.",
    "4. Execute the task using the returned handoff. Work within allowedFiles only.",
    "5. Report results via scopeguard_finish_assignment. Do not skip this step.",
    "6. Return only a short execution report in this format:",
    "   - status: succeeded / failed / idle",
    "   - result: one-line summary",
    "",
    "Never explain what you are about to do. Never discuss tool availability before calling. Never read source files. Never probe ports. Never call HTTP directly. Never claim more than one assignment. Never leave a claimed assignment unfinished.",
    "",
  ].join("\n");
  mkdirSync(claudeCommandsDir, { recursive: true });
  if (!existsSync(scopeguardRunPath)) {
    writeFileSync(scopeguardRunPath, scopeguardRunContents, "utf-8");
  }
}

function buildTaskSubtitle(gitRoot: string, task: TaskRecord): string {
  const deps = task.dependsOn ?? [];
  if (task.status === "ready" && deps.length > 0) {
    const depBlocked = deps.some((depId) => {
      const depTask = readTaskById(gitRoot, depId);
      return depTask && depTask.status !== "approved" && depTask.status !== "merged" && depTask.status !== "closed";
    });
    if (depBlocked) return "Waiting on dependency";
  }
  // If task has an active execution assignment, show queued/dispatched
  const hasActiveExec = task.id ? findTaskAssignment(gitRoot, task.id, "execution") !== null : false;
  if (task.status === "ready" && hasActiveExec) {
    return "Queued — awaiting pickup";
  }
  switch (task.status) {
    case "ready":
    case "planned":
    case "backlog":
      return "Ready to queue";
    case "in_progress":
      return "Execution in progress";
    case "needs_review":
      return "Awaiting review";
    case "approved":
      return "Ready for next step";
    case "test_failed":
      return "Needs attention after failed checks";
    case "conflict":
      return "Blocked by merge conflict";
    case "blocked":
      return "Task is currently blocked";
    case "merged":
      return "Already merged";
    case "closed":
      return "Closed";
    default:
      return "Task state unavailable";
  }
}

function hasTaskConversation(gitRoot: string, taskId: string): boolean {
  return existsSync(dataPath(gitRoot, "desktop", "conversations", `task-${taskId}.json`));
}

// ── Draft task creation / promotion / reading ──

function createDesktopDraftTask(
  gitRoot: string,
  projectId: string,
  userGoal: string,
  sourceThreadId: string | null,
  planningFields?: {
    allowedFiles?: string[];
    acceptanceCriteria?: string[];
    commands?: string[];
    preferredExecutor?: string;
    assignedExecutor?: string;
    dependsOn?: string[];
    parallelizable?: boolean;
    priority?: string;
  },
): DesktopDraftTaskRecord {
  ensureDesktopStorage(gitRoot);
  const now = new Date().toISOString();
  const draftTask: DesktopDraftTaskRecord = {
    id: `DRAFT-${Date.now()}`,
    projectId,
    title: buildDraftTitle(userGoal),
    description: userGoal,
    status: "Draft",
    riskLevel: "medium",
    createdAt: now,
    updatedAt: now,
    sourceThreadId,
    allowedFiles: planningFields?.allowedFiles,
    acceptanceCriteria: planningFields?.acceptanceCriteria,
    commands: planningFields?.commands,
    preferredExecutor: planningFields?.preferredExecutor,
    assignedExecutor: planningFields?.assignedExecutor,
    dependsOn: planningFields?.dependsOn,
    parallelizable: planningFields?.parallelizable,
    priority: planningFields?.priority,
  };
  writeFileSync(getDesktopDraftTaskPath(gitRoot, draftTask.id), `${JSON.stringify(draftTask, null, 2)}\n`, "utf-8");
  return draftTask;
}

function createDraftTaskConversation(gitRoot: string, draftTask: DesktopDraftTaskRecord, initialMessage: string): DesktopConversationThread {
  const threadId = `task-${draftTask.id}`;
  const existing = readDesktopConversation(gitRoot, threadId);
  if (existing) return existing;
  const thread: DesktopConversationThread = {
    id: threadId,
    projectId: draftTask.projectId,
    kind: "task",
    taskId: draftTask.id,
    title: draftTask.title,
    status: "active",
    createdAt: draftTask.createdAt,
    updatedAt: draftTask.updatedAt,
    messages: initialMessage
      ? [buildScopeGuardMessage("summary", initialMessage, { taskId: draftTask.id, rawStatus: "planned" })]
      : [],
  };
  writeDesktopConversation(gitRoot, thread);
  return thread;
}

function promoteDesktopDraftTask(gitRoot: string, draftTask: DesktopDraftTaskRecord): TaskRecord {
  const tasksRoot = dataPath(gitRoot, "tasks");
  const taskDir = join(tasksRoot, draftTask.id);
  const taskPath = join(taskDir, "task.json");
  const now = new Date().toISOString();
  const inferred = inferDraftTaskDefaults(draftTask);
  mkdirSync(taskDir, { recursive: true });
  const allowedFiles = (draftTask.allowedFiles && draftTask.allowedFiles.length > 0)
    ? draftTask.allowedFiles
    : inferred.allowedFiles;
  const acceptanceCriteria = (draftTask.acceptanceCriteria && draftTask.acceptanceCriteria.length > 0)
    ? draftTask.acceptanceCriteria
    : inferred.acceptanceCriteria;
  const commands = (draftTask.commands && draftTask.commands.length > 0)
    ? draftTask.commands
    : inferred.commands;
  const taskRecord: TaskRecord = {
    id: draftTask.id,
    projectId: draftTask.projectId,
    requirementId: "desktop-conversation",
    title: draftTask.title,
    description: draftTask.description,
    status: allowedFiles.length > 0 ? "ready" : "planned",
    agentType: inferred.agentType,
    allowedFiles,
    lockedFiles: inferred.lockedFiles,
    forbiddenFiles: inferred.forbiddenFiles,
    dependencies: [],
    acceptanceCriteria,
    commands,
    riskLevel: inferred.riskLevel,
    branchName: null,
    worktreePath: null,
    diffPath: null,
    testLogPath: null,
    resultSummary: "Promoted from desktop draft conversation.",
    preferredExecutor: draftTask.preferredExecutor,
    assignedExecutor: draftTask.assignedExecutor,
    dependsOn: draftTask.dependsOn,
    parallelizable: draftTask.parallelizable,
    priority: draftTask.priority,
    createdAt: draftTask.createdAt,
    updatedAt: now,
  };
  writeFileSync(taskPath, `${JSON.stringify(taskRecord, null, 2)}\n`, "utf-8");
  rmSync(getDesktopDraftTaskPath(gitRoot, draftTask.id), { force: true });
  return taskRecord;
}

function readDesktopDraftTasks(gitRoot: string, projectId: string): DesktopDraftTaskRecord[] {
  const draftsRoot = getDesktopDraftTasksRoot(gitRoot);
  if (!existsSync(draftsRoot)) return [];
  const drafts: DesktopDraftTaskRecord[] = [];
  for (const entry of readdirSync(draftsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const draftTask = JSON.parse(readFileSync(join(draftsRoot, entry.name), "utf-8")) as DesktopDraftTaskRecord;
      if (draftTask.projectId === projectId) {
        drafts.push(draftTask);
      }
    } catch {
      // skip malformed draft task files
    }
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readDesktopDraftTaskById(gitRoot: string, taskId: string): DesktopDraftTaskRecord | null {
  const draftTaskPath = getDesktopDraftTaskPath(gitRoot, taskId);
  if (!existsSync(draftTaskPath)) return null;
  try {
    return JSON.parse(readFileSync(draftTaskPath, "utf-8")) as DesktopDraftTaskRecord;
  } catch {
    return null;
  }
}

function buildDraftTitle(userGoal: string): string {
  const trimmed = userGoal.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New task";
  let candidate = trimmed
    .replace(/^(?:please|can you|could you|help me|i need to|i want to|let's|lets)\s+/i, "")
    .replace(/^(?:请|帮我|麻烦你|我想|我需要|先帮我|请先|想要)\s*/u, "");
  candidate = candidate
    .split(/[\r\n.!?。！？]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)[0] ?? candidate;
  candidate = candidate
    .replace(/\b(?:so that|because|with the goal of)\b[\s\S]*$/i, "")
    .replace(/[,:;，：；]\s*$/, "")
    .trim();
  const clauseParts = candidate.split(/\s+(?:and|then|while|before|after)\s+/i);
  if (clauseParts[0] && clauseParts[0].length >= 12) {
    candidate = clauseParts[0].trim();
  }
  if (candidate.length > 56) {
    return `${candidate.slice(0, 53).trimEnd()}...`;
  }
  return candidate || "New task";
}

function inferDraftTaskDefaults(draftTask: DesktopDraftTaskRecord): {
  agentType: string;
  allowedFiles: string[];
  lockedFiles: string[];
  forbiddenFiles: string[];
  acceptanceCriteria: string[];
  commands: string[];
  riskLevel: "low" | "medium" | "high";
} {
  const text = `${draftTask.title}\n${draftTask.description}`.toLowerCase();
  const explicitPaths = extractExplicitPaths(draftTask.description);
  const inferredAllowed = new Set<string>(explicitPaths);
  if (text.includes("readme")) {
    inferredAllowed.add("README.md");
    inferredAllowed.add("README.zh-CN.md");
  }
  if (text.includes("doc")) {
    inferredAllowed.add("docs/**");
  }
  if (text.includes("frontend") || text.includes("ui") || text.includes("homepage") || text.includes("home page")) {
    inferredAllowed.add("apps/web/static/**");
  }
  if (text.includes("server") || text.includes("backend") || text.includes("api")) {
    inferredAllowed.add("apps/server/src/**");
  }
  const allowedFiles = [...inferredAllowed];
  const acceptanceCriteria = [
    "The task goal is implemented without unrelated changes.",
    "The final diff stays within the allowed file scope.",
  ];
  const commands = allowedFiles.some((pattern) => pattern.startsWith("apps/web/static"))
    ? ["node --check apps/web/static/app.js"]
    : allowedFiles.some((pattern) => pattern.startsWith("apps/server/src"))
      ? ["pnpm --filter @scopeguard/server typecheck"]
      : [];
  return {
    agentType: allowedFiles.some((pattern) => pattern.startsWith("apps/web/static")) ? "frontend" : "fullstack",
    allowedFiles,
    lockedFiles: [...allowedFiles],
    forbiddenFiles: DEFAULT_DESKTOP_FORBIDDEN_FILES,
    acceptanceCriteria,
    commands,
    riskLevel: "medium",
  };
}

function extractExplicitPaths(text: string): string[] {
  const matches = text.match(/\b(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|json|md|css|html)\b/g) ?? [];
  return [...new Set(matches.map((match) => normalizeSlashes(match)))].sort();
}

// ── Conversation / session / message helpers ──

function readDesktopConversation(gitRoot: string, threadId: string): DesktopConversationThread | null {
  const threadPath = getConversationPath(gitRoot, threadId);
  if (!existsSync(threadPath)) return null;
  try {
    const thread = JSON.parse(readFileSync(threadPath, "utf-8")) as DesktopConversationThread;
    return sanitizeDesktopConversationThread(thread);
  } catch {
    return null;
  }
}

function writeDesktopConversation(gitRoot: string, thread: DesktopConversationThread): void {
  ensureDesktopStorage(gitRoot);
  const threadPath = getConversationPath(gitRoot, thread.id);
  writeFileSync(threadPath, `${JSON.stringify(sanitizeDesktopConversationThread(thread), null, 2)}\n`, "utf-8");
}

function readDesktopSession(gitRoot: string): DesktopProjectSession {
  const sessionPath = getDesktopSessionPath(gitRoot);
  if (!existsSync(sessionPath)) return getDefaultDesktopSession();
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf-8")) as DesktopProjectSession;
    return isDesktopProjectSession(session) ? session : getDefaultDesktopSession();
  } catch {
    return getDefaultDesktopSession();
  }
}

function writeDesktopSession(gitRoot: string, session: DesktopProjectSession): void {
  ensureDesktopStorage(gitRoot);
  writeFileSync(getDesktopSessionPath(gitRoot), `${JSON.stringify(session, null, 2)}\n`, "utf-8");
}

function getDefaultDesktopSession(): DesktopProjectSession {
  return {
    activeProjectId: null,
    activeTaskId: null,
    activeThreadId: null,
    activeView: "home",
    drawerState: {
      contextOpen: false,
      logsOpen: false,
    },
  };
}

function buildScopeGuardMessage(kind: string, text: string, metadata?: Record<string, unknown>, actions?: unknown[]): DesktopMessage {
  return {
    id: `m-${Date.now()}`,
    role: "scopeguard",
    kind: kind as DesktopMessage["kind"],
    text,
    createdAt: new Date().toISOString(),
    metadata: metadata as DesktopMessage["metadata"],
    actions: actions as DesktopMessage["actions"],
  };
}

function updateDesktopTaskDetails(gitRoot: string, task: TaskRecord, payload: Record<string, unknown>): TaskRecord {
  const taskPath = dataPath(gitRoot, "tasks", task.id, "task.json");
  if (payload.allowedFiles !== undefined) {
    task.allowedFiles = sanitizeStringArray(payload.allowedFiles);
    task.lockedFiles = [...task.allowedFiles];
  }
  if (payload.acceptanceCriteria !== undefined) {
    task.acceptanceCriteria = sanitizeStringArray(payload.acceptanceCriteria);
  }
  if (payload.commands !== undefined) {
    task.commands = sanitizeStringArray(payload.commands);
  }
  if (task.status === "planned" || task.status === "ready") {
    task.status = task.allowedFiles.length > 0 ? "ready" : "planned";
  }
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");
  return task;
}

function renameDesktopProject(gitRoot: string, projectId: string, title: string): Record<string, unknown> {
  const project = buildDesktopProject(gitRoot);
  if (!project || project.id !== projectId) {
    return { ok: false, code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` };
  }
  const nextTitle = title.trim().replace(/\s+/g, " ");
  if (!nextTitle) return { ok: false, code: "INVALID_REQUEST", message: "title is required." };
  if (project.isInitialized) {
    const configPath = dataPath(gitRoot, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as { projectId: string; projectName: string; rootPath: string };
    config.projectName = nextTitle;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  } else {
    writeDesktopProjectMeta(gitRoot, {
      ...readDesktopProjectMeta(gitRoot),
      displayName: nextTitle,
    });
  }
  const thread = syncDesktopConversationTitle(gitRoot, `project-${projectId}`, nextTitle);
  return { ok: true, project: buildDesktopProject(gitRoot), thread };
}

function renameDesktopTask(gitRoot: string, taskId: string, title: string): Record<string, unknown> {
  const nextTitle = title.trim().replace(/\s+/g, " ");
  if (!nextTitle) return { ok: false, code: "INVALID_REQUEST", message: "title is required." };
  const task = readTaskById(gitRoot, taskId);
  if (task) {
    const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
    task.title = nextTitle;
    task.updatedAt = new Date().toISOString();
    writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");
    const thread = syncDesktopConversationTitle(gitRoot, `task-${taskId}`, nextTitle);
    return { ok: true, task: toDesktopTaskDetail(gitRoot, task), context: toDesktopTaskContext(gitRoot, task), thread };
  }
  const draftTask = readDesktopDraftTaskById(gitRoot, taskId);
  if (!draftTask) return { ok: false, code: "TASK_NOT_FOUND", message: `Task not found: ${taskId}` };
  draftTask.title = nextTitle;
  draftTask.updatedAt = new Date().toISOString();
  writeFileSync(getDesktopDraftTaskPath(gitRoot, draftTask.id), `${JSON.stringify(draftTask, null, 2)}\n`, "utf-8");
  const thread = syncDesktopConversationTitle(gitRoot, `task-${taskId}`, nextTitle);
  return { ok: true, task: toDesktopTaskDetailFromDraft(gitRoot, draftTask), context: toDesktopTaskContextFromDraft(draftTask), thread };
}

function syncDesktopConversationTitle(gitRoot: string, threadId: string, title: string): DesktopConversationThread | null {
  const thread = readDesktopConversation(gitRoot, threadId);
  if (!thread) return null;
  thread.title = title;
  thread.updatedAt = new Date().toISOString();
  writeDesktopConversation(gitRoot, thread);
  return thread;
}

// ── LLM Assistant ──

type AIConfig = {
  provider: string;
  providerPreset: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  codexBin: string;
};

async function runProjectAssistantTurn(gitRoot: string, aiConfig: AIConfig, projectId: string | null, userText: string): Promise<Record<string, unknown>> {
  const project = buildDesktopProject(gitRoot);
  if (!project || (projectId && project.id !== projectId)) {
    throw new Error(`Project not found: ${projectId ?? "unknown"}`);
  }
  const tasks = readAllTasks(gitRoot)
    .filter((task) => task.projectId === project.id)
    .filter((task) => !["merged", "closed"].includes(task.status))
    .map((task) => toDesktopTaskListItem(gitRoot, task));
  const draftTasks = readDesktopDraftTasks(gitRoot, project.id).map((draftTask) => toDesktopTaskListItemFromDraft(gitRoot, draftTask));
  const taskList = draftTasks.concat(tasks);
  const thread = readDesktopConversation(gitRoot, `project-${project.id}`);
  const projectMemory = readDesktopProjectMemory(gitRoot);
  const memoryIntent = detectProjectMemoryIntent(projectMemory, userText);
  if (memoryIntent?.type === "show") {
    return { message: buildScopeGuardMessage("summary", formatProjectMemorySummary(projectMemory)), memories: projectMemory };
  }
  if (memoryIntent?.type === "save" && memoryIntent.kind && memoryIntent.title && memoryIntent.content) {
    const record = appendDesktopProjectMemory(gitRoot, {
      kind: memoryIntent.kind,
      title: memoryIntent.title,
      content: memoryIntent.content,
      source: "user",
    });
    return { message: buildScopeGuardMessage("summary", `Saved: ${record.title} (${record.kind})`), memory: record, memories: readDesktopProjectMemory(gitRoot) };
  }
  if (memoryIntent?.type === "request-delete" && memoryIntent.memory) {
    return {
      message: buildScopeGuardMessage("summary", [
        `I found a project memory entry that matches: ${memoryIntent.memory.title}`,
        "",
        `Rule: ${memoryIntent.memory.content}`,
        "",
        `Reply "delete ${memoryIntent.memory.id}" to remove it.`,
      ].join("\n")),
    };
  }
  if (memoryIntent?.type === "confirm-delete" && memoryIntent.memoryId) {
    const removed = removeDesktopProjectMemory(gitRoot, memoryIntent.memoryId);
    return {
      message: buildScopeGuardMessage("summary", removed
        ? `I removed the project memory entry: ${removed.title}`
        : `I could not find a project memory entry for id: ${memoryIntent.memoryId}`),
      memories: readDesktopProjectMemory(gitRoot),
    };
  }
  const assistant = await requestDesktopLLM(aiConfig, {
    scope: "project",
    userText,
    context: {
      project,
      tasks: taskList,
      projectMemory: projectMemory.slice(-5),
      recentMessages: (thread?.messages ?? []).slice(-8).map((message) => ({ role: message.role, text: message.text })),
    },
  });
  return applyProjectAssistantResult(gitRoot, project, thread, userText, assistant);
}

function applyProjectAssistantResult(gitRoot: string, project: DesktopProject | null, thread: DesktopConversationThread | null, userText: string, assistant: { reply?: string; action?: { type?: string; taskGoal?: string } }): Record<string, unknown> {
  if (assistant.action?.type === "start_task") {
    const draftTask = createDesktopDraftTask(gitRoot, project!.id, assistant.action.taskGoal || userText, thread?.id ?? null);
    const taskThread = createDraftTaskConversation(gitRoot, draftTask, "Task created. Continue here to define the first concrete changes and then start editing files.");
    return {
      message: buildScopeGuardMessage("summary", assistant.reply || `I created a new draft task: ${draftTask.title}.`, { taskId: draftTask.id, rawStatus: "planned" }),
      draftTask,
      thread: taskThread,
      openTaskId: draftTask.id,
    };
  }
  return { message: buildScopeGuardMessage("summary", assistant.reply ?? "") };
}

async function runTaskAssistantTurn(gitRoot: string, aiConfig: AIConfig, taskId: string | null, userText: string): Promise<Record<string, unknown>> {
  if (!taskId) throw new Error("taskId is required for task assistant turns.");
  const task = readTaskById(gitRoot, taskId);
  const draftTask = task ? null : readDesktopDraftTaskById(gitRoot, taskId);
  if (!task && !draftTask) throw new Error(`Task not found: ${taskId}`);
  const detail = task ? toDesktopTaskDetail(gitRoot, task) : toDesktopTaskDetailFromDraft(gitRoot, draftTask!);
  const context = task ? toDesktopTaskContext(gitRoot, task) : toDesktopTaskContextFromDraft(draftTask!);
  const thread = readDesktopConversation(gitRoot, `task-${taskId}`);
  const assistant = await requestDesktopLLM(aiConfig, {
    scope: "task",
    userText,
    context: {
      task: detail,
      taskContext: context,
      projectMemory: readDesktopProjectMemory(gitRoot).slice(-5),
      recentMessages: (thread?.messages ?? []).slice(-8).map((message) => ({ role: message.role, text: message.text })),
    },
  });
  return applyTaskAssistantResult(gitRoot, taskId, userText, task, draftTask, assistant);
}

function applyTaskAssistantResult(
  gitRoot: string,
  taskId: string,
  userText: string,
  task: TaskRecord | null,
  draftTask: DesktopDraftTaskRecord | null,
  assistant: { reply?: string; action?: { type?: string; target?: string; allowedFiles?: string[]; acceptanceCriteria?: string[]; commands?: string[] } },
): Record<string, unknown> {
  if (assistant.action?.type === "refine_task" && draftTask) {
    const promotedTask = promoteDesktopDraftTask(gitRoot, draftTask);
    return {
      message: buildScopeGuardMessage("summary", assistant.reply || "I refined this draft into a formal task.", { taskId, rawStatus: promotedTask.status }),
      task: toDesktopTaskDetail(gitRoot, promotedTask),
      context: toDesktopTaskContext(gitRoot, promotedTask),
    };
  }
  if (assistant.action?.type === "review_task" && task) {
    const result = generateReviewReport(gitRoot, taskId);
    if (result.ok) {
      return {
        message: buildScopeGuardMessage("review", assistant.reply || "Review is ready.", { taskId, reportPath: result.reviewPath, rawStatus: task.status }),
      };
    }
  }
  if (assistant.action?.type === "approve_task" && task) {
    const approved = approveDesktopTask(gitRoot, taskId);
    if (approved.ok) {
      return {
        message: buildScopeGuardMessage("approval_result", assistant.reply || "Approval recorded.", { taskId, rawStatus: "approved" }),
      };
    }
  }
  if (assistant.action?.type === "handoff_task" && task) {
    const target = assistant.action.target === "claude" ? "claude" : "codex";
    const handoffText = buildDesktopHandoff(gitRoot, task, target);
    return {
      message: buildScopeGuardMessage("handoff", assistant.reply || `I prepared the ${target} handoff below.\n\n${handoffText}`, { taskId, handoffTarget: target, rawStatus: task.status }),
      handoffText,
    };
  }
  if (assistant.action?.type === "update_task_details" && task) {
    const updatedTask = updateDesktopTaskDetails(gitRoot, task, {
      allowedFiles: assistant.action.allowedFiles,
      acceptanceCriteria: assistant.action.acceptanceCriteria,
      commands: assistant.action.commands,
    });
    return {
      message: buildScopeGuardMessage("summary", assistant.reply || "Task details updated.", { taskId, rawStatus: updatedTask.status }),
      task: toDesktopTaskDetail(gitRoot, updatedTask),
      context: toDesktopTaskContext(gitRoot, updatedTask),
    };
  }
  return { message: buildScopeGuardMessage("summary", assistant.reply ?? "") };
}

async function requestDesktopLLM(aiConfig: AIConfig, input: { scope: string; userText: string; context: Record<string, unknown> }): Promise<{ reply: string; action?: { type?: string; target?: string; taskGoal?: string; allowedFiles?: string[]; acceptanceCriteria?: string[]; commands?: string[] } }> {
  const prompts = buildAssistantPrompts(input.scope, input.context, input.userText);
  const rawText = aiConfig.provider === "codex-account"
    ? requestCodexCliAssistant(aiConfig, prompts.systemPrompt, prompts.rawPrompt)
    : aiConfig.provider === "anthropic"
      ? await requestAnthropicCompatible(aiConfig, prompts.systemPrompt, prompts.rawPrompt)
      : await requestOpenAICompatible(aiConfig, prompts.systemPrompt, prompts.rawPrompt);
  if (!rawText) {
    return { reply: "No response came back from the model.", action: { type: "none" } };
  }
  return sanitizeAssistantResponseAction(input.scope, parseAssistantJsonResponse(rawText));
}

function buildAssistantPrompts(scope: string, context: Record<string, unknown>, userText: string): { systemPrompt: string; rawPrompt: string } {
  const systemPrompt = scope === "project"
    ? [
      "You are ScopeGuard, an AI coding assistant inside a desktop IDE.",
      "Reply like Codex or Claude: calm, direct, concise, and context-aware.",
      "Do not sound like customer support. Do not say 'What can I help with?' unless the user explicitly asks for options.",
      "Use the current project context in your answer when relevant.",
      "If the user greeting is brief, reply briefly and naturally.",
      "Do not pretend to inspect files, browse folders, or run checks unless the context already includes those results.",
      "Never emit tool calls, XML tags, <tool_call> blocks, bash commands, or pseudo-actions in your reply.",
      "Avoid report style. Do not produce directory trees, separators, or long numbered plans for simple questions.",
      "For an empty or new project, answer in 1-3 short sentences and ask for one concrete goal.",
      "If the user asks to create or start a task, you may include a JSON action block like {\"action\":{\"type\":\"start_task\",\"taskGoal\":\"<short task title>\"}}.",
      "Do not emit any other project action types.",
      "Otherwise reply in plain text.",
      "Do not mention configuration status, setup status, disclaimers, emojis, markdown headings, or bullet-heavy boilerplate.",
      "If you include a JSON action block, keep the natural-language reply outside it short.",
    ].join(" ")
    : [
      "You are ScopeGuard, an AI coding assistant inside a desktop IDE, focused on the current task.",
      "Reply like Codex or Claude: calm, direct, concise, and specific to the current task.",
      "Do not sound like customer support. Avoid generic encouragement and avoid asking broad follow-up questions unless needed.",
      "Use the task context in your answer when relevant.",
      "If the user greeting is brief, reply briefly and naturally.",
      "Do not pretend to inspect files, browse folders, or run checks unless the context already includes those results.",
      "Never emit tool calls, XML tags, <tool_call> blocks, bash commands, or pseudo-actions in your reply.",
      "Do not claim that files were created, edited, or executed unless ScopeGuard has actually completed that work.",
      "Avoid report style, long numbered plans, and unnecessary summaries.",
      "The only valid task actions are refine_task, review_task, approve_task, handoff_task, and update_task_details.",
      "Never emit unsupported actions such as create_files, write_files, run_shell, or tool-like operations.",
      "If a structured action is needed, you may include a JSON action block like {\"action\":{\"type\":\"review_task\"}} or another valid task action.",
      "Otherwise reply in plain text.",
      "Do not mention configuration status, setup status, disclaimers, emojis, markdown headings, or bullet-heavy boilerplate.",
      "If you include a JSON action block, keep the natural-language reply outside it short.",
    ].join(" ");
  const rawPrompt = [
    `Context:\n${JSON.stringify(context, null, 2)}`,
    `User request:\n${userText}`,
    "Respond naturally in plain text.",
    "Only include a JSON action block if a concrete project or task action should run.",
    "Avoid generic assistant phrases like 'How can I help?' or 'I am happy to assist.'",
  ].join("\n\n");
  return { systemPrompt, rawPrompt };
}

function parseAssistantJsonResponse(rawText: string): { reply: string; action?: { type?: string; target?: string; taskGoal?: string; allowedFiles?: string[]; acceptanceCriteria?: string[]; commands?: string[] } } {
  const normalized = String(rawText || "").trim();
  const cleaned = stripAssistantScaffolding(normalized);
  const structured = extractStructuredAssistantPayload(cleaned) || extractStructuredAssistantPayload(normalized);
  if (structured) {
    const replyText = structured.reply
      || stripAssistantScaffolding(removeSnippetOnce(cleaned, structured.rawJson))
      || stripAssistantScaffolding(removeSnippetOnce(normalized, structured.rawJson))
      || "Done.";
    return { reply: replyText, action: structured.action || { type: "none" } };
  }
  const candidates = [cleaned, extractLastJsonObject(cleaned), extractLastJsonObject(normalized)].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { reply?: string; action?: { type?: string } };
      if (typeof parsed.reply === "string" && parsed.reply.trim()) {
        return { reply: parsed.reply.trim(), action: parsed.action && typeof parsed.action === "object" ? parsed.action : { type: "none" } };
      }
    } catch {
      // try next candidate
    }
  }
  return { reply: cleaned || normalized, action: { type: "none" } };
}

function sanitizeAssistantResponseAction(scope: string, response: { reply: string; action?: { type?: string } }): { reply: string; action?: { type?: string } } {
  const actionType = response.action?.type || "none";
  const allowed = scope === "project" ? PROJECT_ASSISTANT_ACTIONS : TASK_ASSISTANT_ACTIONS;
  if (!allowed.has(actionType)) {
    response.action = undefined;
  }
  let sanitizedReply = response.reply || "";
  const bannedPatterns: [RegExp, string][] = [
    [/\b(?:I have created|I created|I've created|I wrote|I've written|file has been created|files? created)\b.*$/gim, ""],
    [/\b(?:I executed|I ran|I've executed|I have run)\b.*$/gim, ""],
    [/\b(?:The (?:file|change|modification) (?:was|has been) (?:created|written|saved|applied|made))\b.*$/gim, ""],
    [/\b(?:成功创建了?|已创建了?|已写入|文件已创建|已执行)\b.*$/gim, ""],
    [/```[\s\S]*?```/g, "[code block removed]"],
  ];
  for (const [pattern, replacement] of bannedPatterns) {
    sanitizedReply = sanitizedReply.replace(pattern, replacement);
  }
  sanitizedReply = sanitizedReply.trim();
  return { reply: sanitizedReply || response.reply || "", action: response.action?.type ? response.action : { type: "none" } };
}

function extractStructuredAssistantPayload(text: string): { reply: string; action?: { type?: string; target?: string; taskGoal?: string; allowedFiles?: string[]; acceptanceCriteria?: string[]; commands?: string[] }; rawJson: string } | null {
  const jsonCandidates = collectJsonCandidates(text);
  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate) as { reply?: string; action?: Record<string, unknown> };
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      const action = parsed.action && typeof parsed.action === "object" ? parsed.action : undefined;
      if (reply || action?.type) {
        return { reply, action: action as { type?: string; target?: string; taskGoal?: string; allowedFiles?: string[]; acceptanceCriteria?: string[]; commands?: string[] } | undefined, rawJson: candidate };
      }
    } catch {
      // ignore malformed candidate
    }
  }
  return null;
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceMatches = text.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
  for (const match of fenceMatches) {
    const inner = match.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    if (inner) candidates.push(inner);
  }
  const lastObject = extractLastJsonObject(text);
  if (lastObject) candidates.push(lastObject);
  if (text.trim()) candidates.push(text.trim());
  return [...new Set(candidates)];
}

function stripAssistantScaffolding(text: string): string {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function removeSnippetOnce(text: string, snippet: string): string {
  const source = String(text || "");
  const target = String(snippet || "");
  if (!source || !target) return source;
  const index = source.lastIndexOf(target);
  if (index < 0) return source;
  return `${source.slice(0, index)}${source.slice(index + target.length)}`.trim();
}

function extractLastJsonObject(text: string): string {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  let lastObject = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) { escaped = false; } else if (char === "\\") { escaped = true; } else if (char === "\"") { inString = false; }
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{") { if (depth === 0) start = i; depth++; continue; }
    if (char === "}") { if (depth > 0) { depth--; if (depth === 0 && start >= 0) { lastObject = text.slice(start, i + 1); start = -1; } } }
  }
  return lastObject;
}

function resolveAIConfig(): AIConfig {
  const provider = (process.env.AI_PROVIDER?.trim() || "openai-compatible").toLowerCase();
  const apiKey = process.env.API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  const baseUrl = (process.env.BASE_URL?.trim()
    || (provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim() || process.env.SCOPEGUARD_MODEL?.trim() || "gpt-4.1-mini";
  const codexBin = process.env.CODEX_BIN?.trim() || "";
  const providerPreset = provider === "anthropic"
    ? "anthropic-claude"
    : provider === "codex-account"
      ? "codex-account"
      : "openai-gpt";
  return { provider, providerPreset, apiKey, baseUrl, model, codexBin };
}

function resolveEffectiveAIConfig(gitRoot: string): AIConfig {
  const envConfig = resolveAIConfig();
  const savedConfig = readDesktopAIConfig(gitRoot);
  return {
    provider: savedConfig.provider || envConfig.provider,
    providerPreset: savedConfig.providerPreset || envConfig.providerPreset,
    apiKey: savedConfig.apiKey || envConfig.apiKey,
    baseUrl: savedConfig.baseUrl || envConfig.baseUrl,
    model: savedConfig.model || envConfig.model,
    codexBin: savedConfig.codexBin || envConfig.codexBin,
  };
}

async function requestOpenAICompatible(aiConfig: AIConfig, systemPrompt: string, rawPrompt: string): Promise<string> {
  const requestUrl = `${aiConfig.baseUrl}/chat/completions`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${aiConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: aiConfig.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: rawPrompt },
      ],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const minimaxHint = response.status === 404 && /api\.minimax\.io/i.test(aiConfig.baseUrl)
      ? " MiniMax China accounts often need https://api.minimaxi.com/v1 instead of https://api.minimax.io/v1."
      : "";
    throw new Error(`AI request failed with ${response.status} at ${requestUrl}: ${errorText}${minimaxHint}`);
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content ?? "";
}

async function requestAnthropicCompatible(aiConfig: AIConfig, systemPrompt: string, rawPrompt: string): Promise<string> {
  const requestUrl = `${aiConfig.baseUrl}/messages`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiConfig.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: aiConfig.model,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content: rawPrompt }],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI request failed with ${response.status} at ${requestUrl}: ${errorText}`);
  }
  const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  return payload.content?.find((item) => item.type === "text")?.text ?? "";
}

async function* streamOpenAICompatible(aiConfig: AIConfig, systemPrompt: string, rawPrompt: string): AsyncGenerator<string> {
  const requestUrl = `${aiConfig.baseUrl}/chat/completions`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${aiConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: aiConfig.model,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: rawPrompt },
      ],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI stream request failed with ${response.status} at ${requestUrl}: ${errorText}`);
  }
  if (!response.body) throw new Error("No response body for stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* streamAnthropicCompatible(aiConfig: AIConfig, systemPrompt: string, rawPrompt: string): AsyncGenerator<string> {
  const requestUrl = `${aiConfig.baseUrl}/messages`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiConfig.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: aiConfig.model,
      max_tokens: 4096,
      system: systemPrompt,
      stream: true,
      messages: [{ role: "user", content: rawPrompt }],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI stream request failed with ${response.status} at ${requestUrl}: ${errorText}`);
  }
  if (!response.body) throw new Error("No response body for stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        try {
          const parsed = JSON.parse(data) as { type?: string; delta?: { text?: string } };
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function requestCodexCliAssistant(aiConfig: AIConfig, systemPrompt: string, rawPrompt: string): string {
  const codexBin = resolveCodexCliBinary(aiConfig.codexBin);
  if (!codexBin) {
    throw new Error("Codex CLI was not found. Install it or set CODEX_BIN before using AI_PROVIDER=codex-account.");
  }
  const prompt = `${systemPrompt}\n\n${rawPrompt}`;
  const result = spawnSync(codexBin, ["exec", prompt], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 1000 * 60 * 5,
    windowsHide: true,
    env: { ...process.env, ...(aiConfig.model ? { OPENAI_MODEL: aiConfig.model } : {}) },
  });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Codex CLI exited with status ${String(result.status)}`);
  }
  return (result.stdout ?? "").trim();
}

function resolveCodexCliBinary(configuredCodexBin: string): string | null {
  const isWindows = process.platform === "win32";
  const candidates: string[] = [];
  const envCodexBin = configuredCodexBin || process.env.CODEX_BIN?.trim();
  if (envCodexBin) candidates.push(envCodexBin);
  candidates.push("codex");
  if (isWindows) candidates.push("codex.cmd", "codex.ps1");
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item, index, array) => item.length > 0 && array.indexOf(item) === index);
}

function approveDesktopTask(gitRoot: string, taskId: string): { ok: boolean; message: string; task?: TaskRecord } {
  const taskDir = dataPath(gitRoot, "tasks", taskId);
  const taskPath = dataPath(gitRoot, "tasks", taskId, "task.json");
  const verifyReportPath = join(taskDir, "verify-report.json");
  const reviewPath = join(taskDir, "review.md");
  console.log("[approveDesktopTask] enter taskId=" + taskId + " gitRoot=" + gitRoot);
  console.log("[approveDesktopTask] taskDir=" + taskDir + " taskPath=" + taskPath + " reviewPath=" + reviewPath);
  const task = readTaskById(gitRoot, taskId);
  if (!task) {
    console.log("[approveDesktopTask] FAIL task not found: " + taskId);
    return { ok: false, message: `Task not found: ${taskId}` };
  }
  console.log("[approveDesktopTask] task status=" + task.status + " title=" + task.title + " id=" + task.id);
  if (task.status !== "needs_review") {
    console.log("[approveDesktopTask] FAIL status is " + task.status + " not needs_review");
    return { ok: false, message: `Task ${taskId} cannot be approved because status is ${task.status}.` };
  }
  const taskWithReview = task as TaskRecord & {
    latestRunResult?: { status?: string | null } | null;
    latestReviewSummary?: { status?: string | null; suggestion?: string | null } | null;
  };
  console.log("[approveDesktopTask] latestRunResult=" + JSON.stringify(taskWithReview.latestRunResult) + " latestReviewSummary=" + JSON.stringify(taskWithReview.latestReviewSummary));
  let verificationPassed = false;
  if (existsSync(verifyReportPath)) {
    console.log("[approveDesktopTask] verifyReportPath EXISTS at " + verifyReportPath);
    try {
      const verifyReport = JSON.parse(readFileSync(verifyReportPath, "utf-8")) as { status?: string };
      verificationPassed = verifyReport.status === "passed";
      console.log("[approveDesktopTask] verifyReport status=" + verifyReport.status + " verificationPassed=" + String(verificationPassed));
      if (!verificationPassed) {
        console.log("[approveDesktopTask] FAIL verification not passed");
        return { ok: false, message: `Task ${taskId} cannot be approved because verification has not passed.` };
      }
    } catch (parseErr) {
      console.log("[approveDesktopTask] FAIL verify report parse error: " + (parseErr instanceof Error ? parseErr.message : String(parseErr)));
      return { ok: false, message: `Task ${taskId} cannot be approved because verification report is invalid.` };
    }
  } else {
    console.log("[approveDesktopTask] verifyReportPath does NOT exist at " + verifyReportPath);
  }
  const latestReviewStatus = typeof taskWithReview.latestReviewSummary?.status === "string"
    ? taskWithReview.latestReviewSummary.status
    : null;
  const connectedReviewReady = taskWithReview.latestRunResult?.status === "succeeded"
    && latestReviewStatus === "ready_for_review";
  console.log("[approveDesktopTask] verificationPassed=" + String(verificationPassed) + " connectedReviewReady=" + String(connectedReviewReady) + " latestReviewStatus=" + String(latestReviewStatus));
  if (!verificationPassed && !connectedReviewReady) {
    console.log("[approveDesktopTask] FAIL neither verificationPassed nor connectedReviewReady");
    return { ok: false, message: `Task ${taskId} cannot be approved because verification has not passed.` };
  }
  if (!existsSync(reviewPath)) {
    console.log("[approveDesktopTask] reviewPath does NOT exist at " + reviewPath + " connectedReviewReady=" + String(connectedReviewReady));
    if (connectedReviewReady && typeof taskWithReview.latestReviewSummary?.suggestion === "string" && taskWithReview.latestReviewSummary.suggestion.trim().length > 0) {
      const reviewContent = `# Review Report: ${task.id}\n\n## Summary\n${taskWithReview.latestReviewSummary.suggestion.trim()}\n`;
      writeFileSync(reviewPath, reviewContent, "utf-8");
      console.log("[approveDesktopTask] wrote review.md from reviewSummary suggestion, length=" + reviewContent.length);
    } else {
      console.log("[approveDesktopTask] FAIL reviewPath missing and cannot synthesize from suggestion");
      return { ok: false, message: `Task ${taskId} cannot be approved because review report is missing.` };
    }
  } else {
    console.log("[approveDesktopTask] reviewPath EXISTS at " + reviewPath);
  }
  task.status = "approved";
  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf-8");
  console.log("[approveDesktopTask] SUCCESS task " + taskId + " approved at " + task.updatedAt);
  return { ok: true, message: "Task approved.", task };
}

function buildDesktopHandoff(gitRoot: string, task: TaskRecord | DesktopDraftTaskRecord, target: string): string {
  const realTask = task as TaskRecord;
  const handoff = buildTaskHandoffPayload(gitRoot, realTask);
  return buildExecutorHandoffPrompt(handoff, target);
}

// ── Path getters ──

function getConversationPath(gitRoot: string, threadId: string): string {
  return dataPath(gitRoot, "desktop", "conversations", `${threadId}.json`);
}

function getDesktopDraftTasksRoot(gitRoot: string): string {
  return dataPath(gitRoot, "desktop", "draft-tasks");
}

function getDesktopDraftTaskPath(gitRoot: string, taskId: string): string {
  return join(getDesktopDraftTasksRoot(gitRoot), `${taskId}.json`);
}

function getDesktopSessionPath(gitRoot: string): string {
  return dataPath(gitRoot, "desktop", "ui-state.json");
}

function getDesktopProjectMetaPath(gitRoot: string): string {
  return dataPath(gitRoot, "desktop", "project-meta.json");
}

function getDesktopProjectMemoryPath(gitRoot: string): string {
  return dataPath(gitRoot, "desktop", "project-memory.json");
}

function getDesktopAIConfigPath(gitRoot: string): string {
  return join(getDesktopAIConfigRoot(), `${hashProjectRoot(gitRoot)}.json`);
}

function getDesktopAIConfigRoot(): string {
  const baseDir = process.env.APPDATA?.trim()
    ? join(process.env.APPDATA.trim(), "ScopeGuard")
    : join(homedir(), ".scopeguard");
  return join(baseDir, "desktop");
}

function hashProjectRoot(gitRoot: string): string {
  return createHash("sha1").update(resolve(gitRoot)).digest("hex");
}

function ensureDesktopStorage(gitRoot: string): void {
  mkdirSync(dataPath(gitRoot, "desktop"), { recursive: true });
  mkdirSync(dataPath(gitRoot, "desktop", "conversations"), { recursive: true });
  mkdirSync(getDesktopDraftTasksRoot(gitRoot), { recursive: true });
}

// ── Project meta / memory / AI config / executor config ──

function readDesktopProjectMeta(gitRoot: string): { displayName: string | null; trusted: boolean } {
  const metaPath = getDesktopProjectMetaPath(gitRoot);
  if (!existsSync(metaPath)) return { displayName: null, trusted: false };
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { displayName?: string; trusted?: boolean };
    return {
      displayName: typeof meta.displayName === "string" && meta.displayName.trim().length > 0 ? meta.displayName.trim() : null,
      trusted: meta.trusted === true,
    };
  } catch {
    return { displayName: null, trusted: false };
  }
}

function readDesktopProjectMemory(gitRoot: string): Array<{ id: string; kind: string; title: string; content: string; source: string; createdAt: string; updatedAt: string }> {
  const memoryPath = getDesktopProjectMemoryPath(gitRoot);
  if (!existsSync(memoryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(memoryPath, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry: unknown) => sanitizeDesktopProjectMemoryRecord(entry))
      .filter((entry): entry is { id: string; kind: string; title: string; content: string; source: string; createdAt: string; updatedAt: string } => entry !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function writeDesktopProjectMeta(gitRoot: string, meta: { displayName: string | null; trusted: boolean }): void {
  ensureDesktopStorage(gitRoot);
  writeFileSync(getDesktopProjectMetaPath(gitRoot), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

function writeDesktopProjectMemory(gitRoot: string, records: unknown[]): void {
  ensureDesktopStorage(gitRoot);
  writeFileSync(getDesktopProjectMemoryPath(gitRoot), `${JSON.stringify(records, null, 2)}\n`, "utf-8");
}

function appendDesktopProjectMemory(
  gitRoot: string,
  input: { kind: string; title: string; content: string; source: string },
): { id: string; kind: string; title: string; content: string; source: string; createdAt: string; updatedAt: string } {
  const now = new Date().toISOString();
  const records = readDesktopProjectMemory(gitRoot);
  const record = { id: randomUUID(), kind: input.kind, title: input.title, content: input.content, source: input.source, createdAt: now, updatedAt: now };
  records.unshift(record);
  writeDesktopProjectMemory(gitRoot, records.slice(0, 100));
  return record;
}

function removeDesktopProjectMemory(gitRoot: string, memoryId: string): { id: string; kind: string; title: string; content: string; source: string; createdAt: string; updatedAt: string } | null {
  const records = readDesktopProjectMemory(gitRoot);
  const target = records.find((record) => record.id === memoryId) ?? null;
  if (!target) return null;
  writeDesktopProjectMemory(gitRoot, records.filter((record) => record.id !== memoryId));
  return target;
}

function detectProjectMemoryIntent(
  memories: Array<{ id: string; kind: string; title: string; content: string }>,
  userText: string,
): { type: string; kind?: string; title?: string; content?: string; memoryId?: string; memory?: { id: string; title: string; content: string } } | null {
  const normalized = userText.trim();
  const lower = normalized.toLowerCase();
  if (/^(show|list|view)\s+(the\s+)?project memory\b/i.test(normalized)
    || /^(what do you remember|what rules do you remember)\b/i.test(normalized)
    || /^(显示|查看|列出)(一下)?项目记忆/.test(normalized)
    || /^(项目记忆|项目规则)(有哪些|是什么|看看|列表)/.test(normalized)) {
    return { type: "show" };
  }
  const confirmDelete = normalized.match(/^确认删除项目记忆[：:\s]+([a-f0-9-]{8,})$/i)
    || normalized.match(/^confirm\s+delete\s+project\s+memory[:\s]+([a-f0-9-]{8,})$/i);
  if (confirmDelete?.[1]) {
    return { type: "confirm-delete", memoryId: confirmDelete[1].trim() };
  }
  const deleteMatch = normalized.match(/^(?:删除|移除|忘记)(?:这条规则|这个规则|这条记忆|这个记忆|项目记忆)?[：:\s]+(.+)$/u)
    || normalized.match(/^(?:delete|remove|forget)\s+(?:this\s+)?(?:rule|memory|project memory)?[:\s]+(.+)$/i);
  if (deleteMatch?.[1]) {
    const memory = findProjectMemoryMatch(deleteMatch[1].trim(), memories);
    if (memory) return { type: "request-delete", memory };
  }
  const explicitRemember = normalized.match(/^(?:记住(?:这条规则|这个规则|这个模式)?|保存(?:这条规则|这个规则|这个模式)?|项目里记住)(?:[：:\s]+)(.+)$/u)
    || normalized.match(/^(?:remember|save)(?:\s+this\s+(?:rule|pattern))?(?:[:\s]+)(.+)$/i);
  if (explicitRemember?.[1]) {
    const content = explicitRemember[1].trim();
    return buildProjectMemorySaveIntent(content);
  }
  const defaultRulePrefixes = ["以后默认", "这个项目以后默认", "这个仓库以后默认", "项目默认", "默认规则是", "默认使用"];
  const defaultPrefix = defaultRulePrefixes.find((prefix) => normalized.startsWith(prefix));
  if (defaultPrefix) {
    const content = normalized.slice(defaultPrefix.length).replace(/^[：:\s]+/, "").trim();
    return buildProjectMemorySaveIntent(content.length > 0 ? defaultPrefix + content : normalized);
  }
  if (lower.startsWith("for this project, default ")
    || lower.startsWith("project default: ")
    || lower.startsWith("default for this project: ")) {
    const content = normalized.replace(/^(for this project,\s*default|project default|default for this project)\s*[：:]?\s*/i, "").trim();
    return buildProjectMemorySaveIntent(content.length > 0 ? "Default for this project: " + content : normalized);
  }
  return null;
}

function buildProjectMemorySaveIntent(content: string): { type: string; kind: string; title: string; content: string } | null {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const kind = /review|审查|评审/.test(lower) || /review|审查|评审/u.test(normalized)
    ? "review"
    : /default|prefer|always|规则|默认|优先|固定|必须/.test(lower) || /规则|默认|优先|固定|必须/u.test(normalized)
      ? "pattern"
      : "note";
  return { type: "save", kind, title: buildProjectMemoryTitle(normalized), content: normalized };
}

function findProjectMemoryMatch(query: string, memories: Array<{ id: string; title: string; content: string }>): { id: string; title: string; content: string } | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return memories.find((memory) => memory.id.toLowerCase() === normalized
    || memory.title.toLowerCase().includes(normalized)
    || memory.content.toLowerCase().includes(normalized)) ?? null;
}

function buildProjectMemoryTitle(content: string): string {
  const firstLine = content.split(/\r?\n/)[0]?.trim() || content.trim();
  if (firstLine.length <= 56) return firstLine;
  return `${firstLine.slice(0, 53).trimEnd()}...`;
}

function formatProjectMemorySummary(memories: Array<{ kind: string; title: string; content: string }>): string {
  if (memories.length === 0) {
    return "Project memory is empty right now. Say something like `记住这条规则：前端任务默认只改 apps/web/static` and I will save it.";
  }
  const lines = ["Current project memory:", ""];
  for (const memory of memories.slice(0, 8)) {
    lines.push(`- [${memory.kind}] ${memory.title}`);
    lines.push(`  ${memory.content}`);
  }
  return lines.join("\n");
}

function readDesktopAIConfig(gitRoot: string): AIConfig {
  const configPath = getDesktopAIConfigPath(gitRoot);
  if (!existsSync(configPath)) {
    const resolved = resolveAIConfig();
    return { ...resolved, codexBin: process.env.CODEX_BIN?.trim() || "" };
  }
  try {
    return sanitizeDesktopAIConfig(JSON.parse(readFileSync(configPath, "utf-8")));
  } catch {
    const resolved = resolveAIConfig();
    return { ...resolved, codexBin: process.env.CODEX_BIN?.trim() || "" };
  }
}

function writeDesktopAIConfig(gitRoot: string, config: AIConfig): void {
  mkdirSync(dirname(getDesktopAIConfigPath(gitRoot)), { recursive: true });
  writeFileSync(getDesktopAIConfigPath(gitRoot), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function sanitizeDesktopAIConfig(value: unknown): AIConfig {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const provider = typeof candidate.provider === "string" && candidate.provider.trim().length > 0
    ? candidate.provider.trim().toLowerCase()
    : "openai-compatible";
  const providerPreset = typeof candidate.providerPreset === "string" && candidate.providerPreset.trim().length > 0
    ? candidate.providerPreset.trim().toLowerCase()
    : provider === "anthropic"
      ? "anthropic-claude"
      : provider === "codex-account"
        ? "codex-account"
        : "openai-gpt";
  const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
  const baseUrl = typeof candidate.baseUrl === "string" ? normalizeProviderBaseUrl(candidate.baseUrl.trim(), provider) : "";
  const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
  const codexBin = typeof candidate.codexBin === "string" ? candidate.codexBin.trim() : "";
  return { provider, providerPreset, apiKey, baseUrl, model, codexBin };
}

function normalizeProviderBaseUrl(baseUrl: string, provider: string): string {
  let normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalized) return normalized;
  if (provider === "anthropic") {
    normalized = normalized.replace(/\/messages$/i, "");
    return normalized;
  }
  normalized = normalized.replace(/\/chat\/completions$/i, "").replace(/\/responses$/i, "").replace(/\/models$/i, "");
  return normalized;
}

// ── Executor config ──

function getDesktopExecutorConfigPath(gitRoot: string): string {
  return join(getDesktopAIConfigRoot(), `executor-${hashProjectRoot(gitRoot)}.json`);
}

function readDesktopExecutorConfig(gitRoot: string): DesktopExecutorConfig {
  const configPath = getDesktopExecutorConfigPath(gitRoot);
  if (!existsSync(configPath)) return { codexCommand: "", claudeCommand: "" };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as { codexCommand?: string; claudeCommand?: string };
    return {
      codexCommand: typeof parsed.codexCommand === "string" ? parsed.codexCommand.trim() : "",
      claudeCommand: typeof parsed.claudeCommand === "string" ? parsed.claudeCommand.trim() : "",
    };
  } catch {
    return { codexCommand: "", claudeCommand: "" };
  }
}

function writeDesktopExecutorConfig(gitRoot: string, config: DesktopExecutorConfig): void {
  mkdirSync(dirname(getDesktopExecutorConfigPath(gitRoot)), { recursive: true });
  writeFileSync(getDesktopExecutorConfigPath(gitRoot), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function handleGetDesktopExecutorConfig(gitRoot: string, res: ServerResponse): void {
  sendJson(res, 200, { config: readDesktopExecutorConfig(gitRoot) });
}

async function handlePutDesktopExecutorConfig(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readRequestBody(req);
  let payload: { config?: Record<string, unknown> };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON body." });
    return;
  }
  const raw = payload.config ?? {};
  const config: DesktopExecutorConfig = {
    codexCommand: typeof raw.codexCommand === "string" ? raw.codexCommand.trim() : "",
    claudeCommand: typeof raw.claudeCommand === "string" ? raw.claudeCommand.trim() : "",
  };
  writeDesktopExecutorConfig(gitRoot, config);
  sendJson(res, 200, { ok: true, config });
}

// ── Executor test / open ──

async function handlePostDesktopExecutorTest(gitRoot: string, executorId: string, res: ServerResponse): Promise<void> {
  const executor = resolveExecutorAdapter(gitRoot, executorId);
  if (!executor) {
    sendJson(res, 400, { ok: false, code: "UNKNOWN_EXECUTOR", message: `Unknown executor: ${executorId}` });
    return;
  }
  const cli = resolveCliCommand(executor.command, ["--version"]);
  const envDebug = collectNpmEnvDebug();
  try {
    const cliEnv = buildCliSetupEnv(gitRoot);
    const result = runCliSync(gitRoot, cli, cliEnv, 10000);
    const output = result.stdout || result.stderr;
    const versionLine = output.split(/\r?\n/)[0]?.trim() || output;
    let ok = false;
    let message: string;
    if (result.error) {
      message = `Cannot run ${executor.displayName}: ${result.error.message}`;
    } else if (result.signal) {
      message = `${executor.displayName} test was interrupted (${result.signal}).`;
    } else if (typeof result.status === "number" && result.status !== 0) {
      message = `CLI exited with status ${result.status}`;
    } else if (output.length > 0) {
      ok = true;
      message = `${executor.displayName} is available`;
    } else {
      message = `${executor.displayName} did not return a usable status.`;
    }
    sendJson(res, 200, {
      ok: true,
      test: { ok, message, version: ok ? (versionLine || null) : null },
      _debug: { command: cli.command, argsPrefix: cli.argsPrefix, env: envDebug },
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: true,
      test: { ok: false, message: `Cannot run ${executor.displayName}: ${err instanceof Error ? err.message : String(err)}`, version: null },
      _debug: { command: cli.command, argsPrefix: cli.argsPrefix, env: envDebug, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function handlePostDesktopExecutorOpen(gitRoot: string, executorId: string, res: ServerResponse): void {
  const executor = resolveExecutorAdapter(gitRoot, executorId);
  if (!executor) {
    sendJson(res, 400, { ok: false, code: "UNKNOWN_EXECUTOR", message: `Unknown executor: ${executorId}` });
    return;
  }
  try {
    const cli = resolveCliCommand(executor.command, []);
    const envDebug = collectNpmEnvDebug();
    const npmrcResult = checkNpmrcForRecursive(gitRoot);
    if (process.platform === "win32") {
      const commandLine = `cd /d ${quoteWindowsCmdArg(gitRoot)} && ${buildWindowsCmdLine(cli.command, cli.argsPrefix)}`;
      const terminal = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", "cmd.exe", "/k", commandLine], {
        cwd: gitRoot,
        env: buildCliSetupEnv(gitRoot),
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      terminal.unref();
      sendJson(res, 200, {
        ok: true,
        message: `${executor.displayName} launched in a terminal window.`,
      });
      return;
    }
    const child = spawn(cli.command, cli.argsPrefix, {
      cwd: gitRoot,
      env: buildCliSetupEnv(gitRoot),
      stdio: "ignore",
      windowsHide: false,
      detached: true,
    });
    child.unref();
    sendJson(res, 200, {
      ok: true,
      message: `${executor.displayName} launched. Complete setup in the terminal window that opened.`,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      code: "OPEN_FAILED",
      message: `Failed to launch ${executor.displayName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function buildWindowsCmdLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCmdArg).join(" ");
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

function buildCliSetupEnv(gitRoot: string): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  const keepPrefixes = [
    "PATH", "SystemRoot", "ComSpec", "USERPROFILE", "HOME",
    "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR", "OS",
    "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA",
    "ALLUSERSPROFILE", "PUBLIC", "SESSIONNAME",
    "TERM", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "DISPLAY", "XDG_", "WT_", "ITERM_", "TERM_", "TERMINAL",
    "CLICOLOR", "FORCE_COLOR", "NO_COLOR",
    "EDITOR", "VISUAL", "PAGER",
    "SCOPEGUARD_",
  ];
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    const lk = key.toLowerCase();
    if (lk.startsWith("npm_config_")) continue;
    if (lk.startsWith("npm_package_")) continue;
    if (lk.startsWith("npm_lifecycle_")) continue;
    if (lk === "npm_command") continue;
    if (lk === "npm_node_execpath") continue;
    if (lk === "npm_execpath") continue;
    if (lk.startsWith("pnpm_")) continue;
    if (lk === "init_cwd") continue;
    if (lk === "_") continue;
    for (const prefix of keepPrefixes) {
      if (key === prefix || key.startsWith(prefix)) {
        cleanEnv[key] = value;
        break;
      }
    }
  }
  cleanEnv.PROJECT_ROOT = gitRoot;
  return cleanEnv;
}

function collectNpmEnvDebug(): Record<string, string | null> {
  const keys = ["npm_config_recursive", "NPM_CONFIG_RECURSIVE", "npm_command", "npm_execpath", "npm_node_execpath", "INIT_CWD", "_"];
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    result[key] = process.env[key] ?? null;
  }
  const npmConfigKeys: string[] = [];
  const pnpmKeys: string[] = [];
  for (const key of Object.keys(process.env)) {
    const lk = key.toLowerCase();
    if (lk.startsWith("npm_config_")) npmConfigKeys.push(key);
    if (lk.startsWith("pnpm_")) pnpmKeys.push(key);
  }
  result["_npm_config_keys_found"] = npmConfigKeys.length > 0 ? npmConfigKeys.join(", ") : null;
  result["_pnpm_keys_found"] = pnpmKeys.length > 0 ? pnpmKeys.join(", ") : null;
  return result;
}

function checkNpmrcForRecursive(gitRoot: string): { checked: string[]; found: boolean; value: string | null } {
  const locations: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) locations.push(join(home, ".npmrc"));
  if (gitRoot) locations.push(join(gitRoot, ".npmrc"));
  for (const loc of locations) {
    if (!existsSync(loc)) continue;
    try {
      const content = readFileSync(loc, "utf-8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim().toLowerCase();
        const val = line.slice(eqIdx + 1).trim();
        if (key === "recursive") {
          return { checked: locations, found: true, value: val || "(empty)" };
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return { checked: locations, found: false, value: null };
}

// ── Sanitization / validation helpers ──

function sanitizeDesktopProjectMemoryRecord(value: unknown): {
  id: string; kind: string; title: string; content: string; source: string; createdAt: string; updatedAt: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind === "pattern" || candidate.kind === "note" || candidate.kind === "review" ? candidate.kind : null;
  const source = candidate.source === "user" || candidate.source === "assistant" || candidate.source === "system" ? candidate.source : null;
  if (typeof candidate.id !== "string" || !kind || typeof candidate.title !== "string" || typeof candidate.content !== "string" || !source || typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") {
    return null;
  }
  return {
    id: candidate.id,
    kind,
    title: candidate.title.trim(),
    content: candidate.content.trim(),
    source,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function sanitizeDesktopConversationThread(thread: DesktopConversationThread): DesktopConversationThread {
  if (!thread || !Array.isArray(thread.messages) || thread.kind !== "project") {
    return sanitizeTaskConversationThread(thread) ?? thread;
  }
  const filteredMessages = thread.messages.filter((message) => !isLegacyProjectScaffoldMessage(message));
  if (filteredMessages.length === thread.messages.length) return thread;
  return { ...thread, messages: filteredMessages };
}

function sanitizeTaskConversationThread(thread: DesktopConversationThread): DesktopConversationThread | null {
  if (!thread || !Array.isArray(thread.messages) || thread.kind !== "task") return thread;
  const filteredMessages = thread.messages.filter((message) => !isLegacyTaskScaffoldMessage(message));
  if (filteredMessages.length === thread.messages.length) return thread;
  return { ...thread, messages: filteredMessages };
}

function isLegacyProjectScaffoldMessage(message: DesktopMessage): boolean {
  if (!message || message.role !== "scopeguard" || typeof message.text !== "string") return false;
  const text = message.text.trim();
  if (!text) return false;
  return text.startsWith("You opened a project conversation for ")
    || text.startsWith("Project conversation summary:")
    || text.startsWith("Suggested next step: refine this goal until it is task-shaped");
}

function isLegacyTaskScaffoldMessage(message: DesktopMessage): boolean {
  if (!message || message.role !== "scopeguard" || typeof message.text !== "string") return false;
  const text = message.text.trim();
  if (!text) return false;
  return text.startsWith("You are now in the task workspace for ")
    || text.startsWith("This draft task was seeded from the project conversation.");
}

function isDesktopConversationThread(value: unknown): value is DesktopConversationThread {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.projectId === "string"
    && (candidate.kind === "project" || candidate.kind === "task")
    && (typeof candidate.taskId === "string" || candidate.taskId === null)
    && typeof candidate.title === "string"
    && (candidate.status === "active" || candidate.status === "archived")
    && typeof candidate.createdAt === "string"
    && typeof candidate.updatedAt === "string"
    && Array.isArray(candidate.messages);
}

function isDesktopProjectSession(value: unknown): value is DesktopProjectSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const drawerState = candidate.drawerState as Record<string, unknown> | undefined;
  return (typeof candidate.activeProjectId === "string" || candidate.activeProjectId === null)
    && (typeof candidate.activeTaskId === "string" || candidate.activeTaskId === null)
    && (typeof candidate.activeThreadId === "string" || candidate.activeThreadId === null)
    && (candidate.activeView === "home" || candidate.activeView === "task" || candidate.activeView === "settings")
    && !!drawerState
    && typeof drawerState.contextOpen === "boolean"
    && typeof drawerState.logsOpen === "boolean";
}

function readVerifyReportStatus(reportPath: string): "unknown" | "passed" | "failed" | "pending" {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as { status?: string };
    if (report.status === "passed") return "passed";
    if (report.status === "failed") return "failed";
    return "pending";
  } catch {
    return "unknown";
  }
}

function buildLastEvent(task: TaskRecord): string | null {
  switch (task.status) {
    case "approved": return "Task approved";
    case "needs_review": return "Review is ready";
    case "in_progress": return "Task execution is in progress";
    case "test_failed": return "Verification failed";
    case "conflict": return "Merge conflict requires attention";
    case "closed": return "Task closed";
    case "merged": return "Task merged";
    default: return "Task metadata updated";
  }
}

function countTaskArtifacts(gitRoot: string, taskId: string): number {
  const taskDir = dataPath(gitRoot, "tasks", taskId);
  if (!existsSync(taskDir)) return 0;
  try {
    return readdirSync(taskDir).length;
  } catch {
    return 0;
  }
}

// ── Git helpers ──

function findGitRoot(folderPath: string): string | null {
  let current = resolve(folderPath);
  while (true) {
    if (existsSync(join(current, ".git"))) return normalizeSlashes(current);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function getDefaultBranch(gitRoot: string): string {
  try {
    const symbolicRef = execSync("git -c safe.directory=* symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const branch = symbolicRef.split("/").at(-1);
    return branch && branch.length > 0 ? branch : "main";
  } catch {
    try {
      const headBranch = execSync("git -c safe.directory=* rev-parse --abbrev-ref HEAD", {
        cwd: gitRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return headBranch === "HEAD" ? "main" : headBranch;
    } catch {
      return "main";
    }
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function buildUninitializedProjectId(rootPath: string): string {
  return `uninitialized-${encodeURIComponent(rootPath)}`;
}

function buildLocalWorkspaceProjectId(rootPath: string): string {
  return `workspace-${encodeURIComponent(rootPath)}`;
}

// ── Static file serving ──

function handleStatic(path: string, res: ServerResponse): void {
  if (path === "/vendor/react.development.js") {
    sendFile(resolveVendorFile("react", "umd", "react.development.js"), res);
    return;
  }
  if (path === "/vendor/react-dom.development.js") {
    sendFile(resolveVendorFile("react-dom", "umd", "react-dom.development.js"), res);
    return;
  }
  const staticRoot = resolveStaticRoot();
  const normalizedPath = path === "/" ? "/index.html" : path;
  const filePath = join(staticRoot, normalizedPath.replace(/^\//, ""));
  if (!filePath.startsWith(staticRoot) || !existsSync(filePath)) {
    sendText(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  sendFile(filePath, res);
}

function sendFile(filePath: string, res: ServerResponse): void {
  if (!existsSync(filePath)) {
    sendText(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const contentType = getContentType(filePath);
  const content = readFileSync(filePath);
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  if (filePath.endsWith(".html")) {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';");
  }
  res.end(content);
}

function resolveVendorFile(packageName: string, ...parts: string[]): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = findWorkspaceRoot(process.cwd()) ?? findWorkspaceRoot(moduleDir);
  const candidates = [
    workspaceRoot ? join(workspaceRoot, "apps", "web", "node_modules", packageName, ...parts) : "",
    workspaceRoot ? join(workspaceRoot, "node_modules", packageName, ...parts) : "",
    join(process.cwd(), "node_modules", packageName, ...parts),
    join(process.cwd(), "apps", "web", "node_modules", packageName, ...parts),
    join(moduleDir, "../../web/node_modules", packageName, ...parts),
    join(moduleDir, "../../../web/node_modules", packageName, ...parts),
  ];
  return candidates.filter((candidate) => candidate.length > 0).find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "";
}

function resolveStaticRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = findWorkspaceRoot(process.cwd()) ?? findWorkspaceRoot(moduleDir);
  const candidates = [
    workspaceRoot ? join(workspaceRoot, "apps", "web", "static") : "",
    join(process.cwd(), "apps", "web", "static"),
    join(moduleDir, "../../web/static"),
    join(moduleDir, "../../../web/static"),
  ];
  return candidates.filter((candidate) => candidate.length > 0).find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0] ?? "";
}

function findWorkspaceRoot(startPath: string): string | null {
  let current = resolve(startPath);
  while (true) {
    if (existsSync(join(current, "apps", "web", "static", "index.html"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── Send helpers ──

function getContentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

function sendText(res: ServerResponse, statusCode: number, text: string, contentType: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.end(text);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
