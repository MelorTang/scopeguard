import { spawn, type ChildProcess } from "node:child_process";

export type CliOutputStream = "stdout" | "stderr";

export interface CliOutputChunk {
  stream: CliOutputStream;
  chunk: string;
}

export interface RunCliAgentInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  prompt: string;
  projectRoot: string;
  signal: AbortSignal;
  onOutput: (output: CliOutputChunk) => void;
}

export interface CliAgentResult {
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CliAgentAbortedError extends Error {
  readonly code = "CLI_AGENT_ABORTED";

  constructor(readonly reason: "cancelled" | "shutdown" = "cancelled") {
    super(
      reason === "shutdown"
        ? "The CLI agent process stopped because the runtime shut down."
        : "The CLI agent process was aborted.",
    );
    this.name = "CliAgentAbortedError";
  }
}

export class CliAgentSpawnError extends Error {
  readonly code = "CLI_AGENT_SPAWN_FAILED";
  readonly command: string;
  readonly cause: Error;

  constructor(command: string, cause: Error) {
    super(`Failed to start CLI agent command "${command}": ${cause.message}`, {
      cause,
    });
    this.name = "CliAgentSpawnError";
    this.command = command;
    this.cause = cause;
  }
}

export class CliAgentProcessError extends Error {
  readonly code = "CLI_AGENT_PROCESS_FAILED";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(options: {
    command: string;
    args: readonly string[];
    cwd: string;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }) {
    const status =
      options.exitCode === null
        ? `signal ${options.exitSignal ?? "unknown"}`
        : `exit code ${options.exitCode}`;
    const diagnostic = lastNonEmptyLine(options.stderr) ?? lastNonEmptyLine(options.stdout);
    super(
      `CLI agent command "${options.command}" failed with ${status}${
        diagnostic ? `: ${diagnostic}` : ""
      }`,
    );
    this.name = "CliAgentProcessError";
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.exitCode = options.exitCode;
    this.exitSignal = options.exitSignal;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

const INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

const TERMINATION_GRACE_MS = 500;
const TERMINATION_KILL_WAIT_MS = 2_000;
const TERMINATION_POLL_MS = 20;
const MAX_OUTPUT_CHARACTERS = 1_000_000;

type RunningCliAgent = {
  terminate: (reason: "cancelled" | "shutdown") => Promise<void>;
};

const runningCliAgents = new Set<RunningCliAgent>();

export async function shutdownRunningCliAgents(): Promise<void> {
  await Promise.all(
    [...runningCliAgents].map((agent) => agent.terminate("shutdown")),
  );
}

export function cliAgentEnvironment(
  explicitEnvironment: Readonly<Record<string, string>>,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = parentEnvironment[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return { ...environment, ...explicitEnvironment };
}

export async function runCliAgent(input: RunCliAgentInput): Promise<CliAgentResult> {
  validateInput(input);
  if (input.signal.aborted) {
    throw new CliAgentAbortedError();
  }

  const usesPromptArgument = input.args.some((argument) => argument.includes("{prompt}"));
  const resolvedArgs = input.args.map((argument) =>
    argument
      .replaceAll("{prompt}", input.prompt)
      .replaceAll("{projectRoot}", input.projectRoot),
  );

  return await new Promise<CliAgentResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.command, resolvedArgs, {
        cwd: input.cwd,
        env: cliAgentEnvironment(input.env),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new CliAgentSpawnError(input.command, asError(error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let aborted = false;
    let abortReason: "cancelled" | "shutdown" = "cancelled";
    let spawnError: Error | undefined;
    let termination: Promise<void> | undefined;
    const runningAgent: RunningCliAgent = {
      terminate: async (reason) => {
        if (!aborted) {
          aborted = true;
          abortReason = reason;
        }
        termination ??= terminateProcessTree(child);
        await termination;
      },
    };
    runningCliAgents.add(runningAgent);

    const handleAbort = (): void => {
      if (aborted) {
        return;
      }
      void runningAgent.terminate("cancelled").catch(() => {});
    };

    input.signal.addEventListener("abort", handleAbort, { once: true });
    if (input.signal.aborted) {
      handleAbort();
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdin?.on("error", () => {
      // The process may close before consuming stdin. Its exit/error event is authoritative.
    });
    child.stdout?.on("data", (chunk: string) => {
      const captured = captureOutput(stdout, chunk, "stdout", stdoutTruncated);
      stdout = captured.value;
      stdoutTruncated = captured.truncated;
      if (captured.chunk) {
        input.onOutput({ stream: "stdout", chunk: captured.chunk });
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      const captured = captureOutput(stderr, chunk, "stderr", stderrTruncated);
      stderr = captured.value;
      stderrTruncated = captured.truncated;
      if (captured.chunk) {
        input.onOutput({ stream: "stderr", chunk: captured.chunk });
      }
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, exitSignal) => {
      void settle(exitCode, exitSignal);
    });

    const settle = async (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ) => {
      input.signal.removeEventListener("abort", handleAbort);
      runningCliAgents.delete(runningAgent);

      if (aborted) {
        try {
          await termination;
          reject(new CliAgentAbortedError(abortReason));
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (spawnError !== undefined) {
        reject(new CliAgentSpawnError(input.command, spawnError));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new CliAgentProcessError({
            command: input.command,
            args: resolvedArgs,
            cwd: input.cwd,
            exitCode,
            exitSignal,
            stdout,
            stderr,
          }),
        );
        return;
      }

      resolve({
        command: input.command,
        args: resolvedArgs,
        cwd: input.cwd,
        exitCode: 0,
        stdout,
        stderr,
      });
    };

    if (usesPromptArgument) {
      child.stdin?.end();
    } else {
      child.stdin?.end(input.prompt);
    }
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child, pid);
    return;
  }

  signalPosixProcessGroup(child, pid, "SIGTERM");
  if (await waitForPosixProcessGroupExit(pid, TERMINATION_GRACE_MS)) {
    return;
  }
  signalPosixProcessGroup(child, pid, "SIGKILL");
  if (await waitForPosixProcessGroupExit(pid, TERMINATION_KILL_WAIT_MS)) {
    return;
  }
  throw new Error(`Failed to terminate CLI agent process group ${pid}.`);
}

function signalPosixProcessGroup(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
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

async function terminateWindowsProcessTree(
  child: ChildProcess,
  pid: number,
): Promise<void> {
  await runTaskkill(pid, false);
  if (await waitForChildExit(child, TERMINATION_GRACE_MS)) {
    return;
  }
  await runTaskkill(pid, true);
  if (await waitForChildExit(child, TERMINATION_KILL_WAIT_MS)) {
    return;
  }
  throw new Error(`Failed to terminate CLI agent process tree ${pid}.`);
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const taskkill = spawn(
    "taskkill",
    ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])],
    {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    taskkill.once("error", rejectPromise);
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
    const exited = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener("close", exited);
      resolvePromise(false);
    }, timeoutMs);
    child.once("close", exited);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function validateInput(input: RunCliAgentInput): void {
  if (input.command.trim() === "") {
    throw new TypeError("CLI agent command must not be empty.");
  }
  if (input.cwd.trim() === "") {
    throw new TypeError("CLI agent cwd must not be empty.");
  }
  if (input.projectRoot.trim() === "") {
    throw new TypeError("CLI agent projectRoot must not be empty.");
  }
}

function captureOutput(
  current: string,
  incoming: string,
  stream: CliOutputStream,
  alreadyTruncated: boolean,
): { value: string; chunk: string; truncated: boolean } {
  if (alreadyTruncated) {
    return { value: current, chunk: "", truncated: true };
  }
  const remaining = MAX_OUTPUT_CHARACTERS - current.length;
  const accepted = remaining > 0 ? incoming.slice(0, remaining) : "";
  if (accepted.length === incoming.length) {
    return {
      value: current + accepted,
      chunk: accepted,
      truncated: false,
    };
  }
  const notice =
    `\n[${stream} truncated at ${MAX_OUTPUT_CHARACTERS} characters.]\n`;
  return {
    value: current + accepted + notice,
    chunk: accepted + notice,
    truncated: true,
  };
}

function lastNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
