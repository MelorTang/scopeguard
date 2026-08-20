import assert from "node:assert/strict";
import test from "node:test";

import { LayoutPersistenceFence } from "./layout-persistence-fence.js";

test("Agent Host ready reload waits for pending layouts to reach SQLite", async () => {
  const events: string[] = [];
  let releaseFlush: (() => void) | undefined;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    flushAll: () => new Promise<void>((resolve) => {
      events.push("flush-started");
      releaseFlush = () => {
        events.push("flush-complete");
        resolve();
      };
    }),
    reportError: () => assert.fail("successful flush must not report an error"),
  });

  const reload = fence.run("Agent Host ready Renderer reload", () => {
    events.push("renderer-reloaded");
  });
  while (!releaseFlush) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(events, ["flush-started"]);
  releaseFlush?.();
  await reload;
  assert.deepEqual(events, ["flush-started", "flush-complete", "renderer-reloaded"]);
});

test("layout save failure blocks BrowserWindow close and remains diagnosable", async () => {
  const diagnostics: string[] = [];
  let closed = false;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    flushAll: async () => {
      throw new Error("SQLite disk unavailable");
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.run("BrowserWindow close", () => {
      closed = true;
    }),
    /BrowserWindow close.*SQLite disk unavailable/,
  );
  assert.equal(closed, false);
  assert.deepEqual(diagnostics, [
    "BrowserWindow close blocked because the latest Workspace layout could not be saved: SQLite disk unavailable",
  ]);
});

test("bounded app quit flush times out without stopping the Agent Host", async () => {
  const diagnostics: string[] = [];
  let hostStopped = false;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    flushAll: () => new Promise<void>(() => undefined),
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.run("app quit", () => {
      hostStopped = true;
    }),
    /timed out after 20ms/,
  );
  assert.equal(hostStopped, false);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /app quit blocked/);
  assert.match(diagnostics[0]!, /timed out after 20ms/);
});
