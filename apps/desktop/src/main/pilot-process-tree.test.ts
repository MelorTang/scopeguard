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

type HeartbeatFixture = {
  grandchildPid: number;
  parent: ChildProcess;
  root: string;
  stopPath: string;
};

async function createHeartbeatFixture(
  parentMode: "exiting-parent" | "persistent-parent",
): Promise<HeartbeatFixture> {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-pilot-heartbeat-test-"));
  const heartbeatPath = join(root, "heartbeat.txt");
  const stopPath = join(root, "stop");
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
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, ${JSON.stringify(heartbeatPath)}, ${JSON.stringify(stopPath)}], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.stdout.write(JSON.stringify({ grandchildPid: child.pid }) + "\\n");
    ${parentBehavior}
  `;
  const parent = spawn(process.execPath, ["-e", parentSource], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const grandchildPid = await readGrandchildPid(parent.stdout);
  await waitForFile(heartbeatPath, 2_000);
  return { grandchildPid, parent, root, stopPath };
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
): Promise<number> {
  assert(stdout);
  let buffered = "";
  for await (const chunk of stdout) {
    buffered += Buffer.from(chunk).toString("utf8");
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const parsed = JSON.parse(buffered.slice(0, newline)) as {
        grandchildPid: number;
      };
      return parsed.grandchildPid;
    }
  }
  throw new Error("Parent fixture exited before reporting its grandchild PID.");
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
