import type { WorkspaceLayout } from "@scopeguard/domain";

export type WorkspaceLayoutStageResult =
  | { accepted: true }
  | { accepted: false; reason: "quiescing" };

export type WorkbenchLayoutStageCoordinatorOptions = {
  retryDelayMs: number;
  stage(layout: WorkspaceLayout): Promise<WorkspaceLayoutStageResult>;
  onError?(error: unknown): void;
};

type PendingLayout = {
  revision: number;
  layout: WorkspaceLayout;
};

type IdleWaiter = {
  resolve(): void;
  reject(error: unknown): void;
};

export class WorkbenchLayoutStageCoordinator {
  readonly #options: WorkbenchLayoutStageCoordinatorOptions;
  readonly #waiters = new Set<IdleWaiter>();
  #pending: PendingLayout | null = null;
  #revision = 0;
  #draining = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: WorkbenchLayoutStageCoordinatorOptions) {
    if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) {
      throw new Error("Layout stage retry delay must be a non-negative number.");
    }
    this.#options = options;
  }

  submit(layout: WorkspaceLayout): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new Error("Layout stage coordinator is disposed."));
    }
    this.#revision += 1;
    this.#pending = {
      revision: this.#revision,
      layout: structuredClone(layout),
    };
    const completion = this.whenIdle();
    this.#startDrain();
    return completion;
  }

  whenIdle(): Promise<void> {
    if (!this.#pending && !this.#draining && !this.#retryTimer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#waiters.add({ resolve, reject });
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = null;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#resolveWaiters();
  }

  #startDrain(): void {
    if (this.#draining || this.#retryTimer || this.#disposed) return;
    this.#draining = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending && !this.#disposed) {
        const staged = this.#pending;
        const result = await this.#options.stage(structuredClone(staged.layout));
        if (!result.accepted) {
          this.#scheduleRetry();
          return;
        }
        if (this.#pending.revision === staged.revision) {
          this.#pending = null;
        }
      }
    } catch (error) {
      this.#pending = null;
      this.#options.onError?.(error);
      this.#rejectWaiters(error);
      return;
    } finally {
      this.#draining = false;
    }
    if (!this.#pending) this.#resolveWaiters();
    else this.#startDrain();
  }

  #scheduleRetry(): void {
    if (this.#retryTimer || this.#disposed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#startDrain();
    }, this.#options.retryDelayMs);
  }

  #resolveWaiters(): void {
    for (const waiter of this.#waiters) waiter.resolve();
    this.#waiters.clear();
  }

  #rejectWaiters(error: unknown): void {
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }
}
