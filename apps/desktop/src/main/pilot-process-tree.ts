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
  knownDescendantPids?: () => Promise<readonly number[]>;
  windowsProcessController?: WindowsProcessController;
};

export type WindowsProcessController = {
  isProcessAlive(pid: number): boolean;
  taskkill(pid: number): Promise<void>;
};

export class ProcessTreeExitedWithFailure extends Error {
  readonly cleanupConfirmed = true;
}

export async function waitForProcessTree(
  child: ChildProcess,
  timeoutMs: number,
  description: string,
  options: ProcessTreeOptions = {},
): Promise<ProcessExit> {
  const exit = observeProcessExit(child);
  const timedOut = Symbol("timed-out");
  let timer: NodeJS.Timeout | undefined;
  let result: ProcessExit | typeof timedOut;
  try {
    result = await Promise.race([
      exit,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result !== timedOut) {
    await confirmNormalProcessTreeExit(child, options);
    return result;
  }

  await terminateProcessTree(child, options);
  await exit;
  throw new ProcessTreeExitedWithFailure(
    `${description} timed out after ${timeoutMs}ms.`,
  );
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
    const controller = options.windowsProcessController ?? defaultWindowsController;
    const rootAlreadyExited = hasProcessExited(child);
    let taskkillError: unknown;
    if (!rootAlreadyExited) {
      try {
        await runWindowsTaskkill(controller, pid);
      } catch (error) {
        taskkillError = error;
      }
    }
    const rootExited = await waitForCondition(
      () => !controller.isProcessAlive(pid),
      forceTimeoutMs,
    );
    let knownPids: readonly number[] = [];
    let knownPidsError: unknown;
    try {
      knownPids = await requireKnownDescendantPids(options, pid);
    } catch (error) {
      knownPidsError = error;
    }
    const knownExited = knownPidsError === undefined
      ? await waitForCondition(
          () => knownPids.every((knownPid) => !controller.isProcessAlive(knownPid)),
          forceTimeoutMs,
        )
      : false;
    if (taskkillError) throw taskkillError;
    if (knownPidsError) throw knownPidsError;
    if (!rootExited) {
      throw new Error(`Windows process tree ${pid} did not exit.`);
    }
    if (!knownExited) {
      const survivors = knownPids.filter((knownPid) =>
        controller.isProcessAlive(knownPid)
      );
      if (survivors.length > 0) {
        throw new Error(
          `Windows process tree ${pid} known descendant ${survivors.join(", ")} is still running; refusing bare-PID termination because process identity cannot be confirmed.`,
        );
      }
    }
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

async function requireKnownDescendantPids(
  options: ProcessTreeOptions,
  rootPid: number,
): Promise<readonly number[]> {
  if (!options.knownDescendantPids) {
    throw new Error(
      `Windows process tree ${rootPid} cannot confirm exit without known descendant PIDs.`,
    );
  }
  const knownPids = [...new Set(await options.knownDescendantPids())];
  if (knownPids.some((pid) =>
    !Number.isSafeInteger(pid) || pid <= 0 || pid === rootPid
  )) {
    throw new Error(
      `Windows process tree ${rootPid} received invalid known descendant PIDs.`,
    );
  }
  return knownPids;
}

async function confirmNormalProcessTreeExit(
  child: ChildProcess,
  options: ProcessTreeOptions,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const platform = options.platform ?? process.platform;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
  if (platform === "win32") {
    const controller = options.windowsProcessController ?? defaultWindowsController;
    const knownPids = await requireKnownDescendantPids(options, pid);
    const exited = await waitForCondition(
      () => knownPids.every((knownPid) => !controller.isProcessAlive(knownPid)),
      gracefulTimeoutMs,
    );
    if (exited) return;
  } else {
    const exited = await waitForCondition(
      () => !isPosixProcessGroupAlive(pid),
      gracefulTimeoutMs,
    );
    if (exited) return;
  }

  await terminateProcessTree(child, options);
  throw new ProcessTreeExitedWithFailure(
    `Process tree ${pid} left running descendants after the root exited.`,
  );
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

const defaultWindowsController: WindowsProcessController = {
  isProcessAlive,
  taskkill: executeWindowsTaskkill,
};

async function runWindowsTaskkill(
  controller: WindowsProcessController,
  pid: number,
): Promise<void> {
  try {
    await controller.taskkill(pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`taskkill failed for process tree ${pid}: ${message}`);
  }
}

async function executeWindowsTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill",
      windowsTaskkillArguments(pid),
      { windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

function hasProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
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
