export type LayoutPersistenceFenceOptions = {
  timeoutMs: number;
  flushAll(): Promise<void>;
  reportError(message: string): void;
};

export class LayoutPersistenceFence {
  readonly #options: LayoutPersistenceFenceOptions;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(options: LayoutPersistenceFenceOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Layout persistence timeout must be a positive number.");
    }
    this.#options = options;
  }

  run(reason: string, action: () => void | Promise<void>): Promise<void> {
    const operation = this.#inFlight.catch(() => undefined).then(async () => {
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
      await action();
    });
    this.#inFlight = operation;
    return operation;
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
