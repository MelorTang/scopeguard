import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("timeout waits for a Node parent and grandchild to exit before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-pilot-tree-test-"));
  const heartbeatPath = join(root, "heartbeat.txt");
  const grandchildSource = `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { dirname } = require("node:path");
    const path = process.argv[1];
    process.on("SIGTERM", () => {});
    setInterval(() => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(process.pid));
    }, 10);
  `;
  const parentSource = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, ${JSON.stringify(heartbeatPath)}], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.on("SIGTERM", () => {});
    process.stdout.write(JSON.stringify({ grandchildPid: child.pid }) + "\\n");
    setInterval(() => {}, 1_000);
  `;
  const parent = spawn(process.execPath, ["-e", parentSource], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    const grandchildPid = await readGrandchildPid(parent.stdout);
    await waitForFile(heartbeatPath, 2_000);
    await assert.rejects(
      waitForProcessTree(parent, 25, "Node process-tree fixture", {
        gracefulTimeoutMs: 50,
        forceTimeoutMs: 2_000,
      }),
      /timed out after 25ms/,
    );
    assert.equal(isProcessAlive(parent.pid), false);
    assert.equal(isProcessAlive(grandchildPid), false);

    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(root), false);
  } finally {
    await terminateProcessTree(parent, {
      gracefulTimeoutMs: 25,
      forceTimeoutMs: 500,
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

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
