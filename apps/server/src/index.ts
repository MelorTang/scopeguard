import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
};

type BoardServer = {
  close: () => Promise<void>;
};

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

async function handleRequest(gitRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    sendText(res, 200, "OK", "text/plain; charset=utf-8");
    return;
  }

  if (req.method === "GET" && path === "/api/project") {
    handleGetProject(gitRoot, res);
    return;
  }

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

function parseTaskPath(path: string): { taskId: string; subPath: string } | null {
  const raw = path.slice("/api/tasks/".length);
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) {
    return null;
  }
  return {
    taskId: decodeURIComponent(parts[0] ?? ""),
    subPath: decodeURIComponent(parts[1] ?? ""),
  };
}

function readAllTasks(gitRoot: string): TaskRecord[] {
  const tasksRoot = dataPath(gitRoot, "tasks");
  if (!existsSync(tasksRoot)) {
    return [];
  }

  const tasks: TaskRecord[] = [];

  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const taskPath = join(tasksRoot, entry.name, "task.json");
    if (!existsSync(taskPath)) {
      continue;
    }

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
  if (!existsSync(taskPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
  } catch {
    return null;
  }
}

function handleStatic(path: string, res: ServerResponse): void {
  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), "../../web/static");

  const normalizedPath = path === "/" ? "/index.html" : path;
  const filePath = join(staticRoot, normalizedPath.replace(/^\//, ""));

  if (!filePath.startsWith(staticRoot) || !existsSync(filePath)) {
    sendText(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }

  const contentType = getContentType(filePath);
  const content = readFileSync(filePath);
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.end(content);
}

function getContentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }

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

