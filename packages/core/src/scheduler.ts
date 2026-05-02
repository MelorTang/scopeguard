import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFileLockService, type FileLock } from "./locks.js";
import { dataPath } from "./data-dir.js";

type TaskRecord = {
  id: string;
  title: string;
  status: string;
  agentType: string;
  lockedFiles: string[];
  dependencies: string[];
};

type SafeTask = {
  id: string;
  title: string;
  agentType: string;
  lockedFiles: string[];
};

type BlockedTask = {
  id: string;
  title: string;
  reasons: string[];
};

type NotScheduledTask = {
  id: string;
  title: string;
  status: string;
};

export type NextTasksResult = {
  safeToRun: SafeTask[];
  blocked: BlockedTask[];
  notScheduled: NotScheduledTask[];
};

export type ScheduleResult = {
  batches: SafeTask[][];
  blocked: BlockedTask[];
};

export type RunGuardResult = {
  ok: boolean;
  reasons: string[];
};

export function getNextTasks(gitRoot: string): NextTasksResult {
  const tasks = readAllTasks(gitRoot);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const activeLocks = createFileLockService(gitRoot).listLocks().filter((lock) => lock.status === "active");

  const safeToRun: SafeTask[] = [];
  const blocked: BlockedTask[] = [];
  const notScheduled: NotScheduledTask[] = [];

  for (const task of tasks) {
    if (task.status === "backlog") {
      notScheduled.push({ id: task.id, title: task.title, status: task.status });
      continue;
    }
    if (task.status !== "ready" && task.status !== "blocked") {
      notScheduled.push({ id: task.id, title: task.title, status: task.status });
      continue;
    }

    if (task.status === "blocked") {
      const reasons = dependencyReasons(task, taskById);
      blocked.push({
        id: task.id,
        title: task.title,
        reasons: reasons.length > 0 ? reasons : ["status is blocked"],
      });
      continue;
    }

    const reasons: string[] = [];
    reasons.push(...dependencyReasons(task, taskById));
    reasons.push(...activeLockReasons(task, activeLocks));

    if (reasons.length > 0) {
      blocked.push({ id: task.id, title: task.title, reasons });
      continue;
    }

    safeToRun.push(toSafeTask(task));
  }

  return {
    safeToRun: safeToRun.sort(byTaskId),
    blocked: blocked.sort(byTaskId),
    notScheduled: notScheduled.sort(byTaskId),
  };
}

export function getSchedule(gitRoot: string): ScheduleResult {
  const tasks = readAllTasks(gitRoot);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const activeLocks = createFileLockService(gitRoot).listLocks().filter((lock) => lock.status === "active");

  const candidates: SafeTask[] = [];
  const blocked: BlockedTask[] = [];

  for (const task of tasks) {
    if (task.status !== "ready") {
      continue;
    }

    const reasons: string[] = [];
    reasons.push(...dependencyReasons(task, taskById));
    reasons.push(...activeLockReasons(task, activeLocks));
    if (reasons.length > 0) {
      blocked.push({ id: task.id, title: task.title, reasons });
      continue;
    }

    candidates.push(toSafeTask(task));
  }

  candidates.sort(byTaskId);

  const batches: SafeTask[][] = [];
  for (const task of candidates) {
    let placed = false;
    for (const batch of batches) {
      if (!conflictsWithBatch(task, batch)) {
        batch.push(task);
        placed = true;
        break;
      }
    }
    if (!placed) {
      batches.push([task]);
    }
  }

  return {
    batches,
    blocked: blocked.sort(byTaskId),
  };
}

export function canRunTask(gitRoot: string, taskId: string): RunGuardResult {
  const tasks = readAllTasks(gitRoot);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const task = taskById.get(taskId);
  if (!task) {
    return { ok: false, reasons: [`task ${taskId} does not exist`] };
  }

  const reasons: string[] = [];
  if (task.status !== "ready") {
    reasons.push(`status is ${task.status}.`);
  }

  for (const dep of task.dependencies ?? []) {
    const depTask = taskById.get(dep);
    if (!depTask) {
      reasons.push(`dependency ${dep} does not exist.`);
      continue;
    }
    if (depTask.status !== "merged") {
      reasons.push(`dependency ${dep} is ${depTask.status}, expected merged.`);
    }
  }

  const activeLocks = createFileLockService(gitRoot).listLocks().filter((lock) => lock.status === "active");
  for (const pattern of task.lockedFiles ?? []) {
    const conflict = activeLocks.find((lock) => lockedPatternsOverlap(pattern, lock.pattern));
    if (conflict) {
      reasons.push(
        `lockedFiles ${pattern} conflicts with active lock ${conflict.pattern} held by ${conflict.taskId}.`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
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
      const parsed = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
      tasks.push(parsed);
    } catch {
      continue;
    }
  }

  return tasks.sort(byTaskId);
}

function dependencyReasons(task: TaskRecord, taskById: Map<string, TaskRecord>): string[] {
  const reasons: string[] = [];
  for (const dep of task.dependencies ?? []) {
    const depTask = taskById.get(dep);
    if (!depTask) {
      reasons.push(`dependency ${dep} does not exist`);
      continue;
    }
    if (depTask.status !== "merged") {
      reasons.push(`waits for ${dep} (status: ${depTask.status})`);
    }
  }
  return reasons;
}

function activeLockReasons(task: TaskRecord, locks: FileLock[]): string[] {
  const reasons: string[] = [];
  for (const pattern of task.lockedFiles ?? []) {
    const lock = locks.find((item) => lockedPatternsOverlap(item.pattern, pattern));
    if (lock) {
      reasons.push(`blocked by active lock ${pattern} held by ${lock.taskId}`);
    }
  }
  return reasons;
}

function conflictsWithBatch(task: SafeTask, batch: SafeTask[]): boolean {
  for (const taskPattern of task.lockedFiles ?? []) {
    for (const batchTask of batch) {
      for (const batchPattern of batchTask.lockedFiles ?? []) {
        if (lockedPatternsOverlap(taskPattern, batchPattern)) {
          return true;
        }
      }
    }
  }
  return false;
}

function toSafeTask(task: TaskRecord): SafeTask {
  return {
    id: task.id,
    title: task.title,
    agentType: task.agentType,
    lockedFiles: task.lockedFiles ?? [],
  };
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

function lockedPatternsOverlap(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);

  if (left.length === 0 || right.length === 0) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftBase = basePath(left);
  const rightBase = basePath(right);
  if (!leftBase || !rightBase) {
    return false;
  }

  if (leftBase === rightBase) {
    return true;
  }

  return leftBase.startsWith(`${rightBase}/`) || rightBase.startsWith(`${leftBase}/`);
}

function basePath(pattern: string): string | null {
  const normalized = normalize(pattern);
  if (normalized.includes("*")) {
    if (normalized.endsWith("/**")) {
      return normalized.slice(0, -3).replace(/\/+$/, "");
    }
    return null;
  }
  return normalized;
}

function byTaskId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}
