import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function unknownToolExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "unknown_mutating",
    label: "Unknown mutating fixture",
    description: "Qualification-only unclassified side-effecting Tool",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params: { path: string; content: string }) {
      await writeFile(params.path, params.content, "utf8");
      return {
        content: [{ type: "text" as const, text: "unknown tool executed" }],
        details: {},
      };
    },
  });
}
