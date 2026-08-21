import type { WorkspaceLayout } from "@scopeguard/domain";
import type { StageWorkspaceLayoutResult } from "@scopeguard/ipc-contracts";

export type Phase3LayoutDrainSnapshot = {
  targetRevisionRejectedWhileQuiescing: boolean;
  targetRevisionAcceptedDuringRendererDrain: boolean;
  targetRevisionAcceptedOutsideRendererDrain: boolean;
  events: string[];
};

export class Phase3LayoutDrainEvidence {
  readonly #targetKey: string;
  readonly #events: string[] = [];
  #rejectedWhileQuiescing = false;
  #acceptedDuringDrain = false;
  #acceptedOutsideDrain = false;

  constructor(target: WorkspaceLayout) {
    this.#targetKey = layoutKey(target);
  }

  get targetRevisionRejectedWhileQuiescing(): boolean {
    return this.#rejectedWhileQuiescing;
  }

  recordStage(
    layout: WorkspaceLayout,
    result: StageWorkspaceLayoutResult,
    rendererDrainActive: boolean,
  ): void {
    if (layoutKey(layout) !== this.#targetKey) return;
    if (!result.accepted) {
      if (!this.#rejectedWhileQuiescing) {
        this.#events.push("target-revision-rejected-quiescing");
      }
      this.#rejectedWhileQuiescing = true;
      return;
    }
    if (rendererDrainActive) {
      if (!this.#acceptedDuringDrain) {
        this.#events.push("target-revision-accepted-during-renderer-drain");
      }
      this.#acceptedDuringDrain = true;
      return;
    }
    if (!this.#acceptedOutsideDrain) {
      this.#events.push("target-revision-accepted-outside-renderer-drain");
    }
    this.#acceptedOutsideDrain = true;
  }

  recordRendererDrainStarted(): void {
    this.#events.push("renderer-drain-started");
  }

  recordRendererDrainAcknowledged(): void {
    this.#events.push("renderer-drain-acknowledged");
  }

  recordMainSuspended(): void {
    this.#events.push("main-suspended");
  }

  recordSqliteFlushed(): void {
    this.#events.push("sqlite-flushed");
  }

  snapshot(): Phase3LayoutDrainSnapshot {
    return {
      targetRevisionRejectedWhileQuiescing: this.#rejectedWhileQuiescing,
      targetRevisionAcceptedDuringRendererDrain: this.#acceptedDuringDrain,
      targetRevisionAcceptedOutsideRendererDrain: this.#acceptedOutsideDrain,
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
