export type LayoutPersistenceFenceOptions = {
  timeoutMs: number;
  suspend(): void;
  resume(): void;
  flushAll(): Promise<void>;
  reportError(message: string): void;
};

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

  runTransient(reason: string, action: () => void | Promise<void>): Promise<void> {
    if (this.#shutdown) {
      return Promise.reject(new Error("Layout persistence shutdown is already in progress."));
    }
    return this.#enqueue(() => this.#runQuiesced(reason, action, true));
  }

  runShutdown(
    reason: string,
    destroyRenderer: () => void | Promise<void>,
    stopAgentHost: () => void | Promise<void>,
  ): Promise<void> {
    if (this.#shutdown) {
      return this.#shutdown;
    }
    if (this.#shutdownComplete) {
      return Promise.resolve();
    }
    const operation = this.#enqueue(() => this.#runQuiesced(reason, async () => {
      await destroyRenderer();
      await stopAgentHost();
    }, false));
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
    action: () => void | Promise<void>,
    resumeAfter: boolean,
  ): Promise<void> {
    this.#options.suspend();
    let completed = false;
    try {
      await this.#flush(reason);
      await action();
      completed = true;
    } finally {
      if (resumeAfter || !completed) {
        this.#options.resume();
      }
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
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
