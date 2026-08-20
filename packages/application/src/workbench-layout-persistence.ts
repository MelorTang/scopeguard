import type { WorkspaceLayout } from "@scopeguard/domain";

type PendingWorkspaceLayout = {
  revision: number;
  persistedRevision: number;
  layout: WorkspaceLayout;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void>;
};

export type WorkbenchLayoutPersistenceOptions = {
  delayMs: number;
  save(layout: WorkspaceLayout): Promise<WorkspaceLayout>;
  onSaved?(layout: WorkspaceLayout): void;
  onError?(error: unknown): void;
};

export class WorkbenchLayoutPersistence {
  readonly #options: WorkbenchLayoutPersistenceOptions;
  readonly #pending = new Map<string, PendingWorkspaceLayout>();

  constructor(options: WorkbenchLayoutPersistenceOptions) {
    if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
      throw new Error("Layout persistence delay must be a non-negative number.");
    }
    this.#options = options;
  }

  get pendingWorkspaceCount(): number {
    return this.#pending.size;
  }

  schedule(layout: WorkspaceLayout): void {
    const current = this.#pending.get(layout.workspaceId);
    const state: PendingWorkspaceLayout = current ?? {
      revision: 0,
      persistedRevision: 0,
      layout,
      timer: null,
      inFlight: Promise.resolve(),
    };
    state.revision += 1;
    state.layout = structuredClone(layout);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#persist(layout.workspaceId, state).catch((error) => {
        this.#options.onError?.(error);
      });
    }, this.#options.delayMs);
    this.#pending.set(layout.workspaceId, state);
  }

  async flush(workspaceId: string): Promise<void> {
    while (true) {
      const state = this.#pending.get(workspaceId);
      if (!state) return;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      await this.#persist(workspaceId, state);
    }
  }

  async flushAll(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all(
        [...this.#pending.keys()].map((workspaceId) => this.flush(workspaceId)),
      );
    }
  }

  #persist(workspaceId: string, state: PendingWorkspaceLayout): Promise<void> {
    const revision = state.revision;
    const layout = structuredClone(state.layout);
    state.inFlight = state.inFlight.catch(() => undefined).then(async () => {
      if (revision <= state.persistedRevision) return;
      const saved = await this.#options.save(layout);
      state.persistedRevision = revision;
      this.#options.onSaved?.(saved);
    }).finally(() => {
      if (
        state.persistedRevision === state.revision &&
        !state.timer &&
        this.#pending.get(workspaceId) === state
      ) {
        this.#pending.delete(workspaceId);
      }
    });
    return state.inFlight;
  }
}
