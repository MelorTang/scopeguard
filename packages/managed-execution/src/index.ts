import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import type {
  ConversationExecutionProfile,
  Id,
  ManagedExecutionProgress,
  ManagedExecutionStage,
} from "@scopeguard/domain";

const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
const TERMINATION_GRACE_MS = 500;
const TERMINATION_KILL_WAIT_MS = 2_000;
const TERMINATION_POLL_MS = 20;

export type ManagedExecutionEvent = ManagedExecutionProgress;
export type { ManagedExecutionStage } from "@scopeguard/domain";

export type ManagedExecutionRequest = {
  executionId: Id;
  projectId: Id;
  threadId: Id;
  runId: Id;
  workspaceRoot: string;
  command: string;
  timeoutMs: number;
  environment: Readonly<Record<string, string>>;
};

export type ManagedExecutionResult = {
  executionId: Id;
  status: "exited" | "cancelled" | "timed-out" | "shut-down" | "failed";
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  termination: "confirmed" | "unconfirmed" | "not-started";
  cleanup: "clean" | "failed" | "not-required";
  effect: "confirmed" | "none" | "unknown";
  error?: string;
};

export type ManagedExecutionContext = {
  signal: AbortSignal;
  onEvent?: (event: ManagedExecutionEvent) => void;
};

export interface ManagedExecutionAdapter {
  execute(
    request: ManagedExecutionRequest,
    context: ManagedExecutionContext,
  ): Promise<ManagedExecutionResult>;
  shutdown(): Promise<void>;
}

export class ManagedExecutionUnavailableError extends Error {
  readonly code = "MANAGED_EXECUTION_UNAVAILABLE";

  constructor(message = "Managed execution is unavailable in this build.") {
    super(message);
    this.name = "ManagedExecutionUnavailableError";
  }
}

export class UnavailableManagedExecutionAdapter
  implements ManagedExecutionAdapter {
  async execute(): Promise<ManagedExecutionResult> {
    throw new ManagedExecutionUnavailableError();
  }

  async shutdown(): Promise<void> {}
}

export class ManagedExecutionRouter {
  readonly #bounded: ManagedExecutionAdapter;
  readonly #fullAccess: ManagedExecutionAdapter;

  constructor(input: {
    bounded: ManagedExecutionAdapter;
    fullAccess: ManagedExecutionAdapter;
  }) {
    this.#bounded = input.bounded;
    this.#fullAccess = input.fullAccess;
  }

  execute(
    profile: ConversationExecutionProfile,
    request: ManagedExecutionRequest,
    context: ManagedExecutionContext,
  ): Promise<ManagedExecutionResult> {
    return (profile === "full-access" ? this.#fullAccess : this.#bounded)
      .execute(request, context);
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.#bounded.shutdown(),
      this.#fullAccess === this.#bounded
        ? Promise.resolve()
        : this.#fullAccess.shutdown(),
    ]);
  }
}

type CancellationReason = "cancelled" | "timeout" | "shutdown";

/** Executes only the explicit Full Access profile as the current desktop user. */
export class CurrentUserManagedExecutionAdapter
implements ManagedExecutionAdapter {
  readonly #running = new Set<ManagedCommand>();
  readonly #maxOutputBytes: number;

  constructor(input: { maxOutputBytes?: number } = {}) {
    this.#maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async execute(
    request: ManagedExecutionRequest,
    context: ManagedExecutionContext,
  ): Promise<ManagedExecutionResult> {
    emit(context, request.executionId, "accepted");
    if (context.signal.aborted) {
      return cancellationResult(request.executionId, "cancelled", "", false);
    }

    const shell = resolveShell();
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", request.command]
      : ["-lc", request.command];
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    let command: ManagedCommand | undefined;

    try {
      const child = spawn(shell, args, {
        cwd: request.workspaceRoot,
        env: request.environment,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      command = new ManagedCommand(child);
      this.#running.add(command);
      emit(context, request.executionId, "running");

      const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (outputBytes >= this.#maxOutputBytes) {
          truncated = true;
          return;
        }
        const accepted = chunk.subarray(0, this.#maxOutputBytes - outputBytes);
        const text = accepted.toString("utf8");
        output += text;
        outputBytes += accepted.byteLength;
        truncated ||= accepted.byteLength < chunk.byteLength;
        if (text) {
          context.onEvent?.({
            executionId: request.executionId,
            stage: "running",
            at: new Date().toISOString(),
            stream,
            chunk: text,
          });
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

      const abort = () => {
        void command?.terminate("cancelled").catch(() => {});
      };
      context.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        void command?.terminate("timeout").catch(() => {});
      }, request.timeoutMs);

      try {
        const outcome = await Promise.race([
          command.exit.then((exit) => ({ type: "exit" as const, exit })),
          command.cancellation.then((reason) => ({
            type: "cancellation" as const,
            reason,
          })),
        ]);
        if (outcome.type === "cancellation") {
          emit(context, request.executionId, "stopping");
          await command.terminate(outcome.reason);
          emit(context, request.executionId, "cleaning");
          const result = cancellationResult(
            request.executionId,
            outcome.reason,
            output,
            truncated,
            this.#maxOutputBytes,
          );
          emit(context, request.executionId, "completed");
          return result;
        }

        emit(context, request.executionId, "cleaning");
        const detail = outcome.exit.signal
          ? `Command stopped by signal ${outcome.exit.signal}.`
          : `Command exited with code ${outcome.exit.code ?? "unknown"}.`;
        emit(context, request.executionId, "completed");
        return {
          executionId: request.executionId,
          status: "exited",
          exitCode: outcome.exit.code,
          output: appendNotice(output, truncated, this.#maxOutputBytes, detail),
          outputTruncated: truncated,
          termination: "confirmed",
          cleanup: "not-required",
          effect: "confirmed",
        };
      } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      emit(context, request.executionId, "failed");
      return {
        executionId: request.executionId,
        status: "failed",
        exitCode: null,
        output,
        outputTruncated: truncated,
        termination: command ? "unconfirmed" : "not-started",
        cleanup: command ? "failed" : "not-required",
        effect: command ? "unknown" : "none",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (command) {
        this.#running.delete(command);
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#running].map((command) => command.terminate("shutdown")));
  }
}

function emit(
  context: ManagedExecutionContext,
  executionId: Id,
  stage: ManagedExecutionStage,
): void {
  context.onEvent?.({ executionId, stage, at: new Date().toISOString() });
}

function cancellationResult(
  executionId: Id,
  reason: CancellationReason,
  output: string,
  truncated: boolean,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): ManagedExecutionResult {
  const detail = reason === "timeout"
    ? "Command timed out."
    : reason === "shutdown"
      ? "Command stopped because managed execution shut down."
      : "Command cancelled.";
  return {
    executionId,
    status: reason === "timeout"
      ? "timed-out"
      : reason === "shutdown"
        ? "shut-down"
        : "cancelled",
    exitCode: null,
    output: appendNotice(output, truncated, maxOutputBytes, detail),
    outputTruncated: truncated,
    termination: "confirmed",
    cleanup: "not-required",
    effect: "unknown",
  };
}

function appendNotice(
  output: string,
  truncated: boolean,
  maxOutputBytes: number,
  detail: string,
): string {
  const notices = [
    truncated ? `[Output truncated at ${maxOutputBytes} bytes.]` : "",
    detail,
  ].filter(Boolean);
  const separator = output && !output.endsWith("\n") ? "\n" : "";
  return `${output}${separator}${notices.join("\n")}`;
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
  readonly cancellation: Promise<CancellationReason>;

  readonly #child: ChildProcess;
  #exited = false;
  #resolveCancellation!: (reason: CancellationReason) => void;
  #termination?: Promise<void>;
  #reason?: CancellationReason;

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

  terminate(reason: CancellationReason): Promise<void> {
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
    } else {
      await terminatePosixProcessGroup(this.#child);
    }
  }
}

async function terminatePosixProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  signalPosixProcessGroup(pid, "SIGTERM", child);
  if (await waitForPosixProcessGroupExit(pid, TERMINATION_GRACE_MS)) return;
  signalPosixProcessGroup(pid, "SIGKILL", child);
  if (await waitForPosixProcessGroupExit(pid, TERMINATION_KILL_WAIT_MS)) return;
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
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    if (!child.kill(signal)) throw error;
  }
}

async function waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPosixProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
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
  if (!pid) return;
  await runTaskkill(pid, false);
  if (await waitForChildExit(child, TERMINATION_GRACE_MS)) return;
  await runTaskkill(pid, true);
  if (await waitForChildExit(child, TERMINATION_KILL_WAIT_MS)) return;
  throw new Error(`Failed to terminate command process tree ${pid}.`);
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ["/pid", String(pid), "/t"];
  if (force) args.push("/f");
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

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export {
  SpawnNativeProcessRunner,
  WindowsLpacManagedExecutionAdapter,
  type NativeProcessInput,
  type NativeProcessResult,
  type NativeProcessRunner,
  type WindowsLpacManagedExecutionConfig,
} from "./windows-lpac-adapter.js";
