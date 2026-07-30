import assert from "node:assert/strict";
import test from "node:test";

import { parseServerSentEvents } from "./sse.js";

test("parses SSE fields across arbitrary byte chunks", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: message\r\ndata: {\"a\":",
    "1}\r\nid: first\r\n\r\n:",
    " heartbeat\n\ndata: second line\ndata: continued\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseServerSentEvents(stream)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      event: "message",
      data: "{\"a\":1}",
      id: "first",
    },
    {
      event: null,
      data: "second line\ncontinued",
      id: null,
    },
  ]);
});

test("keeps a CRLF pair intact when it is split across byte chunks", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: message\r",
    "\ndata: first\r",
    "\ndata: second\r",
    "\n\r",
    "\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const events = [];
  for await (const event of parseServerSentEvents(stream)) {
    events.push(event);
  }

  assert.deepEqual(events, [{
    event: "message",
    data: "first\nsecond",
    id: null,
  }]);
});
