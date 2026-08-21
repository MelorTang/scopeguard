import type { WorkspaceLayout } from "@scopeguard/domain";

export type WorkspaceLayoutStageResult =
  | { accepted: true }
  | { accepted: false; reason: "quiescing" };

export type WorkspaceLayoutDrainAcceptedRevision = {
  workspaceId: string;
  revision: number;
  layout: WorkspaceLayout;
};

export type WorkspaceLayoutDrainReceipt = {
  generation: string;
  acceptedRevisions: WorkspaceLayoutDrainAcceptedRevision[];
};

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

type ActiveDrain = {
  generation: string;
  acceptedRevisions: WorkspaceLayoutDrainAcceptedRevision[];
};

export class WorkbenchLayoutStageCoordinator {
  readonly #options: WorkbenchLayoutStageCoordinatorOptions;
  readonly #workspaces = new Map<string, WorkspaceStageState>();
  #disposed = false;
  #acceptingSubmissions = true;
  #activeDrain: ActiveDrain | null = null;

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
    if (!this.#acceptingSubmissions) {
      return Promise.reject(new Error("Workspace layout staging is quiescing."));
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

  get isAcceptingSubmissions(): boolean {
    return this.#acceptingSubmissions && !this.#disposed;
  }

  async quiesceAndDrain(generation: string): Promise<WorkspaceLayoutDrainReceipt> {
    if (this.#disposed) {
      throw new Error("Layout stage coordinator is disposed.");
    }
    if (!generation.trim()) {
      throw new Error("Renderer layout drain generation must not be empty.");
    }
    if (this.#activeDrain) {
      throw new Error("Renderer layout drain is already in progress.");
    }
    const activeDrain: ActiveDrain = {
      generation,
      acceptedRevisions: [],
    };
    this.#activeDrain = activeDrain;
    this.#acceptingSubmissions = false;
    try {
      for (const state of this.#workspaces.values()) {
        state.failure = null;
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
        this.#startDrain(state);
      }
      await this.whenIdle();
      return {
        generation,
        acceptedRevisions: activeDrain.acceptedRevisions
          .map((revision) => structuredClone(revision))
          .sort((left, right) =>
            left.workspaceId.localeCompare(right.workspaceId) ||
            left.revision - right.revision
          ),
      };
    } finally {
      if (this.#activeDrain === activeDrain) this.#activeDrain = null;
    }
  }

  resumeSubmissions(): void {
    if (this.#disposed) return;
    this.#acceptingSubmissions = true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#acceptingSubmissions = false;
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
    let retryImmediately = false;
    try {
      while (state.pending && !this.#disposed) {
        const staged = state.pending;
        const startedWhileQuiesced = !this.#acceptingSubmissions;
        const drainGeneration = this.#activeDrain?.generation ?? null;
        const result = await this.#options.stage(structuredClone(staged.layout));
        if (!result.accepted) {
          if (!this.#acceptingSubmissions && !startedWhileQuiesced) {
            retryImmediately = true;
          } else {
            this.#scheduleRetry(state);
          }
          break;
        }
        if (
          drainGeneration &&
          this.#activeDrain?.generation === drainGeneration
        ) {
          this.#activeDrain.acceptedRevisions.push({
            workspaceId: staged.layout.workspaceId,
            revision: staged.revision,
            layout: structuredClone(staged.layout),
          });
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
    if (retryImmediately) {
      this.#startDrain(state);
      return;
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
