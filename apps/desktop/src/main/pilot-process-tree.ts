import { execFile, type ChildProcess } from "node:child_process";

const POLL_INTERVAL_MS = 20;

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ProcessTreeOptions = {
  platform?: NodeJS.Platform;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
};

export async function waitForProcessTree(
  child: ChildProcess,
  timeoutMs: number,
  description: string,
  options: ProcessTreeOptions = {},
): Promise<ProcessExit> {
  const exit = observeProcessExit(child);
  const timedOut = Symbol("timed-out");
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    exit,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (result !== timedOut) return result;

  await terminateProcessTree(child, options);
  await exit;
  throw new Error(`${description} timed out after ${timeoutMs}ms.`);
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeOptions = {},
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  const platform = options.platform ?? process.platform;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  if (platform === "win32") {
    await terminateWindowsProcessTree(pid);
    await waitForCondition(
      () => !isProcessAlive(pid),
      forceTimeoutMs,
      `Windows process tree ${pid} did not exit`,
    );
  } else {
    signalPosixProcessGroup(pid, "SIGTERM");
    const exitedGracefully = await waitForCondition(
      () => !isPosixProcessGroupAlive(pid),
      gracefulTimeoutMs,
    );
    if (!exitedGracefully) {
      signalPosixProcessGroup(pid, "SIGKILL");
      await waitForCondition(
        () => !isPosixProcessGroupAlive(pid),
        forceTimeoutMs,
        `POSIX process group ${pid} did not exit`,
      );
    }
  }

  await waitForObservedExit(child, forceTimeoutMs);
}

export function windowsTaskkillArguments(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

function observeProcessExit(child: ChildProcess): Promise<ProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off("close", onClose);
      child.off("error", onError);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function waitForObservedExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    observeProcessExit(child).then(() => undefined),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Root process did not report a confirmed exit.")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill",
      windowsTaskkillArguments(pid),
      { windowsHide: true },
      (error) => {
        if (error && isProcessAlive(pid)) {
          reject(new Error(`taskkill failed for process tree ${pid}: ${error.message}`));
          return;
        }
        resolve();
      },
    );
  });
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  failureMessage?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (condition()) return true;
  if (failureMessage) throw new Error(failureMessage);
  return false;
}
