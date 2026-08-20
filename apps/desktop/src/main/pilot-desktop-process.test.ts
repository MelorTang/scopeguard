import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PilotDesktopProcessFailure,
  supervisePilotDesktopProcess,
} from "./pilot-desktop-process.js";

test("code zero without completion or success state remains the primary failure", async () => {
  const fixture = await createPilotProcessFixture({
    exitCode: 0,
    stderr: "child diagnostic\n",
    stdout: "child started\n",
    writeLifecycle: true,
  });
  try {
    const failure = await expectPilotFailure(fixture);
    assert.match(failure.primaryError.message, /code=0 signal=null/);
    assert.match(failure.primaryError.message, /completion marker was absent/);
    assert.match(failure.primaryError.message, /success state was absent/);
    assert.equal(failure.cleanupError, null);
    assert.equal(failure.cleanupConfirmed, true);
  } finally {
    await fixture.dispose();
  }
});

test("nonzero exit preserves bounded stdout and stderr as the primary failure", async () => {
  const fixture = await createPilotProcessFixture({
    exitCode: 1,
    stderr: "stderr detail\n",
    stdout: "stdout detail\n",
    writeLifecycle: true,
  });
  try {
    const failure = await expectPilotFailure(fixture);
    assert.match(failure.primaryError.message, /code=1 signal=null/);
    assert.match(failure.primaryError.message, /stdout detail/);
    assert.match(failure.primaryError.message, /stderr detail/);
    assert.equal(failure.cleanupError, null);
  } finally {
    await fixture.dispose();
  }
});

test("early lifecycle metadata confirms cleanup independently of success state", async () => {
  const fixture = await createPilotProcessFixture({
    exitCode: 1,
    spawnShortLivedAgentHost: true,
    writeLifecycle: true,
  });
  try {
    const failure = await expectPilotFailure(fixture);
    assert.equal(failure.cleanupConfirmed, true);
    assert.equal(failure.cleanupError, null);
    assert.ok(fixture.agentHostPid);
    assert.equal(isProcessAlive(fixture.agentHostPid), false);
  } finally {
    await fixture.dispose();
  }
});

test("missing lifecycle preserves primary and cleanup errors with diagnostics", async () => {
  const fixture = await createPilotProcessFixture({
    exitCode: 1,
    stderr: "primary stderr\n",
    writeLifecycle: false,
  });
  const startedAt = Date.now();
  try {
    const failure = await expectPilotFailure(fixture);
    assert.match(failure.primaryError.message, /primary stderr/);
    assert.match(failure.cleanupError?.message ?? "", /lifecycle metadata/i);
    assert.equal(failure.cleanupConfirmed, false);
    assert.equal(existsSync(fixture.root), true);
    assert.ok(Date.now() - startedAt < 1_500);
  } finally {
    await fixture.dispose();
  }
});

test("diagnostics are byte bounded and redact secrets across chunks", async () => {
  const secret = "pilot-cross-chunk-secret";
  const fixture = await createPilotProcessFixture({
    exitCode: 1,
    stderrChunks: ["x".repeat(1_024), "pilot-cross-", "chunk-secret"],
    stdout: `authorization: Bearer ${secret}\n`,
    writeLifecycle: true,
  });
  try {
    const failure = await expectPilotFailure(fixture, {
      maxDiagnosticBytes: 256,
      redactions: [secret],
    });
    assert.equal(failure.primaryError.message.includes(secret), false);
    assert.equal(failure.primaryError.message.includes("pilot-cross-chunk-secret"), false);
    assert.match(failure.primaryError.message, /\[REDACTED\]/);
    assert.ok(Buffer.byteLength(failure.stdout, "utf8") <= 256);
    assert.ok(Buffer.byteLength(failure.stderr, "utf8") <= 256);
  } finally {
    await fixture.dispose();
  }
});

type PilotProcessFixture = {
  agentHostPid?: number;
  child: ChildProcess;
  lifecyclePath: string;
  root: string;
  statePath: string;
  dispose(): Promise<void>;
};

async function createPilotProcessFixture(options: {
  exitCode: number;
  spawnShortLivedAgentHost?: boolean;
  stderr?: string;
  stderrChunks?: string[];
  stdout?: string;
  writeLifecycle: boolean;
}): Promise<PilotProcessFixture> {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-pilot-process-test-"));
  const lifecyclePath = join(root, "pilot-lifecycle.json");
  const statePath = join(root, "pilot-state.json");
  const source = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const agentHost = ${options.spawnShortLivedAgentHost ? 'spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 40)"], { stdio: "ignore" })' : "null"};
    ${options.writeLifecycle ? `writeFileSync(${JSON.stringify(lifecyclePath)}, JSON.stringify({ schemaVersion: 1, phase: 1, mainPid: process.pid, agentHostPid: agentHost?.pid ?? process.pid + 1000000 }));` : ""}
    ${options.stdout ? `process.stdout.write(${JSON.stringify(options.stdout)});` : ""}
    ${options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : ""}
    ${JSON.stringify(options.stderrChunks ?? [])}.forEach((chunk) => process.stderr.write(chunk));
    setTimeout(() => process.exit(${options.exitCode}), 20);
  `;
  const child = spawn(process.execPath, ["-e", source], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let agentHostPid: number | undefined;
  if (options.spawnShortLivedAgentHost) {
    const deadline = Date.now() + 500;
    while (Date.now() <= deadline && !existsSync(lifecyclePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (existsSync(lifecyclePath)) {
      const value = JSON.parse(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(lifecyclePath, "utf8")
        ),
      ) as { agentHostPid: number };
      agentHostPid = value.agentHostPid;
    }
  }
  return {
    agentHostPid,
    child,
    lifecyclePath,
    root,
    statePath,
    async dispose() {
      if (isProcessAlive(child.pid)) child.kill("SIGKILL");
      if (agentHostPid && isProcessAlive(agentHostPid)) {
        process.kill(agentHostPid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function expectPilotFailure(
  fixture: PilotProcessFixture,
  options: { maxDiagnosticBytes?: number; redactions?: string[] } = {},
): Promise<PilotDesktopProcessFailure> {
  try {
    await supervisePilotDesktopProcess({
      child: fixture.child,
      completion: "ScopeGuard Desktop Pilot phase 1 complete",
      description: "Desktop Pilot fixture",
      lifecyclePath: fixture.lifecyclePath,
      maxDiagnosticBytes: options.maxDiagnosticBytes,
      phase: 1,
      redactions: options.redactions,
      statePath: fixture.statePath,
      timeoutMs: 1_000,
    });
  } catch (error) {
    assert(error instanceof PilotDesktopProcessFailure);
    return error;
  }
  throw new Error("Pilot fixture unexpectedly succeeded.");
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
