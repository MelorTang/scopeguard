import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "@scopeguard/agent-runtime";
import type {
  AgentToolPolicy,
  ToolPermission,
} from "@scopeguard/domain";

const MAX_FILE_BYTES = 1_000_000;
const MAX_COMMAND_OUTPUT_BYTES = 100_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 500;
const TERMINATION_KILL_WAIT_MS = 2_000;
const TERMINATION_POLL_MS = 20;

export type ToolCancellationReason = "cancelled" | "timeout" | "shutdown";

export class ToolExecutionCancelledError extends Error {
  readonly code = "TOOL_EXECUTION_CANCELLED";

  constructor(
    readonly reason: ToolCancellationReason,
    readonly output = "",
  ) {
    super(cancellationMessage(reason));
    this.name = "ToolExecutionCancelledError";
  }
}

export function isToolExecutionCancelledError(
  error: unknown,
): error is ToolExecutionCancelledError {
  return (
    error instanceof ToolExecutionCancelledError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "TOOL_EXECUTION_CANCELLED")
  );
}

const runningCommands = new Set<ManagedCommand>();

export async function shutdownRunningCommands(): Promise<void> {
  await Promise.all(
    [...runningCommands].map((command) => command.terminate("shutdown")),
  );
}

export class ScopeGuardToolRegistry implements ToolRegistry {
  readonly #tools: Map<string, AgentTool>;

  constructor(
    tools: AgentTool[] = [
      new ReadFileTool(),
      new WriteFileTool(),
      new RunCommandTool(),
    ],
  ) {
    this.#tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  definitions(policy: AgentToolPolicy) {
    return [...this.#tools.values()]
      .filter((tool) => policy[tool.permission] !== "deny")
      .map((tool) => tool.definition);
  }

  get(name: string): AgentTool | null {
    return this.#tools.get(name) ?? null;
  }
}

export function permissionForTool(
  tool: AgentTool,
  policy: AgentToolPolicy,
): ToolPermission {
  return policy[tool.permission];
}

export class ReadFileTool implements AgentTool {
  readonly permission = "readFiles" as const;
  readonly definition = {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the current project. Paths are relative to the project root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Project-relative file path.",
        },
      },
      required: ["path"],
    },
  };

  describe(input: Record<string, unknown>): string {
    return `Read ${requireString(input, "path")}`;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const filePath = await resolveExistingProjectPath(
      context.projectRoot,
      requireString(input, "path"),
    );
    throwIfCancelled(context.signal);

    const file = await open(filePath, "r");
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) {
        return {
          output: "Only regular files can be read with read_file.",
          isError: true,
        };
      }
      if (metadata.size > MAX_FILE_BYTES) {
        return {
          output: `File is ${metadata.size} bytes; the read limit is ${MAX_FILE_BYTES} bytes.`,
          isError: true,
        };
      }

      const chunks: Buffer[] = [];
      try {
        const stream = file.createReadStream({
          autoClose: false,
          end: MAX_FILE_BYTES - 1,
          highWaterMark: 64 * 1024,
          signal: context.signal,
        });
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      } catch (error) {
        if (context.signal.aborted || isAbortError(error)) {
          throw new ToolExecutionCancelledError("cancelled");
        }
        throw error;
      }

      const contents = Buffer.concat(chunks);
      if (contents.byteLength > MAX_FILE_BYTES) {
        return {
          output: `File exceeded the read limit of ${MAX_FILE_BYTES} bytes while being read.`,
          isError: true,
        };
      }
      if (contents.subarray(0, 8192).includes(0)) {
        return {
          output: "Binary files cannot be read with read_file.",
          isError: true,
        };
      }
      return {
        output: contents.toString("utf8"),
        isError: false,
      };
    } finally {
      await file.close();
    }
  }
}

export class WriteFileTool implements AgentTool {
  readonly permission = "writeFiles" as const;
  readonly definition = {
    name: "write_file",
    description:
      "Write a complete UTF-8 text file inside the current project. Paths are relative to the project root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Project-relative file path.",
        },
        content: {
          type: "string",
          description: "Complete UTF-8 file contents.",
        },
      },
      required: ["path", "content"],
    },
  };

  describe(input: Record<string, unknown>): string {
    const path = requireString(input, "path");
    const content = requireString(input, "content");
    return `Write ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const requestedPath = requireString(input, "path");
    const content = requireString(input, "content");
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_FILE_BYTES) {
      return {
        output: `Content is ${size} bytes; the write limit is ${MAX_FILE_BYTES} bytes.`,
        isError: true,
      };
    }
    throwIfCancelled(context.signal);

    const root = await realpath(context.projectRoot);
    const unresolved = resolve(root, requestedPath);
    assertPathInsideRoot(root, unresolved);
    const parent = await realpath(dirname(unresolved));
    assertPathInsideRoot(root, parent);
    const target = join(parent, basename(unresolved));
    let mode = 0o600;

    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) {
        return {
          output: "Symbolic links cannot be replaced with write_file.",
          isError: true,
        };
      }
      if (!existing.isFile()) {
        return {
          output: "Only regular files can be replaced with write_file.",
          isError: true,
        };
      }
      mode = existing.mode & 0o777;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const temporaryPath = join(
      parent,
      `.${basename(target)}.${process.pid}.${randomUUID()}.scopeguard.tmp`,
    );
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode,
        signal: context.signal,
      });
      throwIfCancelled(context.signal);
      await rename(temporaryPath, target);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      if (context.signal.aborted || isAbortError(error)) {
        throw new ToolExecutionCancelledError("cancelled");
      }
      throw error;
    }

    return {
      output: `Wrote ${size} bytes to ${requestedPath}.`,
      isError: false,
    };
  }
}

export class RunCommandTool implements AgentTool {
  readonly permission = "runCommands" as const;
  readonly definition = {
    name: "run_command",
    description:
      "Run a shell command in the current project after the user approves the exact command.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "The complete shell command to run.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: MAX_COMMAND_TIMEOUT_MS,
          description: "Optional command timeout in milliseconds.",
        },
      },
      required: ["command"],
    },
  };

  describe(input: Record<string, unknown>): string {
    return `Run command: ${requireString(input, "command")}`;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const command = requireString(input, "command").trim();
    if (!command) {
      throw new Error("Command cannot be empty.");
    }
    const projectRoot = await realpath(context.projectRoot);
    const timeoutMs = clampTimeout(input.timeoutMs);
    return runShellCommand(command, projectRoot, timeoutMs, context.signal);
  }
}

export async function resolveExistingProjectPath(
  projectRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("Path cannot be empty.");
  }

  const root = await realpath(projectRoot);
  const candidate = resolve(root, requestedPath);
  assertPathInsideRoot(root, candidate);
  await access(candidate, fsConstants.R_OK);
  const canonical = await realpath(candidate);
  assertPathInsideRoot(root, canonical);
  return canonical;
}

export function safeToolEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function assertPathInsideRoot(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Requested path is outside the project root.");
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function clampTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("timeoutMs must be an integer.");
  }
  return Math.max(1000, Math.min(value, MAX_COMMAND_TIMEOUT_MS));
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolExecutionResult> {
  throwIfCancelled(signal);
  const shell = resolveShell();
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];

  let output = "";
  let outputBytes = 0;
  let truncated = false;
  const child = spawn(shell, args, {
    cwd,
    env: safeToolEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const commandHandle = new ManagedCommand(child);
  runningCommands.add(commandHandle);

  const append = (chunk: Buffer) => {
    if (outputBytes >= MAX_COMMAND_OUTPUT_BYTES) {
      truncated = true;
      return;
    }
    const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
    const accepted = chunk.subarray(0, remaining);
    output += accepted.toString("utf8");
    outputBytes += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) {
      truncated = true;
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const abort = () => {
    void commandHandle.terminate("cancelled").catch(() => {});
  };
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(() => {
    void commandHandle.terminate("timeout").catch(() => {});
  }, timeoutMs);

  try {
    const outcome = await Promise.race([
      commandHandle.exit.then((exit) => ({ type: "exit" as const, exit })),
      commandHandle.cancellation.then((reason) => ({
        type: "cancellation" as const,
        reason,
      })),
    ]);

    if (outcome.type === "cancellation") {
      await commandHandle.terminate(outcome.reason);
      throw new ToolExecutionCancelledError(
        outcome.reason,
        appendTruncationNotice(output, truncated, cancellationMessage(outcome.reason)),
      );
    }

    const detail = outcome.exit.signal
      ? `Command stopped by signal ${outcome.exit.signal}.`
      : `Command exited with code ${outcome.exit.code ?? "unknown"}.`;
    return {
      output: appendTruncationNotice(output, truncated, detail),
      isError: outcome.exit.code !== 0,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    runningCommands.delete(commandHandle);
  }
}

function resolveShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

type CommandExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

class ManagedCommand {
  readonly exit: Promise<CommandExit>;
  readonly cancellation: Promise<ToolCancellationReason>;

  readonly #child: ChildProcess;
  #exited = false;
  #resolveCancellation!: (reason: ToolCancellationReason) => void;
  #termination?: Promise<void>;
  #reason?: ToolCancellationReason;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.cancellation = new Promise((resolvePromise) => {
      this.#resolveCancellation = resolvePromise;
    });
    this.exit = new Promise((resolvePromise, reject) => {
      child.once("error", (error) => {
        this.#exited = true;
        reject(error);
      });
      child.once("close", (code, signal) => {
        this.#exited = true;
        resolvePromise({ code, signal });
      });
    });
  }

  terminate(reason: ToolCancellationReason): Promise<void> {
    if (!this.#reason) {
      this.#reason = reason;
      this.#resolveCancellation(reason);
    }
    this.#termination ??= this.#terminate();
    return this.#termination;
  }

  async #terminate(): Promise<void> {
    if (this.#exited || !this.#child.pid) {
      return;
    }
    if (process.platform === "win32") {
      await terminateWindowsProcessTree(this.#child);
      return;
    }
    await terminatePosixProcessGroup(this.#child);
  }
}

async function terminatePosixProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  signalPosixProcessGroup(pid, "SIGTERM", child);
  if (await waitForPosixProcessGroupExit(pid, TERMINATION_GRACE_MS)) {
    return;
  }

  signalPosixProcessGroup(pid, "SIGKILL", child);
  if (await waitForPosixProcessGroupExit(pid, TERMINATION_KILL_WAIT_MS)) {
    return;
  }
  throw new Error(`Failed to terminate command process group ${pid}.`);
}

function signalPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  child: ChildProcess,
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    if (!child.kill(signal)) {
      throw error;
    }
  }
}

async function waitForPosixProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPosixProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(TERMINATION_POLL_MS);
  }
  return true;
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateWindowsProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  await runTaskkill(pid, false);
  if (await waitForChildExit(child, TERMINATION_GRACE_MS)) {
    return;
  }
  await runTaskkill(pid, true);
  if (await waitForChildExit(child, TERMINATION_KILL_WAIT_MS)) {
    return;
  }
  throw new Error(`Failed to terminate command process tree ${pid}.`);
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ["/pid", String(pid), "/t"];
  if (force) {
    args.push("/f");
  }
  const taskkill = spawn("taskkill", args, {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolvePromise, reject) => {
    taskkill.once("error", reject);
    taskkill.once("close", () => resolvePromise());
  });
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.removeListener("close", exited);
      resolvePromise(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    child.once("close", exited);
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolExecutionCancelledError("cancelled");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function cancellationMessage(reason: ToolCancellationReason): string {
  switch (reason) {
    case "cancelled":
      return "Command cancelled.";
    case "timeout":
      return "Command timed out.";
    case "shutdown":
      return "Command stopped because the tool runtime shut down.";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function appendTruncationNotice(
  output: string,
  truncated: boolean,
  detail: string,
): string {
  const notices = [
    truncated ? `[Output truncated at ${MAX_COMMAND_OUTPUT_BYTES} bytes.]` : "",
    detail,
  ].filter(Boolean);
  const separator = output && !output.endsWith("\n") ? "\n" : "";
  return `${output}${separator}${notices.join("\n")}`;
}
