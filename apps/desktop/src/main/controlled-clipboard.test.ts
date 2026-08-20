import assert from "node:assert/strict";
import test from "node:test";

import { writeControlledClipboard } from "./controlled-clipboard.js";

test("writes exact bounded text only after the sender is trusted", () => {
  const calls: string[] = [];
  const event = { sender: "renderer" };
  writeControlledClipboard(event, "# Handoff Prompt\n\nReview.", {
    assertTrustedSender(value) {
      assert.equal(value, event);
      calls.push("trusted");
    },
    writeText(text) {
      calls.push(text);
    },
  });
  assert.deepEqual(calls, ["trusted", "# Handoff Prompt\n\nReview."]);
});

test("does not write when sender trust or clipboard input validation fails", () => {
  let writes = 0;
  assert.throws(() => writeControlledClipboard({}, "secret", {
    assertTrustedSender() { throw new Error("untrusted renderer"); },
    writeText() { writes += 1; },
  }), /untrusted renderer/);
  assert.throws(() => writeControlledClipboard({}, { text: "wrong shape" }, {
    assertTrustedSender() {},
    writeText() { writes += 1; },
  }), /string/i);
  assert.equal(writes, 0);
});
