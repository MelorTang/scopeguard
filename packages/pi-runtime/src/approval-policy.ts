import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ToolPolicyDecision =
  | { action: "allow"; reason: "workspace-read" }
  | { action: "approve"; reason: "known-side-effecting-tool" | "read-permission-ask" }
  | { action: "block"; reason: string };

export function canonicalizeToolInput(input: unknown): string {
  return JSON.stringify(normalizeCanonical(input));
}

export function hashCanonicalInput(canonicalInput: string): string {
  return createHash("sha256").update(canonicalInput, "utf8").digest("hex");
}

export function classifyToolPolicy(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string | undefined,
  readPermission: "allow" | "ask" | "deny" = "allow",
): ToolPolicyDecision {
  if (["bash", "write", "edit"].includes(toolName)) {
    return { action: "approve", reason: "known-side-effecting-tool" };
  }
  if (toolName !== "read") {
    return { action: "block", reason: "unknown-or-unclassified-tool" };
  }
  if (readPermission === "deny") {
    return { action: "block", reason: "read-permission-denied" };
  }
  if (!workspaceRoot || typeof input.path !== "string") {
    return { action: "block", reason: "read-without-workspace-path" };
  }
  let root: string;
  let target: string;
  try {
    root = realpathSync(resolve(workspaceRoot));
    target = realpathSync(resolve(root, input.path));
  } catch {
    return { action: "block", reason: "read-unresolvable-path" };
  }
  const fromRoot = relative(root, target);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    return readPermission === "ask"
      ? { action: "approve", reason: "read-permission-ask" }
      : { action: "allow", reason: "workspace-read" };
  }
  return { action: "block", reason: "read-outside-workspace" };
}

export function createApprovalPayload(input: {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  const canonical = canonicalizeToolInput(input.toolInput);
  return {
    schemaVersion: 1,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    canonicalInput: JSON.parse(canonical) as Record<string, unknown>,
    canonicalInputSha256: hashCanonicalInput(canonical),
  } as const;
}

function normalizeCanonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeCanonical(nested)]),
    );
  }
  throw new TypeError(`Unsupported canonical Tool input: ${typeof value}`);
}
