import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  assertSuccess,
  contentText,
  persistedToolResult,
} from "../qualification/assertions.mjs";
import { approvalCase } from "../qualification/approval-case.mjs";
import { Classification } from "../qualification/evidence.mjs";

export async function qualifyApprovalRuntime(harness) {
  const approved = await approvalCase(harness, {
    scenario: "approve",
    response: { confirmed: true },
    testInvalidResponses: true,
  });
  const unmarkedRejected = await approvalCase(harness, {
    scenario: "unmarked-bash-reject",
    response: { confirmed: false },
  });
  const rejected = await approvalCase(harness, {
    scenario: "reject",
    response: { confirmed: false },
  });
  const cancelled = await approvalCase(harness, {
    scenario: "cancel",
    response: { cancelled: true },
  });
  const timedOut = await approvalCase(harness, {
    scenario: "timeout",
    envOverrides: { SCOPEGUARD_QUALIFICATION_CONFIRM_TIMEOUT_MS: "150" },
  });
  await approvalCase(harness, {
    scenario: "write-reject",
    response: { confirmed: false },
  });
  await approvalCase(harness, {
    scenario: "edit-reject",
    response: { confirmed: false },
  });
  assert.equal(
    new Set([
      approved.binding.requestId,
      unmarkedRejected.binding.requestId,
      rejected.binding.requestId,
      cancelled.binding.requestId,
      timedOut.binding.requestId,
    ]).size,
    5,
  );
  harness.record(
    "default-fail-closed-approval-policy",
    Classification.EXACT,
    "all unmarked bash/write/edit calls required approval; reject, cancel, and timeout persisted correlated blocks with no effect",
  );
  harness.record(
    "strict-extension-response-union",
    Classification.EXACT,
    "forged id/type, mixed fields, invalid values, and extra fields threw before any wire write",
  );
  harness.record(
    "approval-argument-binding",
    Classification.EXACT,
    "host binding covered process, request ID, Tool call ID/name, canonical input, and SHA-256 through execution",
  );

  const concurrent = await Promise.all([
    approvalCase(harness, {
      scenario: "concurrent-approve",
      response: { confirmed: true },
    }),
    approvalCase(harness, {
      scenario: "concurrent-reject",
      response: { confirmed: false },
    }),
  ]);
  assert.notEqual(concurrent[0].binding.process, concurrent[1].binding.process);
  assert.notEqual(
    concurrent[0].binding.requestId,
    concurrent[1].binding.requestId,
  );
  assert.equal(
    existsSync(path.join(harness.workspace, "approval-concurrent-approve.txt")),
    true,
  );
  assert.equal(
    existsSync(path.join(harness.workspace, "approval-concurrent-reject.txt")),
    false,
  );
  harness.record(
    "multi-process-approval-correlation",
    Classification.EXACT,
    "two process-bound approval tuples used distinct request IDs and affected only their owning Conversation",
  );

  await approvalCase(harness, {
    scenario: "mutator",
    response: { confirmed: true },
    extensionProfile: "mutator-test",
    expectMutation: true,
  });
  harness.record(
    "final-handler-argument-binding",
    Classification.EXACT,
    "a declared pre-policy mutator changed args; the final policy hashed the changed input and only that changed command executed",
  );

  const extensionError = await harness.startClient("approval-extension-error", {
    envOverrides: {
      SCOPEGUARD_QUALIFICATION_THROW_TOOL_CALL_ID:
        "call-approval-extension-error",
    },
  });
  const extensionErrorRecords = await harness.runPrompt(
    extensionError.client,
    "[approval:extension-error]",
  );
  assert.equal(
    existsSync(path.join(harness.workspace, "approval-extension-error.txt")),
    false,
  );
  const extensionErrorEnd = extensionErrorRecords.find(
    (item) => item.type === "tool_execution_end",
  );
  assert.equal(extensionErrorEnd.isError, true);
  assert.match(
    contentText(extensionErrorEnd.result.content),
    /SCOPEGUARD_EXTENSION_ERROR/,
  );
  const extensionErrorEntries = assertSuccess(
    await extensionError.client.send({ type: "get_entries" }),
    "get_entries",
  ).entries;
  assert.match(
    contentText(
      persistedToolResult(
        extensionErrorEntries,
        "call-approval-extension-error",
      ).content,
    ),
    /SCOPEGUARD_EXTENSION_ERROR/,
  );
  await harness.closeClient(extensionError.client);
  harness.record(
    "extension-error-fail-closed",
    Classification.EXACT,
    "a thrown final policy handler persisted an error result and no Tool effect",
  );

  const disconnected = await harness.startClient("approval-host-disconnect");
  const disconnectedMark = disconnected.client.mark();
  assertSuccess(
    await disconnected.client.send({
      type: "prompt",
      message: "[approval:host-disconnect]",
    }),
    "prompt",
  );
  await disconnected.client.waitFor(
    (item) => item.type === "extension_ui_request" && item.method === "confirm",
    {
      after: disconnectedMark,
      description: "host disconnect approval request",
    },
  );
  const disconnectedExit = await harness.closeClient(disconnected.client);
  assert.equal(disconnectedExit.code, 0);
  assert.equal(
    existsSync(path.join(harness.workspace, "approval-host-disconnect.txt")),
    false,
  );
  harness.record(
    "approval-host-disconnect",
    Classification.EXACT,
    "closing the owning RPC process during pending confirmation did not execute the Tool effect",
  );
}
