import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolExecutionContext } from "@scopeguard/agent-runtime";

import {
  ReadFileTool,
  RunCommandTool,
  ScopeGuardToolRegistry,
  ToolExecutionCancelledError,
  WriteFileTool,
  permissionForTool,
  resolveExistingProjectPath,
  safeToolEnvironment,
  shutdownRunningCommands,
} from "./index.js";

test("reads files inside the project and rejects parent traversal", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.project, "README.md"), "scopeguard", "utf8");
    await writeFile(join(fixture.outside, "secret.txt"), "secret", "utf8");
    const tool = new ReadFileTool();
    const result = await tool.execute({ path: "README.md" }, context(fixture.project));

    assert.deepEqual(result, { output: "scopeguard", isError: false });
    await assert.rejects(
      () => resolveExistingProjectPath(fixture.project, "../outside/secret.txt"),
      /outside the project root/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects symlinks that escape the project root", async () => {
  const fixture = await createFixture();
  try {
    const outsideFile = join(fixture.outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, join(fixture.project, "linked-secret"));

    await assert.rejects(
      () => resolveExistingProjectPath(fixture.project, "linked-secret"),
      /outside the project root/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects an oversized sparse file before reading its contents", async () => {
  const fixture = await createFixture();
  try {
    const oversized = join(fixture.project, "oversized.log");
    await writeFile(oversized, "start", "utf8");
    await truncate(oversized, 1_000_001);

    const result = await new ReadFileTool().execute(
      { path: "oversized.log" },
      context(fixture.project),
    );

    assert.deepEqual(result, {
      output: "File is 1000001 bytes; the read limit is 1000000 bytes.",
      isError: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("cancels a bounded file read", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.project, "large.txt"),
      Buffer.alloc(1_000_000, 97),
    );
    const controller = new AbortController();
    const reading = new ReadFileTool().execute(
      { path: "large.txt" },
      context(fixture.project, controller.signal),
    );
    setImmediate(() => controller.abort());

    await assert.rejects(
      reading,
      (error) =>
        error instanceof ToolExecutionCancelledError &&
        error.reason === "cancelled",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("writes files atomically and preserves file mode where supported", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.project, "notes.md");
    await writeFile(target, "old", { encoding: "utf8", mode: 0o640 });
    await chmod(target, 0o750);
    const result = await new WriteFileTool().execute(
      { path: "notes.md", content: "new content" },
      context(fixture.project),
    );

    assert.deepEqual(result, {
      output: "Wrote 11 bytes to notes.md.",
      isError: false,
    });
    assert.equal(await readFile(target, "utf8"), "new content");
    if (process.platform !== "win32") {
      assert.equal((await stat(target)).mode & 0o777, 0o750);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("write_file rejects traversal, symlinks, and oversized content", async () => {
  const fixture = await createFixture();
  try {
    const outsideFile = join(fixture.outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, join(fixture.project, "linked-secret"));
    const tool = new WriteFileTool();

    await assert.rejects(
      () => tool.execute(
        { path: "../outside/secret.txt", content: "changed" },
        context(fixture.project),
      ),
      /outside the project root/,
    );
    assert.deepEqual(
      await tool.execute(
        { path: "linked-secret", content: "changed" },
        context(fixture.project),
      ),
      {
        output: "Symbolic links cannot be replaced with write_file.",
        isError: true,
      },
    );
    assert.equal(await readFile(outsideFile, "utf8"), "secret");
    assert.deepEqual(
      await tool.execute(
        { path: "large.txt", content: "x".repeat(1_000_001) },
        context(fixture.project),
      ),
      {
        output: "Content is 1000001 bytes; the write limit is 1000000 bytes.",
        isError: true,
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("hides denied tools and preserves ask decisions", () => {
  const registry = new ScopeGuardToolRegistry();
  const policy = {
    readFiles: "allow",
    writeFiles: "deny",
    runCommands: "ask",
  } as const;

  assert.deepEqual(
    registry.definitions(policy).map((definition) => definition.name),
    ["read_file", "run_command"],
  );
  const command = registry.get("run_command");
  assert.ok(command);
  assert.equal(permissionForTool(command, policy), "ask");
});

test("does not pass provider-like secrets into commands", () => {
  const environment = safeToolEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    OPENAI_API_KEY: "secret",
    CUSTOM_TOKEN: "secret",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
  });
});

test("runs an approved command in the project root", async () => {
  const fixture = await createFixture();
  try {
    const result = await new RunCommandTool().execute(
      {
        command: process.platform === "win32" ? "cd" : "pwd",
        timeoutMs: 5_000,
      },
      context(fixture.project),
    );
    assert.equal(result.isError, false);
    assert.equal(result.output.includes(fixture.project), true);
  } finally {
    await fixture.cleanup();
  }
});

test(
  "cancellation terminates a SIGTERM-resistant parent and child process",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    try {
      const processTree = await createResistantProcessTree(fixture.project);
      const controller = new AbortController();
      const execution = new RunCommandTool().execute(
        {
          command: commandForScript(processTree.script, processTree.pidFile),
          timeoutMs: 10_000,
        },
        context(fixture.project, controller.signal),
      );
      const pids = await waitForPids(processTree.pidFile);

      controller.abort();

      await assert.rejects(
        execution,
        (error) =>
          error instanceof ToolExecutionCancelledError &&
          error.reason === "cancelled",
      );
      await assertPidsExit(pids);
    } finally {
      await shutdownRunningCommands();
      await fixture.cleanup();
    }
  },
);

test(
  "timeout terminates a SIGTERM-resistant parent and child process",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    try {
      const processTree = await createResistantProcessTree(fixture.project);
      const execution = new RunCommandTool().execute(
        {
          command: commandForScript(processTree.script, processTree.pidFile),
          timeoutMs: 1_000,
        },
        context(fixture.project, new AbortController().signal),
      );
      const pids = await waitForPids(processTree.pidFile);

      await assert.rejects(
        execution,
        (error) =>
          error instanceof ToolExecutionCancelledError &&
          error.reason === "timeout",
      );
      await assertPidsExit(pids);
    } finally {
      await shutdownRunningCommands();
      await fixture.cleanup();
    }
  },
);

test(
  "shutdownRunningCommands terminates every registered command",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    try {
      const processTree = await createResistantProcessTree(fixture.project);
      const execution = new RunCommandTool().execute(
        {
          command: commandForScript(processTree.script, processTree.pidFile),
          timeoutMs: 10_000,
        },
        context(fixture.project, new AbortController().signal),
      );
      const pids = await waitForPids(processTree.pidFile);

      await shutdownRunningCommands();

      await assert.rejects(
        execution,
        (error) =>
          error instanceof ToolExecutionCancelledError &&
          error.reason === "shutdown",
      );
      await assertPidsExit(pids);
    } finally {
      await shutdownRunningCommands();
      await fixture.cleanup();
    }
  },
);

function context(
  projectRoot: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): ToolExecutionContext {
  return {
    projectId: "project",
    projectRoot,
    threadId: "thread",
    runId: "run",
    toolPolicy: {
      readFiles: "allow",
      writeFiles: "ask",
      runCommands: "ask",
    },
    signal,
  };
}

async function createResistantProcessTree(project: string): Promise<{
  script: string;
  pidFile: string;
}> {
  const script = join(project, "resistant-tree.cjs");
  const pidFile = join(project, "process-tree.json");
  await writeFile(
    script,
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const pidFile = process.argv[2];",
      'if (process.argv[3] === "child") {',
      '  process.on("SIGTERM", () => {});',
      "  setInterval(() => {}, 1000);",
      "} else {",
      '  process.on("SIGTERM", () => {});',
      '  const child = spawn(process.execPath, [__filename, pidFile, "child"], { stdio: "ignore" });',
      "  writeFileSync(pidFile, JSON.stringify([process.pid, child.pid]));",
      "  setInterval(() => {}, 1000);",
      "}",
    ].join("\n"),
    "utf8",
  );
  return { script, pidFile };
}

function commandForScript(script: string, pidFile: string): string {
  return [process.execPath, script, pidFile]
    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

async function waitForPids(pidFile: string): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(pidFile, "utf8")) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        parsed.every((pid) => Number.isInteger(pid) && pid > 0)
      ) {
        return parsed as number[];
      }
    } catch {
      // The process creates the file after both parent and child are running.
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for the command process tree.");
}

async function assertPidsExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return;
    }
    await delay(20);
  }
  assert.fail(`Processes still alive after command termination: ${pids.join(", ")}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createFixture(): Promise<{
  project: string;
  outside: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-tools-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
  return {
    project,
    outside,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
