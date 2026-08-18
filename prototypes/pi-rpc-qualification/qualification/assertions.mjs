import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

export function assertSuccess(response, command) {
  assert.equal(response.type, "response");
  assert.equal(response.command, command);
  assert.equal(response.success, true, response.error);
  return response.data;
}

export function eventKey(record) {
  if (record.type !== "message_update") return record.type;
  return `message_update:${record.assistantMessageEvent?.type ?? "unknown"}`;
}

export function assertSubsequence(actual, expected) {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) index += 1;
  }
  assert.equal(
    index,
    expected.length,
    `missing ordered event ${expected[index]} in ${actual.join(", ")}`,
  );
}

export function contentText(content) {
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
    : "";
}

export function authoritativeToolCall(records, toolCallId) {
  const event = records.find(
    (item) =>
      item.type === "message_update" &&
      item.assistantMessageEvent?.type === "toolcall_end" &&
      (!toolCallId || item.assistantMessageEvent.toolCall?.id === toolCallId),
  );
  assert.ok(
    event?.assistantMessageEvent?.toolCall,
    `missing authoritative toolcall_end payload${toolCallId ? ` for ${toolCallId}` : ""}`,
  );
  return event.assistantMessageEvent.toolCall;
}

export function persistedToolResult(entries, toolCallId) {
  const entry = entries.find(
    (candidate) =>
      candidate.type === "message" &&
      candidate.message?.role === "toolResult" &&
      candidate.message?.toolCallId === toolCallId,
  );
  assert.ok(entry, `missing persisted toolResult for ${toolCallId}`);
  return entry.message;
}

export async function filesBelow(root) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) found.push(target);
    }
  }
  await visit(root);
  return found;
}
