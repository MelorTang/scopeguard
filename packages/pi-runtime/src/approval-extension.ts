import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { classifyToolPolicy, createApprovalPayload } from "./approval-policy.js";

const CONFIRM_TIMEOUT_MS = 300_000;

export default function scopeGuardToolPolicy(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, context) => {
    const decision = classifyToolPolicy(
      event.toolName,
      event.input,
      process.env.SCOPEGUARD_WORKSPACE_ROOT,
      parseReadPermission(process.env.SCOPEGUARD_READ_PERMISSION),
    );
    if (decision.action === "allow") return undefined;
    if (decision.action === "block") {
      return {
        block: true,
        reason: `SCOPEGUARD_POLICY_BLOCKED:${decision.reason}:${event.toolName}:${event.toolCallId}`,
      };
    }
    const payload = createApprovalPayload({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      toolInput: event.input,
    });
    const confirmed = await context.ui.confirm(
      `Approve ${event.toolName}`,
      JSON.stringify(payload),
      { timeout: CONFIRM_TIMEOUT_MS },
    );
    if (!confirmed) {
      return {
        block: true,
        reason: `SCOPEGUARD_APPROVAL_DENIED:${event.toolName}:${event.toolCallId}:${payload.canonicalInputSha256}`,
      };
    }
    return undefined;
  });
}

function parseReadPermission(value: string | undefined): "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny" ? value : "deny";
}
