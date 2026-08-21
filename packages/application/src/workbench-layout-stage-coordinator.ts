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

type WorkspaceStageState = {
  revision: number;
  pending: PendingLayout | null;
  draining: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  failure: unknown | null;
  waiters: Set<IdleWaiter>;
};

export class WorkbenchLayoutStageCoordinator {
  readonly #options: WorkbenchLayoutStageCoordinatorOptions;
  readonly #workspaces = new Map<string, WorkspaceStageState>();
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
    const state = this.#stateFor(layout.workspaceId);
    state.failure = null;
    state.revision += 1;
    state.pending = {
      revision: state.revision,
      layout: structuredClone(layout),
    };
    const completion = this.#whenWorkspaceIdle(state);
    this.#startDrain(state);
    return completion;
  }

  whenIdle(): Promise<void> {
    return Promise.all(
      [...this.#workspaces.values()].map((state) => this.#whenWorkspaceIdle(state)),
    ).then(() => undefined);
  }

  dispose(): void {
    this.#disposed = true;
    for (const state of this.#workspaces.values()) {
      state.pending = null;
      state.failure = null;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = null;
      this.#resolveWaiters(state);
    }
    this.#workspaces.clear();
  }

  #stateFor(workspaceId: string): WorkspaceStageState {
    const existing = this.#workspaces.get(workspaceId);
    if (existing) return existing;
    const created: WorkspaceStageState = {
      revision: 0,
      pending: null,
      draining: false,
      retryTimer: null,
      failure: null,
      waiters: new Set(),
    };
    this.#workspaces.set(workspaceId, created);
    return created;
  }

  #whenWorkspaceIdle(state: WorkspaceStageState): Promise<void> {
    if (state.failure !== null) return Promise.reject(state.failure);
    if (!state.pending && !state.draining && !state.retryTimer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      state.waiters.add({ resolve, reject });
    });
  }

  #startDrain(state: WorkspaceStageState): void {
    if (state.draining || state.retryTimer || this.#disposed || state.failure !== null) {
      return;
    }
    state.draining = true;
    void this.#drain(state);
  }

  async #drain(state: WorkspaceStageState): Promise<void> {
    try {
      while (state.pending && !this.#disposed) {
        const staged = state.pending;
        const result = await this.#options.stage(structuredClone(staged.layout));
        if (!result.accepted) {
          this.#scheduleRetry(state);
          return;
        }
        if (state.pending?.revision === staged.revision) state.pending = null;
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      state.failure = failure;
      this.#options.onError?.(failure);
      this.#rejectWaiters(state, failure);
      return;
    } finally {
      state.draining = false;
    }
    if (!state.pending) this.#resolveWaiters(state);
    else this.#startDrain(state);
  }

  #scheduleRetry(state: WorkspaceStageState): void {
    if (state.retryTimer || this.#disposed) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      this.#startDrain(state);
    }, this.#options.retryDelayMs);
  }

  #resolveWaiters(state: WorkspaceStageState): void {
    for (const waiter of state.waiters) waiter.resolve();
    state.waiters.clear();
  }

  #rejectWaiters(state: WorkspaceStageState, error: unknown): void {
    for (const waiter of state.waiters) waiter.reject(error);
    state.waiters.clear();
  }
}
