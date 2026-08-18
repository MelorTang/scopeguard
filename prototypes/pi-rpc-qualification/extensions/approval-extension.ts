import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyToolPolicy,
  createApprovalPayload,
} from "./approval-policy.ts";

const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000;

export default function approvalExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (
      process.env.SCOPEGUARD_QUALIFICATION_THROW_TOOL_CALL_ID ===
      event.toolCallId
    ) {
      throw new Error(`SCOPEGUARD_EXTENSION_ERROR:${event.toolCallId}`);
    }

    const decision = classifyToolPolicy(event.toolName);
    if (decision.action === "allow") return undefined;
    if (decision.action === "block") {
      return {
        block: true,
        reason: `SCOPEGUARD_POLICY_BLOCKED:${event.toolName}:${event.toolCallId}`,
      };
    }

    const payload = createApprovalPayload({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
    const configuredTimeout = Number.parseInt(
      process.env.SCOPEGUARD_QUALIFICATION_CONFIRM_TIMEOUT_MS ?? "",
      10,
    );
    const timeout = Number.isFinite(configuredTimeout)
      ? configuredTimeout
      : DEFAULT_CONFIRM_TIMEOUT_MS;
    const confirmed = await ctx.ui.confirm(
      `Approve ${event.toolName} ${event.toolCallId}`,
      JSON.stringify(payload),
      { timeout },
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
