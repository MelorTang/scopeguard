import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveExtensionProfile,
  validateExtensionComposition,
  verifyExtensionFiles,
} from "../extension-composition.mjs";
import {
  canonicalizeToolInput,
  classifyToolPolicy,
} from "../extensions/approval-policy.ts";
import {
  assertSuccess,
  contentText,
  persistedToolResult,
} from "../qualification/assertions.mjs";
import { Classification } from "../qualification/evidence.mjs";
import { buildExtensionResponse } from "../rpc-process.mjs";

async function qualifyCompositionGate(harness) {
  assert.deepEqual(classifyToolPolicy("read"), {
    action: "allow",
    reason: "explicit-read-only-allowlist",
  });
  for (const toolName of ["bash", "write", "edit"]) {
    assert.equal(classifyToolPolicy(toolName).action, "approve");
  }
  assert.equal(classifyToolPolicy("unknown_mutating").action, "block");
  assert.equal(
    canonicalizeToolInput({ z: 1, a: { y: 2, x: 3 } }),
    canonicalizeToolInput({ a: { x: 3, y: 2 }, z: 1 }),
  );

  const production = harness.extensionProfiles.get("production");
  const mutator = harness.extensionProfiles.get("mutator-test")[0];
  assert.throws(
    () => validateExtensionComposition([production[0], mutator]),
    /must be final/,
  );
  assert.throws(
    () =>
      resolveExtensionProfile(
        { version: 1, extensions: {}, profiles: { forged: ["unapproved"] } },
        "forged",
      ),
    /unapproved extension id/,
  );
  await assert.rejects(
    verifyExtensionFiles(
      [{ ...production[0], sha256: "0".repeat(64), absolutePath: undefined }],
      harness.root,
    ),
    /hash mismatch/,
  );
  assert.deepEqual(
    buildExtensionResponse(
      { type: "extension_ui_request", id: "input-1", method: "input" },
      { value: "answer" },
    ),
    { value: "answer", type: "extension_ui_response", id: "input-1" },
  );
  harness.record(
    "extension-composition-gate",
    Classification.EXACT,
    "manifest hashes passed; unapproved files, hash drift, and any handler after the policy were rejected before spawn",
  );
}

async function qualifyAllowlistAndUnknownDefault(harness) {
  await writeFile(
    path.join(harness.workspace, "read-allowlisted.txt"),
    "read-only-ok",
    "utf8",
  );
  const read = await harness.startClient("approval-read-allowlisted");
  const readRecords = await harness.runPrompt(
    read.client,
    "[approval:read-allowlisted]",
  );
  assert.equal(
    readRecords.some((item) => item.type === "extension_ui_request"),
    false,
  );
  const readEnd = readRecords.find(
    (item) => item.type === "tool_execution_end",
  );
  assert.equal(readEnd.isError, false);
  assert.match(contentText(readEnd.result.content), /read-only-ok/);
  await harness.closeClient(read.client);

  const unknown = await harness.startClient("approval-unknown-reject", {
    extensionProfile: "unknown-tool-test",
    tools: "read,bash,write,edit,unknown_mutating",
  });
  const unknownRecords = await harness.runPrompt(
    unknown.client,
    "[approval:unknown-reject]",
  );
  assert.equal(
    unknownRecords.some((item) => item.type === "extension_ui_request"),
    false,
  );
  assert.equal(
    existsSync(path.join(harness.workspace, "approval-unknown-reject.txt")),
    false,
  );
  const unknownEnd = unknownRecords.find(
    (item) => item.type === "tool_execution_end",
  );
  assert.equal(unknownEnd.isError, true);
  assert.match(
    contentText(unknownEnd.result.content),
    /SCOPEGUARD_POLICY_BLOCKED:unknown_mutating:call-approval-unknown-reject/,
  );
  const unknownEntries = assertSuccess(
    await unknown.client.send({ type: "get_entries" }),
    "get_entries",
  ).entries;
  assert.match(
    contentText(
      persistedToolResult(unknownEntries, "call-approval-unknown-reject")
        .content,
    ),
    /SCOPEGUARD_POLICY_BLOCKED/,
  );
  await harness.closeClient(unknown.client);
  harness.record(
    "read-allowlist-and-unknown-default",
    Classification.EXACT,
    "read auto-allowed from an explicit allowlist; a registered unclassified mutating Tool was blocked and persisted without effect",
  );
}

export async function qualifyApprovalContracts(harness) {
  await qualifyCompositionGate(harness);
  await qualifyAllowlistAndUnknownDefault(harness);
}
