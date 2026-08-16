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
import {
  CurrentUserManagedExecutionAdapter,
  ManagedExecutionRouter,
  UnavailableManagedExecutionAdapter,
} from "@scopeguard/managed-execution";

const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;

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

const defaultExecutionRouter = new ManagedExecutionRouter({
  bounded: new UnavailableManagedExecutionAdapter(),
  fullAccess: new CurrentUserManagedExecutionAdapter(),
});

export async function shutdownRunningCommands(): Promise<void> {
  await defaultExecutionRouter.shutdown();
}

export class ScopeGuardToolRegistry implements ToolRegistry {
  readonly #tools: Map<string, AgentTool>;

  readonly #executionRouter: ManagedExecutionRouter;

  constructor(
    tools?: AgentTool[],
    executionRouter: ManagedExecutionRouter = defaultExecutionRouter,
  ) {
    const registeredTools = tools ?? [
      new ReadFileTool(),
      new WriteFileTool(),
      new RunCommandTool(executionRouter),
    ];
    this.#executionRouter = executionRouter;
    this.#tools = new Map(
      registeredTools.map((tool) => [tool.definition.name, tool]),
    );
  }

  definitions(policy: AgentToolPolicy) {
    return [...this.#tools.values()]
      .filter((tool) => policy[tool.permission] !== "deny")
      .map((tool) => tool.definition);
  }

  get(name: string): AgentTool | null {
    return this.#tools.get(name) ?? null;
  }

  shutdown(): Promise<void> {
    return this.#executionRouter.shutdown();
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
      context.workspaceRoot,
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

    const root = await realpath(context.workspaceRoot);
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
  readonly #executionRouter: ManagedExecutionRouter;

  constructor(executionRouter: ManagedExecutionRouter = defaultExecutionRouter) {
    this.#executionRouter = executionRouter;
  }

  readonly permission = "runCommands" as const;
  readonly definition = {
    name: "run_command",
    description:
      "Run a shell command in the current project under the Conversation execution profile.",
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
    const workspaceRoot = await realpath(context.workspaceRoot);
    const timeoutMs = clampTimeout(input.timeoutMs);
    const result = await this.#executionRouter.execute(
      context.executionProfile,
      {
        executionId: randomUUID().replaceAll("-", ""),
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        runId: context.runId,
        workspaceRoot: workspaceRoot,
        command,
        timeoutMs,
        environment: safeToolEnvironment(),
      },
      {
        signal: context.signal,
        onEvent: context.onManagedExecutionEvent,
      },
    );
    if (
      result.status === "cancelled" ||
      result.status === "timed-out" ||
      result.status === "shut-down"
    ) {
      const reason: ToolCancellationReason = result.status === "timed-out"
        ? "timeout"
        : result.status === "shut-down"
          ? "shutdown"
          : "cancelled";
      throw new ToolExecutionCancelledError(reason, result.output);
    }
    return {
      output: result.error
        ? `${result.output}${result.output ? "\n" : ""}${result.error}`
        : result.output,
      isError: result.status === "failed" || result.exitCode !== 0,
    };
  }
}

export async function resolveExistingProjectPath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("Path cannot be empty.");
  }

  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  assertPathInsideRoot(root, candidate);
  await access(candidate, fsConstants.R_OK);
  const canonical = await realpath(candidate);
  assertPathInsideRoot(root, canonical);
  return canonical;
}

export function safeToolEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
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
