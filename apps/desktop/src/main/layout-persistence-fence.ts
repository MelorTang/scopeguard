export type LayoutPersistenceFenceOptions = {
  timeoutMs: number;
  drainRenderer(): Promise<void>;
  resumeRenderer(): Promise<void>;
  suspend(): void;
  resume(): void;
  flushAll(): Promise<void>;
  reportError(message: string): void;
};

export type DestructiveLifecycleCommit = () => undefined;
export type DestructiveLifecycleAction = (
  signal: AbortSignal,
) => DestructiveLifecycleCommit | Promise<DestructiveLifecycleCommit>;
export type TerminalLifecycleCommit = () => void | Promise<void>;

type PreparedLifecycleAction = (
  signal: AbortSignal,
) => TerminalLifecycleCommit | Promise<TerminalLifecycleCommit>;

export class LayoutPersistenceFence {
  readonly #options: LayoutPersistenceFenceOptions;
  #inFlight: Promise<void> = Promise.resolve();
  #shutdown: Promise<void> | null = null;
  #shutdownComplete = false;

  constructor(options: LayoutPersistenceFenceOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Layout persistence timeout must be a positive number.");
    }
    this.#options = options;
  }

  run(reason: string, action: () => void | Promise<void>): Promise<void> {
    if (this.#shutdown) {
      return Promise.reject(new Error("Layout persistence shutdown is already in progress."));
    }
    return this.#enqueue(async () => {
      await this.#flush(reason);
      await action();
    });
  }

  runTransient(reason: string, action: DestructiveLifecycleAction): Promise<void> {
    if (this.#shutdown) {
      return Promise.reject(new Error("Layout persistence shutdown is already in progress."));
    }
    return this.#enqueue(() => this.#runQuiesced(reason, action, true, true));
  }

  runShutdown(
    reason: string,
    prepareTerminalShutdown: (signal: AbortSignal) => void | Promise<void>,
    commitTerminalShutdown: TerminalLifecycleCommit,
  ): Promise<void> {
    if (this.#shutdown) {
      return this.#shutdown;
    }
    if (this.#shutdownComplete) {
      return Promise.resolve();
    }
    const operation = this.#enqueue(() => this.#runQuiesced(
      reason,
      async (signal) => {
        await prepareTerminalShutdown(signal);
        return commitTerminalShutdown;
      },
      false,
      true,
    ));
    this.#shutdown = operation;
    void operation.then(
      () => {
        this.#shutdownComplete = true;
      },
      () => {
        if (this.#shutdown === operation) {
          this.#shutdown = null;
        }
      },
    );
    return operation;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.#inFlight.catch(() => undefined).then(operation);
    this.#inFlight = queued;
    return queued;
  }

  async #runQuiesced(
    reason: string,
    action: PreparedLifecycleAction,
    resumeAfter: boolean,
    drainRenderer = false,
  ): Promise<void> {
    let mainSuspended = false;
    let completed = false;
    let commitStarted = false;
    let operationError: unknown = null;
    try {
      if (drainRenderer) {
        await this.#drainRenderer(reason);
      }
      this.#options.suspend();
      mainSuspended = true;
      await this.#flush(reason);
      await this.#runAction(reason, action, () => {
        commitStarted = true;
      });
      completed = true;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (resumeAfter || (!completed && !commitStarted)) {
        await this.#recoverScheduling({
          mainSuspended,
          rendererMustResume: drainRenderer && !completed,
          operationError,
        });
      }
    }
  }

  async #recoverScheduling(input: {
    mainSuspended: boolean;
    rendererMustResume: boolean;
    operationError: unknown;
  }): Promise<void> {
    const recoveryErrors: Error[] = [];
    if (input.mainSuspended) {
      try {
        this.#options.resume();
      } catch (error) {
        recoveryErrors.push(asError(error));
      }
    }
    if (input.rendererMustResume) {
      try {
        await this.#options.resumeRenderer();
      } catch (error) {
        recoveryErrors.push(asError(error));
      }
    }
    if (recoveryErrors.length === 0) return;
    const primary = input.operationError === null ? null : asError(input.operationError);
    const message = [
      primary?.message,
      `Layout scheduling recovery failed: ${recoveryErrors.map(({ message }) => message).join("; ")}`,
    ].filter(Boolean).join(". ");
    this.#options.reportError(message);
    throw new Error(message, { cause: primary ?? recoveryErrors[0] });
  }

  async #drainRenderer(reason: string): Promise<void> {
    try {
      await withTimeout(
        this.#options.drainRenderer(),
        this.#options.timeoutMs,
        `Renderer layout drain timed out after ${this.#options.timeoutMs}ms.`,
      );
    } catch (cause) {
      const error = asError(cause);
      const message = `${reason} blocked because the latest Renderer layout could not be staged: ${error.message}`;
      this.#options.reportError(message);
      throw new Error(message, { cause: error });
    }
  }

  async #flush(reason: string): Promise<void> {
    try {
      await withTimeout(
        this.#options.flushAll(),
        this.#options.timeoutMs,
        `Workspace layout flush timed out after ${this.#options.timeoutMs}ms.`,
      );
    } catch (cause) {
      const error = asError(cause);
      const message = `${reason} blocked because the latest Workspace layout could not be saved: ${error.message}`;
      this.#options.reportError(message);
      throw new Error(message, { cause: error });
    }
  }

  async #runAction(
    reason: string,
    action: PreparedLifecycleAction,
    onCommitStart: () => void,
  ): Promise<void> {
    const controller = new AbortController();
    try {
      const commit = await withTimeout(
        Promise.resolve().then(() => action(controller.signal)),
        this.#options.timeoutMs,
        `Destructive lifecycle action timed out after ${this.#options.timeoutMs}ms.`,
        () => controller.abort(),
      );
      if (controller.signal.aborted) {
        throw new Error("Destructive lifecycle action was cancelled before commit.");
      }
      if (typeof commit !== "function") {
        throw new Error("Destructive lifecycle action did not return a commit function.");
      }
      // Preparation is the only phase subject to the outer timeout. Once the
      // permit is returned, the commit owns its own bounded completion and is
      // never raced against a timer that could restore scheduling underneath it.
      onCommitStart();
      await commit();
    } catch (cause) {
      const error = asError(cause);
      const message = `${reason} blocked because the destructive lifecycle action failed: ${error.message}`;
      this.#options.reportError(message);
      throw new Error(message, { cause: error });
    } finally {
      controller.abort();
    }
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
          onTimeout?.();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
