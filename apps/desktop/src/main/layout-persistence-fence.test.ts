import assert from "node:assert/strict";
import test from "node:test";

import { WorkbenchLayoutPersistence } from "@scopeguard/application/workbench-layout-persistence";
import { WorkbenchLayoutStageCoordinator } from "@scopeguard/application/workbench-layout-stage-coordinator";
import type { WorkspaceLayout } from "@scopeguard/domain";

import { LayoutPersistenceFence } from "./layout-persistence-fence.js";

test("Agent Host ready reload waits for pending layouts to reach SQLite", async () => {
  const events: string[] = [];
  let releaseFlush: (() => void) | undefined;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    suspend: () => events.push("suspended"),
    resume: () => events.push("resumed"),
    flushAll: () => new Promise<void>((resolve) => {
      events.push("flush-started");
      releaseFlush = () => {
        events.push("flush-complete");
        resolve();
      };
    }),
    reportError: () => assert.fail("successful flush must not report an error"),
  });

  const reload = fence.runTransient("Agent Host ready Renderer reload", () => {
    events.push("renderer-reloaded");
  });
  while (!releaseFlush) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(events, ["suspended", "flush-started"]);
  releaseFlush?.();
  await reload;
  assert.deepEqual(events, [
    "suspended",
    "flush-started",
    "flush-complete",
    "renderer-reloaded",
    "resumed",
  ]);
});

test("layout save failure blocks BrowserWindow close and remains diagnosable", async () => {
  const diagnostics: string[] = [];
  let closed = false;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    suspend: () => undefined,
    resume: () => undefined,
    flushAll: async () => {
      throw new Error("SQLite disk unavailable");
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.runTransient("BrowserWindow close", () => {
      closed = true;
    }),
    /BrowserWindow close.*SQLite disk unavailable/,
  );
  assert.equal(closed, false);
  assert.deepEqual(diagnostics, [
    "BrowserWindow close blocked because the latest Workspace layout could not be saved: SQLite disk unavailable",
  ]);
});

for (const reason of [
  "BrowserWindow close",
  "Agent Host ready Renderer reload",
] as const) {
  test(`failed ${reason} retries the latest visible layout rejected during quiesce`, () =>
    assertFailedTransientRetriesLatestLayout(reason));
}

async function assertFailedTransientRetriesLatestLayout(reason: string): Promise<void> {
  const savedWidths: number[] = [];
  let rejectFirstSave: ((error: Error) => void) | undefined;
  let firstSaveStarted: (() => void) | undefined;
  const firstSaveInFlight = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(value) {
      if (value.paneWidths[0] === 440) {
        firstSaveStarted?.();
        await new Promise<never>((_resolve, reject) => {
          rejectFirstSave = reject;
        });
      }
      savedWidths.push(value.paneWidths[0]!);
      return value;
    },
  });
  const stage = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1,
    async stage(value) {
      if (persistence.isSchedulingSuspended) {
        return { accepted: false, reason: "quiescing" };
      }
      persistence.schedule(value);
      return { accepted: true };
    },
    onError: (error) => assert.fail(`Layout retry failed: ${String(error)}`),
  });
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    suspend: () => persistence.suspendScheduling(),
    resume: () => persistence.resumeScheduling(),
    flushAll: () => persistence.flushAll(),
    reportError: () => undefined,
  });

  persistence.schedule(layout(440));
  const lifecycle = fence.runTransient(reason, () => {
    assert.fail("failed flush must keep the Renderer open");
  });
  await firstSaveInFlight;

  const visibleWidth = 560;
  stage.submit(layout(visibleWidth));
  rejectFirstSave?.(new Error("SQLite busy"));
  await assert.rejects(() => lifecycle, /SQLite busy/);
  await stage.whenIdle();
  await persistence.flushAll();

  assert.equal(visibleWidth, 560);
  assert.deepEqual(savedWidths, [560]);
  stage.dispose();
}

test("bounded app quit flush times out without stopping the Agent Host", async () => {
  const diagnostics: string[] = [];
  let suspended = false;
  let attempts = 0;
  let hostStopped = false;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    suspend: () => {
      suspended = true;
    },
    resume: () => {
      suspended = false;
    },
    flushAll: () => {
      attempts += 1;
      return attempts === 1
        ? new Promise<void>(() => undefined)
        : Promise.resolve();
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.runShutdown(
      "app quit",
      () => assert.fail("timed-out flush must not destroy the Renderer"),
      () => {
        hostStopped = true;
      },
    ),
    /timed out after 20ms/,
  );
  assert.equal(hostStopped, false);
  assert.equal(suspended, false);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /app quit blocked/);
  assert.match(diagnostics[0]!, /timed out after 20ms/);

  await fence.runShutdown(
    "app quit retry",
    () => undefined,
    () => {
      hostStopped = true;
    },
  );
  assert.equal(hostStopped, true);
  assert.equal(suspended, true);
});

test("app quit rejects a layout revision staged while Agent Host stop is delayed", async () => {
  const savedWidths: number[] = [];
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(layout) {
      savedWidths.push(layout.paneWidths[0]!);
      return layout;
    },
  });
  const events: string[] = [];
  let releaseHostStop: (() => void) | undefined;
  let hostStopStarted: (() => void) | undefined;
  const stopping = new Promise<void>((resolve) => {
    hostStopStarted = resolve;
  });
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    suspend: () => {
      persistence.suspendScheduling();
      events.push("suspended");
    },
    resume: () => persistence.resumeScheduling(),
    flushAll: () => persistence.flushAll(),
    reportError: () => assert.fail("successful shutdown must not report an error"),
  });

  persistence.schedule(layout(440));
  const shutdown = fence.runShutdown("app quit", () => {
    events.push("renderer-destroyed");
  }, async () => {
    hostStopStarted?.();
    events.push("host-stop-started");
    await new Promise<void>((resolve) => {
      releaseHostStop = resolve;
    });
    events.push("host-stop-complete");
  });
  await stopping;

  assert.deepEqual(savedWidths, [440]);
  assert.throws(() => persistence.schedule(layout(560)), /quiescing/i);
  assert.equal(persistence.pendingWorkspaceCount, 0);
  releaseHostStop?.();
  await shutdown;
  assert.deepEqual(events, [
    "suspended",
    "renderer-destroyed",
    "host-stop-started",
    "host-stop-complete",
  ]);
});

test("failed shutdown resumes layout scheduling and a later retry drains the latest revision", async () => {
  let suspended = false;
  let attempts = 0;
  const events: string[] = [];
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    suspend: () => {
      suspended = true;
      events.push("suspended");
    },
    resume: () => {
      suspended = false;
      events.push("resumed");
    },
    flushAll: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("SQLite busy");
      events.push("flushed-latest");
    },
    reportError: (message) => events.push(message),
  });

  await assert.rejects(() => fence.runShutdown(
    "app quit",
    () => assert.fail("failed flush must not destroy the Renderer"),
    () => assert.fail("failed flush must not stop the Agent Host"),
  ), /SQLite busy/);
  assert.equal(suspended, false);

  await fence.runShutdown(
    "app quit retry",
    () => {
      events.push("renderer-destroyed");
    },
    () => {
      events.push("shutdown-complete");
    },
  );
  assert.equal(suspended, true);
  assert.deepEqual(events, [
    "suspended",
    "app quit blocked because the latest Workspace layout could not be saved: SQLite busy",
    "resumed",
    "suspended",
    "flushed-latest",
    "renderer-destroyed",
    "shutdown-complete",
  ]);
});

test("concurrent reload close and quit serialize without duplicate terminal shutdown", async () => {
  const events: string[] = [];
  let releaseReload: (() => void) | undefined;
  let reloadStarted: (() => void) | undefined;
  const reloading = new Promise<void>((resolve) => {
    reloadStarted = resolve;
  });
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    suspend: () => events.push("suspended"),
    resume: () => events.push("resumed"),
    flushAll: async () => {
      events.push("flushed");
    },
    reportError: () => assert.fail("successful lifecycle must not report an error"),
  });

  const reload = fence.runTransient("reload", async () => {
    events.push("reload-started");
    reloadStarted?.();
    await new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    events.push("reload-complete");
  });
  await reloading;
  const close = fence.runTransient("close", () => {
    events.push("close-complete");
  });
  const quit = fence.runShutdown(
    "quit",
    () => {
      events.push("quit-renderer-destroyed");
    },
    () => {
      events.push("quit-complete");
    },
  );
  const duplicateQuit = fence.runShutdown(
    "duplicate quit",
    () => assert.fail("duplicate quit destroy must not execute"),
    () => assert.fail("duplicate quit stop must not execute"),
  );
  assert.strictEqual(duplicateQuit, quit);
  await assert.rejects(
    () => fence.runTransient("late reload", () => undefined),
    /shutdown is already in progress/i,
  );
  releaseReload?.();
  await Promise.all([reload, close, quit]);

  assert.equal(events.filter((event) => event === "quit-complete").length, 1);
  assert.deepEqual(events, [
    "suspended", "flushed", "reload-started", "reload-complete", "resumed",
    "suspended", "flushed", "close-complete", "resumed",
    "suspended", "flushed", "quit-renderer-destroyed", "quit-complete",
  ]);
});

function layout(width: number): WorkspaceLayout {
  return {
    workspaceId: "workspace",
    openConversationIds: ["conversation"],
    paneConversationIds: ["conversation"],
    paneWidths: [width],
    activeConversationId: "conversation",
    requestedPaneCount: 1,
  };
}
