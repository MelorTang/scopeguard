import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeToolInput,
  hashCanonicalInput,
} from "../extensions/approval-policy.ts";
import {
  assertSuccess,
  authoritativeToolCall,
  contentText,
  persistedToolResult,
} from "./assertions.mjs";

function parseApprovalRequest(request) {
  assert.equal(request.type, "extension_ui_request");
  assert.equal(request.method, "confirm");
  assert.match(request.id, /^[0-9a-f-]{36}$/i);
  const payload = JSON.parse(request.message);
  assert.equal(payload.schemaVersion, 1);
  const canonicalInput = canonicalizeToolInput(payload.canonicalInput);
  assert.equal(
    payload.canonicalInputSha256,
    hashCanonicalInput(canonicalInput),
  );
  return { payload, canonicalInput };
}

async function assertEffectState(harness, scenario, expected) {
  if (scenario === "edit-reject") {
    assert.equal(
      await readFile(
        path.join(harness.workspace, "approval-edit-reject.txt"),
        "utf8",
      ),
      expected ? "must-not-replace" : "original",
    );
    return;
  }
  const target =
    scenario === "mutator"
      ? "approval-mutated.txt"
      : `approval-${scenario}.txt`;
  assert.equal(existsSync(path.join(harness.workspace, target)), expected);
}

function assertInvalidResponsesDoNotReachWire(client, request) {
  const invalid = [
    { id: "forged", confirmed: true },
    { type: "forged", confirmed: true },
    { confirmed: true, cancelled: true },
    { confirmed: true, value: "forged" },
    { confirmed: "yes" },
    { cancelled: false },
  ];
  const mark = client.wireMark();
  for (const response of invalid) {
    assert.throws(() => client.respondToExtension(request, response));
  }
  assert.deepEqual(client.wireRecordsAfter(mark), []);
}

export async function approvalCase(
  harness,
  {
    scenario,
    response,
    extensionProfile = "production",
    tools,
    envOverrides,
    expectMutation = false,
    testInvalidResponses = false,
  },
) {
  if (scenario === "edit-reject") {
    await writeFile(
      path.join(harness.workspace, "approval-edit-reject.txt"),
      "original",
      "utf8",
    );
  }
  const started = await harness.startClient(`approval-${scenario}`, {
    extensionProfile,
    tools,
    envOverrides,
  });
  const mark = started.client.mark();
  assertSuccess(
    await started.client.send({
      type: "prompt",
      message: `[approval:${scenario}]`,
    }),
    "prompt",
  );
  const request = await started.client.waitFor(
    (item) => item.type === "extension_ui_request" && item.method === "confirm",
    { after: mark, description: `${scenario} approval request` },
  );
  const { payload, canonicalInput } = parseApprovalRequest(request);
  assert.equal(payload.toolCallId, `call-approval-${scenario}`);
  assert.equal(
    payload.toolName,
    scenario.startsWith("write")
      ? "write"
      : scenario.startsWith("edit")
        ? "edit"
        : "bash",
  );
  if (payload.toolName === "bash") {
    assert.doesNotMatch(canonicalInput, /SCOPEGUARD_APPROVAL/);
  }
  await assertEffectState(harness, scenario, false);

  const currentRecords = started.client.records.slice(mark);
  const toolCall = authoritativeToolCall(currentRecords, payload.toolCallId);
  const toolStart = currentRecords.find(
    (item) =>
      item.type === "tool_execution_start" &&
      item.toolCallId === payload.toolCallId,
  );
  assert.ok(toolStart);
  assert.equal(toolCall.name, payload.toolName);
  assert.equal(toolStart.toolName, payload.toolName);
  if (expectMutation) {
    assert.notEqual(
      canonicalizeToolInput(toolCall.arguments),
      canonicalInput,
      "mutator fixture did not alter the model Tool input",
    );
    assert.match(canonicalInput, /approval-mutated\.txt/);
  } else {
    assert.equal(canonicalizeToolInput(toolCall.arguments), canonicalInput);
    assert.equal(canonicalizeToolInput(toolStart.args), canonicalInput);
  }

  if (testInvalidResponses) {
    assertInvalidResponsesDoNotReachWire(started.client, request);
  }
  if (response) {
    const sent = started.client.respondToExtension(request, response);
    assert.deepEqual(sent, {
      ...response,
      type: "extension_ui_response",
      id: request.id,
    });
  } else {
    assert.equal(request.timeout, 150);
  }

  await started.client.waitForSettled(mark, 20_000);
  const records = started.client.records.slice(mark);
  const toolEnd = records.find(
    (item) =>
      item.type === "tool_execution_end" &&
      item.toolCallId === payload.toolCallId,
  );
  assert.ok(toolEnd);
  const entries = assertSuccess(
    await started.client.send({ type: "get_entries" }),
    "get_entries",
  ).entries;
  const persisted = persistedToolResult(entries, payload.toolCallId);
  const approved = response?.confirmed === true;
  await assertEffectState(harness, scenario, approved);

  if (approved) {
    assert.equal(toolEnd.isError, false);
    assert.equal(persisted.isError, false);
    if (scenario === "mutator") {
      assert.equal(
        existsSync(path.join(harness.workspace, "approval-original.txt")),
        false,
      );
      assert.equal(
        await readFile(
          path.join(harness.workspace, "approval-mutated.txt"),
          "utf8",
        ),
        "mutated-executed",
      );
    }
  } else {
    assert.equal(toolEnd.isError, true);
    assert.equal(persisted.isError, true);
    const expectedReason = `SCOPEGUARD_APPROVAL_DENIED:${payload.toolName}:${payload.toolCallId}:${payload.canonicalInputSha256}`;
    assert.match(
      contentText(toolEnd.result.content),
      new RegExp(expectedReason),
    );
    assert.match(contentText(persisted.content), new RegExp(expectedReason));
  }

  await harness.closeClient(started.client);
  return {
    binding: {
      process: started.client.label,
      requestId: request.id,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      canonicalInputSha256: payload.canonicalInputSha256,
    },
    payload,
  };
}
