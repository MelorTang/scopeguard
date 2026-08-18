import assert from "node:assert/strict";
import {
  assertSubsequence,
  assertSuccess,
  authoritativeToolCall,
  contentText,
  eventKey,
  persistedToolResult,
} from "../qualification/assertions.mjs";
import { Classification } from "../qualification/evidence.mjs";

async function runApprovedPrompt(harness, client, message) {
  const mark = client.mark();
  assertSuccess(await client.send({ type: "prompt", message }), "prompt");
  const request = await client.waitFor(
    (item) => item.type === "extension_ui_request" && item.method === "confirm",
    { after: mark, description: "Tool approval" },
  );
  client.respondToExtension(request, { confirmed: true });
  await client.waitForSettled(mark);
  return client.records.slice(mark);
}

export async function qualifyStreamingAndTools(harness) {
  const stream = await harness.startClient("stream");
  const streamRecords = await harness.runPrompt(
    stream.client,
    "[stream] hello\u2028world",
  );
  const streamKeys = streamRecords
    .filter((item) => item.type !== "response")
    .map(eventKey);
  assertSubsequence(streamKeys, harness.contract.knownTextOrder);
  const streamedText = streamRecords
    .filter(
      (item) =>
        item.type === "message_update" &&
        item.assistantMessageEvent?.type === "text_delta",
    )
    .map((item) => item.assistantMessageEvent.delta)
    .join("");
  assert.equal(streamedText, "echo:[stream] hello\u2028world");
  await harness.closeClient(stream.client);
  harness.record(
    "streaming-text-order",
    Classification.EXACT,
    "strict LF JSONL preserved U+2028 and ordered start/delta/end/settled events",
  );

  for (const scenario of [
    { label: "tool-success", prompt: "[tool-success]", expectedError: false },
    { label: "tool-error", prompt: "[tool-error]", expectedError: true },
  ]) {
    const started = await harness.startClient(scenario.label);
    const providerRequestMark = harness.provider.requests.length;
    const toolRecords = scenario.expectedError
      ? await harness.runPrompt(started.client, scenario.prompt)
      : await runApprovedPrompt(harness, started.client, scenario.prompt);
    assertSubsequence(
      toolRecords.map(eventKey),
      harness.contract.knownToolCallOrder,
    );
    const toolStart = toolRecords.find(
      (item) => item.type === "tool_execution_start",
    );
    const toolEnd = toolRecords.find(
      (item) => item.type === "tool_execution_end",
    );
    const toolCall = authoritativeToolCall(toolRecords);
    assert.ok(toolStart);
    assert.ok(toolEnd);
    assert.equal(toolCall.id, toolStart.toolCallId);
    assert.equal(toolCall.name, toolStart.toolName);
    assert.deepEqual(toolCall.arguments, toolStart.args);
    assert.equal(toolEnd.toolCallId, toolStart.toolCallId);
    assert.equal(toolEnd.isError, scenario.expectedError);
    assert.ok(Array.isArray(toolEnd.result?.content));
    assert.match(
      contentText(toolEnd.result.content),
      scenario.expectedError
        ? /definitely-missing|ENOENT|not found/i
        : /tool-ok/,
    );
    const entries = assertSuccess(
      await started.client.send({ type: "get_entries" }),
      "get_entries",
    ).entries;
    const persisted = persistedToolResult(entries, toolStart.toolCallId);
    assert.equal(persisted.toolName, toolStart.toolName);
    assert.equal(persisted.isError, scenario.expectedError);
    assert.deepEqual(persisted.content, toolEnd.result.content);
    assert.equal(
      Object.hasOwn(persisted, "details"),
      Object.hasOwn(toolEnd.result, "details"),
    );
    assert.deepEqual(persisted.details, toolEnd.result.details);
    assert.match(
      contentText(persisted.content),
      scenario.expectedError
        ? /definitely-missing|ENOENT|not found/i
        : /tool-ok/,
    );
    assert.ok(
      harness.provider.requests
        .slice(providerRequestMark)
        .some((request) => request.toolMessageCount > 0),
    );
    await harness.closeClient(started.client);
    harness.record(
      scenario.label,
      Classification.EXACT,
      `${toolStart.toolName} correlated by ${toolStart.toolCallId}; result isError=${toolEnd.isError}`,
    );
  }
}
