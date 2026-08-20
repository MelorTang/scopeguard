import {
  type AgentRun,
  type CreateDispatchInput,
  type Dispatch,
  type Id,
} from "@scopeguard/domain";

export interface DispatchWorkflowStore {
  createDispatch(input: CreateDispatchInput): Dispatch;
  getDispatch(id: Id): Dispatch | null;
  listDispatches(filter?: { workspaceId?: Id; conversationId?: Id }): Dispatch[];
  updateDispatchStatus(
    id: Id,
    status: Dispatch["status"],
    patch?: { targetRunId?: Id | null; error?: string | null },
  ): Dispatch;
  interruptNonTerminalDispatches(): number;
}

export class DispatchWorkflow {
  readonly #store: DispatchWorkflowStore;

  constructor(store: DispatchWorkflowStore) {
    this.#store = store;
  }

  create(input: CreateDispatchInput): Dispatch {
    return this.#store.createDispatch(input);
  }

  list(workspaceId: Id): Dispatch[] {
    return this.#store.listDispatches({ workspaceId });
  }

  async execute(
    dispatchId: Id,
    targetIsBusy: (conversationId: Id) => boolean,
    startTargetRun: (
      conversationId: Id,
      prompt: string,
      onCreated: (run: AgentRun) => void,
    ) => Promise<AgentRun>,
  ): Promise<Dispatch> {
    const dispatch = this.#require(dispatchId);
    if (dispatch.status !== "pending") {
      throw new Error("Only a pending Dispatch can be executed.");
    }
    if (targetIsBusy(dispatch.targetConversationId)) {
      return this.#store.updateDispatchStatus(dispatch.id, "failed", {
        error: "Target Conversation already has an active Run.",
      });
    }
    try {
      await startTargetRun(
        dispatch.targetConversationId,
        dispatch.prompt,
        (run) => {
          this.#store.updateDispatchStatus(dispatch.id, "running", {
            targetRunId: run.id,
          });
        },
      );
      return this.#require(dispatch.id);
    } catch (error) {
      const current = this.#require(dispatch.id);
      if (current.status === "pending" || current.status === "running") {
        return this.#store.updateDispatchStatus(current.id, "failed", {
          error: errorMessage(error),
        });
      }
      throw error;
    }
  }

  settleRun(run: AgentRun): void {
    const status = run.status === "completed"
      ? "completed"
      : run.status === "cancelled"
        ? "cancelled"
        : run.status === "interrupted"
          ? "interrupted"
          : run.status === "failed"
            ? "failed"
            : null;
    if (!status) return;
    for (const dispatch of this.#store.listDispatches()) {
      if (dispatch.targetRunId !== run.id || dispatch.status !== "running") continue;
      this.#store.updateDispatchStatus(dispatch.id, status, {
        error: run.error,
      });
    }
  }

  reconcile(): number {
    return this.#store.interruptNonTerminalDispatches();
  }

  #require(id: Id): Dispatch {
    const dispatch = this.#store.getDispatch(id);
    if (!dispatch) throw new Error(`Dispatch not found: ${id}`);
    return dispatch;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
