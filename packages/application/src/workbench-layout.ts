import {
  parseWorkspaceLayout,
  type Id,
  type WorkspaceLayout,
} from "@scopeguard/domain";

export interface WorkbenchLayoutStore {
  getWorkspace(id: Id): unknown | null;
  listConversations(workspaceId?: Id): Array<{ id: Id }>;
  getWorkspaceLayout(workspaceId: Id): WorkspaceLayout | null;
  saveWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout;
}

export class WorkbenchLayoutService {
  readonly #store: WorkbenchLayoutStore;

  constructor(store: WorkbenchLayoutStore) {
    this.#store = store;
  }

  get(workspaceId: Id): WorkspaceLayout | null {
    this.#requireWorkspace(workspaceId);
    return this.#store.getWorkspaceLayout(workspaceId);
  }

  save(value: WorkspaceLayout): WorkspaceLayout {
    this.#requireWorkspace(value.workspaceId);
    const conversationIds = new Set(
      this.#store.listConversations(value.workspaceId).map(({ id }) => id),
    );
    return this.#store.saveWorkspaceLayout(
      parseWorkspaceLayout(value, conversationIds),
    );
  }

  restore(workspaceId: Id): WorkspaceLayout {
    const persisted = this.get(workspaceId);
    if (persisted) return persisted;
    const firstConversationId = this.#store.listConversations(workspaceId)[0]?.id;
    return {
      workspaceId,
      openConversationIds: firstConversationId ? [firstConversationId] : [],
      paneConversationIds: firstConversationId ? [firstConversationId] : [],
      activeConversationId: firstConversationId ?? null,
      requestedPaneCount: 1,
    };
  }

  #requireWorkspace(workspaceId: Id): void {
    if (!this.#store.getWorkspace(workspaceId)) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
  }
}
