import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "SCOPEGUARD_APPROVAL:";

export default function approvalExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    const markerIndex = command.indexOf(MARKER);
    if (markerIndex < 0) return undefined;

    const scenario = command
      .slice(markerIndex + MARKER.length)
      .split(/\s/, 1)[0];
    if (scenario === "extension-error") {
      throw new Error(`SCOPEGUARD_EXTENSION_ERROR:${event.toolCallId}`);
    }

    const confirmed = await ctx.ui.confirm(
      `Approve ${event.toolName} ${event.toolCallId}`,
      JSON.stringify({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        scenario,
      }),
      { timeout: scenario === "timeout" ? 150 : 5_000 },
    );

    if (!confirmed) {
      return {
        block: true,
        reason: `SCOPEGUARD_BLOCKED:${scenario}:${event.toolCallId}`,
      };
    }

    return undefined;
  });
}
