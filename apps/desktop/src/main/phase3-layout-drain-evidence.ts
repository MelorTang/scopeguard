import type { WorkspaceLayout } from "@scopeguard/domain";
import type {
  RendererLayoutDrainAcceptedRevision,
  RendererLayoutDrainReceipt,
  StageWorkspaceLayoutResult,
} from "@scopeguard/ipc-contracts";

export type Phase3LayoutDrainSnapshot = {
  targetRevisionRejectedWhileQuiescing: boolean;
  targetRevisionAcceptedDuringRendererDrain: boolean;
  targetRevisionAcceptedOutsideRendererDrain: boolean;
  targetDrainReceipt: {
    generation: string;
    acceptedRevision: RendererLayoutDrainAcceptedRevision;
  } | null;
  events: string[];
};

export class Phase3LayoutDrainEvidence {
  readonly #targetKey: string;
  readonly #events: string[] = [];
  #rejectedWhileQuiescing = false;
  #targetAcceptanceCount = 0;
  #targetDrainReceipt: Phase3LayoutDrainSnapshot["targetDrainReceipt"] = null;

  constructor(target: WorkspaceLayout) {
    this.#targetKey = layoutKey(target);
  }

  get targetRevisionRejectedWhileQuiescing(): boolean {
    return this.#rejectedWhileQuiescing;
  }

  recordStage(layout: WorkspaceLayout, result: StageWorkspaceLayoutResult): void {
    if (layoutKey(layout) !== this.#targetKey) return;
    if (!result.accepted) {
      if (!this.#rejectedWhileQuiescing) {
        this.#events.push("target-revision-rejected-quiescing");
      }
      this.#rejectedWhileQuiescing = true;
      return;
    }
    this.#targetAcceptanceCount += 1;
    this.#events.push("target-revision-accepted-by-main");
  }

  recordDrainReceipt(receipt: RendererLayoutDrainReceipt): void {
    const matching = receipt.acceptedRevisions.filter(
      ({ layout }) => layoutKey(layout) === this.#targetKey,
    );
    if (matching.length > 1) {
      throw new Error("Renderer drain receipt repeated the target Workspace revision.");
    }
    const acceptedRevision = matching[0];
    if (!acceptedRevision) return;
    this.#targetDrainReceipt = {
      generation: receipt.generation,
      acceptedRevision: cloneAcceptedRevision(acceptedRevision),
    };
    this.#events.push("target-revision-confirmed-by-renderer-drain-receipt");
  }

  recordMainSuspended(): void {
    this.#events.push("main-suspended");
  }

  recordSqliteFlushed(): void {
    this.#events.push("sqlite-flushed");
  }

  snapshot(): Phase3LayoutDrainSnapshot {
    const acceptedDuringDrain = this.#targetDrainReceipt !== null
      && this.#targetAcceptanceCount >= 1;
    const drainAcceptanceCount = this.#targetDrainReceipt ? 1 : 0;
    return {
      targetRevisionRejectedWhileQuiescing: this.#rejectedWhileQuiescing,
      targetRevisionAcceptedDuringRendererDrain: acceptedDuringDrain,
      targetRevisionAcceptedOutsideRendererDrain:
        this.#targetAcceptanceCount > drainAcceptanceCount,
      targetDrainReceipt: this.#targetDrainReceipt
        ? {
            generation: this.#targetDrainReceipt.generation,
            acceptedRevision: cloneAcceptedRevision(
              this.#targetDrainReceipt.acceptedRevision,
            ),
          }
        : null,
      events: [...this.#events],
    };
  }
}

function layoutKey(layout: WorkspaceLayout): string {
  return JSON.stringify([
    layout.workspaceId,
    layout.openConversationIds,
    layout.paneConversationIds,
    layout.paneWidths,
    layout.activeConversationId,
    layout.requestedPaneCount,
  ]);
}

function cloneAcceptedRevision(
  accepted: RendererLayoutDrainAcceptedRevision,
): RendererLayoutDrainAcceptedRevision {
  return {
    workspaceId: accepted.workspaceId,
    revision: accepted.revision,
    layout: {
      ...accepted.layout,
      openConversationIds: [...accepted.layout.openConversationIds],
      paneConversationIds: [...accepted.layout.paneConversationIds],
      paneWidths: [...accepted.layout.paneWidths],
    },
  };
}
