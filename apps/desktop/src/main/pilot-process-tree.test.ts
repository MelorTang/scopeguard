import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  terminateProcessTree,
  waitForProcessTree,
  windowsTaskkillArguments,
} from "./pilot-process-tree.js";

test("uses taskkill to force the complete Windows process tree", () => {
  assert.deepEqual(windowsTaskkillArguments(4312), [
    "/PID",
    "4312",
    "/T",
    "/F",
  ]);
});

test("Windows termination preserves taskkill failure when the root exits during the call", async () => {
  const child = {
    pid: 4312,
    exitCode: null,
    signalCode: null,
  } as unknown as ChildProcess;
  let alive = true;

  await assert.rejects(
    terminateProcessTree(child, {
      platform: "win32",
      knownDescendantPids: async () => {
        throw new Error("Pilot state unavailable");
      },
      windowsProcessController: {
        isProcessAlive: () => alive,
        taskkill: async () => {
          alive = false;
          throw new Error("Access is denied");
        },
      },
    }),
    /taskkill failed for process tree 4312: Access is denied/,
  );
});

test("Windows root taskkill cannot hide a surviving known Agent Host", async () => {
  const childState = {
    pid: 4312,
    exitCode: null as number | null,
    signalCode: null,
  };
  const child = childState as unknown as ChildProcess;
  const agentHostPid = 9876;
  const alive = new Set([childState.pid, agentHostPid]);
  const taskkillCalls: number[] = [];

  await assert.rejects(
    terminateProcessTree(child, {
      platform: "win32",
      forceTimeoutMs: 0,
      knownDescendantPids: async () => [agentHostPid],
      windowsProcessController: {
        isProcessAlive: (pid) => alive.has(pid),
        taskkill: async (pid) => {
          taskkillCalls.push(pid);
          assert.equal(pid, childState.pid, "Known descendant must not be killed by bare PID.");
          alive.delete(pid);
          childState.exitCode = 0;
        },
      },
    }),
    /known descendant 9876 is still running/,
  );
  assert.deepEqual(taskkillCalls, [childState.pid]);
  assert.equal(alive.has(agentHostPid), true);
});

test("timeout waits for a Node parent and grandchild to exit before cleanup", async () => {
  const fixture = await createHeartbeatFixture("persistent-parent");
  const { grandchildPid, parent, root } = fixture;

  try {
    await assert.rejects(
      waitForProcessTree(parent, 25, "Node process-tree fixture", {
        gracefulTimeoutMs: 50,
        forceTimeoutMs: 2_000,
        knownDescendantPids: async () => [grandchildPid],
      }),
      /timed out after 25ms/,
    );
    assert.equal(isProcessAlive(parent.pid), false);
    assert.equal(isProcessAlive(grandchildPid), false);

    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(root), false);
  } finally {
    await stopHeartbeatGrandchild(fixture);
    await terminateProcessTree(parent, {
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 500,
      knownDescendantPids: async () => [],
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("normal root exit detects a surviving grandchild before cleanup", async () => {
  const fixture = await createHeartbeatFixture("exiting-parent");
  const { grandchildPid, parent, root } = fixture;

  try {
    await assert.rejects(
      waitForProcessTree(parent, 2_000, "normal-exit fixture", {
        gracefulTimeoutMs: 50,
        forceTimeoutMs: 2_000,
        knownDescendantPids: async () => [grandchildPid],
      }),
      process.platform === "win32"
        ? /known descendant .* is still running/
        : /left running descendants after the root exited/,
    );
    assert.equal(isProcessAlive(grandchildPid), process.platform === "win32");

    await stopHeartbeatGrandchild(fixture);
    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(root), false);
  } finally {
    await stopHeartbeatGrandchild(fixture);
    await terminateProcessTree(parent, {
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 500,
      knownDescendantPids: async () => [],
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("spawn error clears a long timeout and releases the Node fixture immediately", async () => {
  const helperUrl = new URL("./pilot-process-tree.js", import.meta.url).href;
  const fixtureSource = `
    import { spawn } from "node:child_process";
    const { waitForProcessTree } = await import(process.argv[1]);
    const missing = spawn("scopeguard-command-that-does-not-exist", [], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await waitForProcessTree(missing, 5_000, "missing command fixture");
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(JSON.stringify({ caught: true, code: error.code ?? null }) + "\\n");
    }
  `;
  const startedAt = Date.now();
  const fixture = spawn(
    process.execPath,
    ["--input-type=module", "-e", fixtureSource, helperUrl],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const result = await collectProcess(fixture);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    caught: true,
    code: "ENOENT",
  });
  assert.ok(
    elapsedMs < 1_500,
    `Missing-command fixture retained an active timeout for ${elapsedMs}ms.`,
  );
});

test("heartbeat initialization failure cleans owned processes and temporary state", async () => {
  const startedAt = Date.now();
  let failure: HeartbeatFixtureInitializationError | undefined;

  await assert.rejects(
    createHeartbeatFixture("persistent-parent", {
      pidTimeoutMs: 50,
      suppressPidOutput: true,
    }),
    (error) => {
      assert(error instanceof HeartbeatFixtureInitializationError);
      failure = error;
      return /Timed out waiting for the heartbeat grandchild PID/.test(
        error.message,
      );
    },
  );

  assert(failure);
  assert.ok(
    failure.grandchildPid,
    "Fixture must retain its owned grandchild identity.",
  );
  assert.ok(
    Date.now() - startedAt < 1_500,
    "Heartbeat initialization failure retained an active timeout or handle.",
  );
  assert.equal(isProcessAlive(failure.parentPid), false);
  assert.equal(isProcessAlive(failure.grandchildPid), false);
  assert.equal(existsSync(failure.root), false);
});

test("stop-file write failure still terminates the heartbeat process tree", async () => {
  const startedAt = Date.now();
  let failure: HeartbeatFixtureInitializationError | undefined;

  await assert.rejects(
    createHeartbeatFixture("persistent-parent", {
      pidTimeoutMs: 50,
      stopPathInMissingDirectory: true,
      suppressPidOutput: true,
    }),
    (error) => {
      assert(error instanceof HeartbeatFixtureInitializationError);
      failure = error;
      return /Stop-file write failed/.test(error.message);
    },
  );

  assert(failure);
  assert.ok(
    failure.grandchildPid,
    "Fixture must retain its owned grandchild identity.",
  );
  assert.equal(errorCode(failure.stopFileError), "ENOENT");
  assert.ok(
    Date.now() - startedAt < 1_500,
    "Stop-file failure retained an active timeout or process handle.",
  );
  assert.equal(isProcessAlive(failure.parentPid), false);
  assert.equal(isProcessAlive(failure.grandchildPid), false);
  assert.equal(existsSync(failure.root), false);
});

type HeartbeatFixture = {
  grandchildPid: number;
  parent: ChildProcess;
  root: string;
  stopPath: string;
};

type HeartbeatFixtureOptions = {
  pidTimeoutMs?: number;
  readinessTimeoutMs?: number;
  stopPathInMissingDirectory?: boolean;
  suppressPidOutput?: boolean;
};

class HeartbeatFixtureInitializationError extends Error {
  constructor(
    readonly root: string,
    readonly parentPid: number | undefined,
    readonly grandchildPid: number | undefined,
    readonly initializationError: unknown,
    readonly stopFileError?: unknown,
    readonly terminationError?: unknown,
    readonly directoryCleanupError?: unknown,
  ) {
    const messages = [
      `Initialization failed: ${errorMessage(initializationError)}`,
    ];
    if (stopFileError) {
      messages.push(`Stop-file write failed: ${errorMessage(stopFileError)}`);
    }
    if (terminationError) {
      messages.push(
        `Process-tree termination failed: ${errorMessage(terminationError)}`,
      );
    }
    if (directoryCleanupError) {
      messages.push(
        `Temporary directory cleanup failed: ${
          errorMessage(directoryCleanupError)
        }`,
      );
    }
    super(messages.join(" "), { cause: initializationError });
    this.name = "HeartbeatFixtureInitializationError";
  }
}

async function createHeartbeatFixture(
  parentMode: "exiting-parent" | "persistent-parent",
  options: HeartbeatFixtureOptions = {},
): Promise<HeartbeatFixture> {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-pilot-heartbeat-test-"));
  const heartbeatPath = join(root, "heartbeat.txt");
  const pidPath = join(root, "grandchild.pid");
  const stopPath = options.stopPathInMissingDirectory
    ? join(root, "missing-stop-parent", "stop")
    : join(root, "stop");
  const grandchildSource = `
    const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
    const { dirname } = require("node:path");
    const heartbeatPath = process.argv[1];
    const stopPath = process.argv[2];
    process.on("SIGTERM", () => {});
    setInterval(() => {
      if (existsSync(stopPath)) process.exit(0);
      mkdirSync(dirname(heartbeatPath), { recursive: true });
      writeFileSync(heartbeatPath, String(process.pid));
    }, 10);
  `;
  const parentBehavior = parentMode === "persistent-parent"
    ? `process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`
    : "child.unref();";
  const parentSource = `
    const { writeFileSync } = require("node:fs");
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, ${JSON.stringify(heartbeatPath)}, ${JSON.stringify(stopPath)}], {
      stdio: "ignore",
      windowsHide: true,
    });
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    ${options.suppressPidOutput ? "" : 'process.stdout.write(JSON.stringify({ grandchildPid: child.pid }) + "\\n");'}
    ${parentBehavior}
  `;
  const parent = spawn(process.execPath, ["-e", parentSource], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let grandchildPid: number | undefined;
  try {
    grandchildPid = await readGrandchildPid(
      parent.stdout,
      options.pidTimeoutMs ?? 2_000,
    );
    await waitForFile(heartbeatPath, options.readinessTimeoutMs ?? 2_000);
    return { grandchildPid, parent, root, stopPath };
  } catch (error) {
    grandchildPid ??= await readFixturePid(pidPath, 250);
    let stopFileError: unknown;
    if (grandchildPid && isProcessAlive(grandchildPid)) {
      try {
        await writeFile(stopPath, "stop\n");
      } catch (writeError) {
        stopFileError = writeError;
      }
    }

    let terminationError: unknown;
    try {
      await terminateProcessTree(parent, {
        gracefulTimeoutMs: 25,
        forceTimeoutMs: 500,
        knownDescendantPids: async () => grandchildPid ? [grandchildPid] : [],
      });
      if (isProcessAlive(parent.pid) || isProcessAlive(grandchildPid)) {
        throw new Error(
          "Heartbeat fixture process tree remained alive after cleanup.",
        );
      }
    } catch (processTreeError) {
      terminationError = processTreeError;
    }
    if (terminationError) {
      throw new HeartbeatFixtureInitializationError(
        root,
        parent.pid,
        grandchildPid,
        error,
        stopFileError,
        terminationError,
      );
    }

    let directoryCleanupError: unknown;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      directoryCleanupError = cleanupError;
    }
    throw new HeartbeatFixtureInitializationError(
      root,
      parent.pid,
      grandchildPid,
      error,
      stopFileError,
      undefined,
      directoryCleanupError,
    );
  }
}

async function stopHeartbeatGrandchild(
  fixture: HeartbeatFixture,
): Promise<void> {
  if (!isProcessAlive(fixture.grandchildPid)) return;
  await writeFile(fixture.stopPath, "stop\n");
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(fixture.grandchildPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Heartbeat grandchild ${fixture.grandchildPid} did not stop through its owned fixture channel.`,
  );
}

async function readGrandchildPid(
  stdout: NodeJS.ReadableStream | null,
  timeoutMs: number,
): Promise<number> {
  assert(stdout);
  return await new Promise<number>((resolve, reject) => {
    let buffered = "";
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      stdout.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string | Buffer) => {
      buffered += Buffer.from(chunk).toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffered.slice(0, newline)) as {
          grandchildPid?: unknown;
        };
        if (
          !Number.isSafeInteger(parsed.grandchildPid) ||
          Number(parsed.grandchildPid) <= 0
        ) {
          throw new Error("Parent fixture reported an invalid grandchild PID.");
        }
        cleanup();
        resolve(Number(parsed.grandchildPid));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => {
      fail(new Error("Parent fixture exited before reporting its grandchild PID."));
    };
    const onError = (error: Error) => fail(error);

    stdout.on("data", onData);
    stdout.once("end", onEnd);
    stdout.once("error", onError);
    timer = setTimeout(() => {
      fail(
        new Error(
          `Timed out waiting for the heartbeat grandchild PID after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
  });
}

async function readFixturePid(
  path: string,
  timeoutMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The parent may still be publishing the fixture-owned process identity.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Fixture did not write ${path}.`);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

async function collectProcess(child: ChildProcess): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  assert(child.stdout);
  assert(child.stderr);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    code,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}
