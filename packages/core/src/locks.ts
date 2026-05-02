import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataPath } from "./data-dir.js";

export type FileLock = {
  id: string;
  taskId: string;
  pattern: string;
  status: "active" | "released";
  createdAt: string;
  releasedAt?: string;
};

type LockStore = {
  locks: FileLock[];
};

export function createFileLockService(gitRoot: string) {
  const locksPath = dataPath(gitRoot, "locks.json");

  return {
    listLocks: (): FileLock[] => listLocks(locksPath),
    acquireLocks: (taskId: string, patterns: string[]): { acquired: FileLock[]; conflicts: FileLock[] } =>
      acquireLocks(locksPath, taskId, patterns),
    releaseLocks: (taskId: string): number => releaseLocks(locksPath, taskId),
    detectLockConflicts: (taskId: string, patterns: string[]): FileLock[] =>
      detectLockConflicts(locksPath, taskId, patterns),
  };
}

export function listLocks(locksPath: string): FileLock[] {
  return ensureStore(locksPath).locks;
}

export function acquireLocks(
  locksPath: string,
  taskId: string,
  patterns: string[],
): { acquired: FileLock[]; conflicts: FileLock[] } {
  const store = ensureStore(locksPath);
  const conflicts = findConflicts(store.locks, taskId, patterns);
  if (conflicts.length > 0) {
    return { acquired: [], conflicts };
  }

  const now = new Date().toISOString();
  const acquired: FileLock[] = [];

  for (const pattern of uniquePatterns(patterns)) {
    const existing = store.locks.find(
      (lock) => lock.taskId === taskId && lock.status === "active" && normalizePattern(lock.pattern) === normalizePattern(pattern),
    );

    if (existing) {
      continue;
    }

    const lock: FileLock = {
      id: randomUUID(),
      taskId,
      pattern,
      status: "active",
      createdAt: now,
    };
    store.locks.push(lock);
    acquired.push(lock);
  }

  writeStore(locksPath, store);
  return { acquired, conflicts: [] };
}

export function releaseLocks(locksPath: string, taskId: string): number {
  const store = ensureStore(locksPath);
  const now = new Date().toISOString();
  let released = 0;

  for (const lock of store.locks) {
    if (lock.taskId !== taskId || lock.status !== "active") {
      continue;
    }

    lock.status = "released";
    lock.releasedAt = now;
    released += 1;
  }

  writeStore(locksPath, store);
  return released;
}

export function detectLockConflicts(locksPath: string, taskId: string, patterns: string[]): FileLock[] {
  const store = ensureStore(locksPath);
  return findConflicts(store.locks, taskId, patterns);
}

function ensureStore(locksPath: string): LockStore {
  if (!existsSync(locksPath)) {
    mkdirSync(dirname(locksPath), { recursive: true });
    const empty: LockStore = { locks: [] };
    writeStore(locksPath, empty);
    return empty;
  }

  const raw = readFileSync(locksPath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Partial<LockStore>;
    if (Array.isArray(parsed.locks)) {
      return { locks: parsed.locks as FileLock[] };
    }
  } catch {
    // fallback below
  }

  const repaired: LockStore = { locks: [] };
  writeStore(locksPath, repaired);
  return repaired;
}

function writeStore(locksPath: string, store: LockStore): void {
  writeFileSync(locksPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

function findConflicts(allLocks: FileLock[], taskId: string, patterns: string[]): FileLock[] {
  const activeOtherLocks = allLocks.filter((lock) => lock.status === "active" && lock.taskId !== taskId);
  const conflicts: FileLock[] = [];

  for (const lock of activeOtherLocks) {
    for (const pattern of patterns) {
      if (patternsConflict(lock.pattern, pattern)) {
        conflicts.push(lock);
        break;
      }
    }
  }

  return conflicts;
}

function uniquePatterns(patterns: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const pattern of patterns) {
    const normalized = normalizePattern(pattern);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(pattern);
  }

  return result;
}

function patternsConflict(a: string, b: string): boolean {
  const left = normalizePattern(a);
  const right = normalizePattern(b);

  if (left === right) {
    return true;
  }

  const leftBase = stripWildcardSuffix(left);
  const rightBase = stripWildcardSuffix(right);

  return leftBase.startsWith(`${rightBase}/`) || rightBase.startsWith(`${leftBase}/`) || leftBase === rightBase;
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function stripWildcardSuffix(pattern: string): string {
  if (pattern.endsWith("/**")) {
    return pattern.slice(0, -3);
  }

  return pattern;
}
