import { createHash } from "node:crypto";

const AUTO_ALLOW_TOOLS = new Set(["read"]);
const APPROVAL_REQUIRED_TOOLS = new Set(["bash", "write", "edit"]);

export type ToolPolicyDecision =
  | { action: "allow"; reason: "explicit-read-only-allowlist" }
  | { action: "approve"; reason: "known-side-effecting-tool" }
  | { action: "block"; reason: "unknown-or-unclassified-tool" };

export function classifyToolPolicy(toolName: string): ToolPolicyDecision {
  if (AUTO_ALLOW_TOOLS.has(toolName)) {
    return { action: "allow", reason: "explicit-read-only-allowlist" };
  }
  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    return { action: "approve", reason: "known-side-effecting-tool" };
  }
  return { action: "block", reason: "unknown-or-unclassified-tool" };
}

function normalizeCanonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalizeCanonical(nested)]),
    );
  }
  throw new TypeError(`Unsupported canonical input value: ${typeof value}`);
}

export function canonicalizeToolInput(input: unknown): string {
  return JSON.stringify(normalizeCanonical(input));
}

export function hashCanonicalInput(canonicalInput: string): string {
  return createHash("sha256").update(canonicalInput, "utf8").digest("hex");
}

export function createApprovalPayload({
  toolCallId,
  toolName,
  input,
}: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) {
  const canonicalInput = canonicalizeToolInput(input);
  return {
    schemaVersion: 1,
    toolCallId,
    toolName,
    canonicalInput: JSON.parse(canonicalInput) as Record<string, unknown>,
    canonicalInputSha256: hashCanonicalInput(canonicalInput),
  } as const;
}
