import type { WorkspaceLayout } from "@scopeguard/domain";
import {
  parseWorkspaceLayoutRequest,
  type StageWorkspaceLayoutResult,
} from "@scopeguard/ipc-contracts";

export type WorkspaceLayoutScheduler = {
  readonly isSchedulingSuspended: boolean;
  schedule(layout: WorkspaceLayout): void;
};

export function stageWorkspaceLayoutRequest(
  value: unknown,
  persistence: WorkspaceLayoutScheduler,
): StageWorkspaceLayoutResult {
  const layout = parseWorkspaceLayoutRequest(value);
  if (persistence.isSchedulingSuspended) {
    return { accepted: false, reason: "quiescing" };
  }
  persistence.schedule(layout);
  return { accepted: true };
}
