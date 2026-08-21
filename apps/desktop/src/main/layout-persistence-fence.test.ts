import assert from "node:assert/strict";
import test from "node:test";

import { WorkbenchLayoutPersistence } from "@scopeguard/application/workbench-layout-persistence";
import { WorkbenchLayoutStageCoordinator } from "@scopeguard/application/workbench-layout-stage-coordinator";
import type { WorkspaceLayout } from "@scopeguard/domain";

import { LayoutPersistenceFence } from "./layout-persistence-fence.js";

const NOOP_RENDERER_LIFECYCLE = {
  drainRenderer: async () => undefined,
  resumeRenderer: async () => undefined,
};

test("Agent Host ready reload waits for pending layouts to reach SQLite", async () => {
  const events: string[] = [];
  let releaseFlush: (() => void) | undefined;
  const fence = new LayoutPersistenceFence({
    ...NOOP_RENDERER_LIFECYCLE,
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

  const reload = fence.runTransient(
    "Agent Host ready Renderer reload",
    commitAction(() => events.push("renderer-reloaded")),
  );
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

for (const reason of [
  "Agent Host ready Renderer reload",
  "BrowserWindow close",
] as const) {
  test(`successful ${reason} drains the latest Renderer revision before destruction`, () =>
    assertSuccessfulTransientDrainsLatestLayout(reason));
}

async function assertSuccessfulTransientDrainsLatestLayout(
  reason: string,
): Promise<void> {
  const savedWidths: number[] = [];
  const events: string[] = [];
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(value) {
      savedWidths.push(value.paneWidths[0]!);
      return value;
    },
  });
  const stageAttempts: number[] = [];
  const stage = new WorkbenchLayoutStageCoordinator({
    retryDelayMs: 1_000,
    async stage(value) {
      stageAttempts.push(value.paneWidths[0]!);
      if (persistence.isSchedulingSuspended) {
        return { accepted: false, reason: "quiescing" };
      }
      persistence.schedule(value);
      events.push(`main-accepted-${value.paneWidths[0]}`);
      return { accepted: true };
    },
  });
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    drainRenderer: async () => {
      events.push("renderer-drain-started");
      await stage.quiesceAndDrain("successful-transient-drain");
      events.push("renderer-drained");
    },
    resumeRenderer: async () => stage.resumeSubmissions(),
    suspend: () => {
      persistence.suspendScheduling();
      events.push("main-suspended");
    },
    resume: () => {
      persistence.resumeScheduling();
      events.push("main-resumed");
    },
    flushAll: async () => {
      await persistence.flushAll();
      events.push("sqlite-flushed");
    },
    reportError: () => assert.fail("successful lifecycle must not report an error"),
  });

  persistence.schedule(layout(440));
  persistence.suspendScheduling();
  const latestVisible = stage.submit(layout(560));
  await waitFor(() => stageAttempts.length === 1);
  persistence.resumeScheduling();

  await fence.runTransient(reason, commitAction(() => {
    events.push("renderer-destroyed");
    stage.dispose();
  }));
  await latestVisible;

  assert.deepEqual(savedWidths, [560]);
  assert.deepEqual(events, [
    "renderer-drain-started",
    "main-accepted-560",
    "renderer-drained",
    "main-suspended",
    "sqlite-flushed",
    "renderer-destroyed",
    "main-resumed",
  ]);
}

test("layout save failure blocks BrowserWindow close and remains diagnosable", async () => {
  const diagnostics: string[] = [];
  let closed = false;
  let mainSuspended = false;
  let rendererAccepting = true;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    drainRenderer: async () => {
      rendererAccepting = false;
    },
    resumeRenderer: async () => {
      rendererAccepting = true;
    },
    suspend: () => {
      mainSuspended = true;
    },
    resume: () => {
      mainSuspended = false;
    },
    flushAll: async () => {
      throw new Error("SQLite disk unavailable");
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.runTransient("BrowserWindow close", commitAction(() => {
      closed = true;
    })),
    /BrowserWindow close.*SQLite disk unavailable/,
  );
  assert.equal(closed, false);
  assert.equal(mainSuspended, false);
  assert.equal(rendererAccepting, true);
  assert.deepEqual(diagnostics, [
    "BrowserWindow close blocked because the latest Workspace layout could not be saved: SQLite disk unavailable",
  ]);
});

test("destructive transient action failure restores Main and Renderer scheduling", async () => {
  const events: string[] = [];
  const diagnostics: string[] = [];
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    drainRenderer: async () => {
      events.push("renderer-drained");
    },
    resumeRenderer: async () => {
      events.push("renderer-resumed");
    },
    suspend: () => events.push("main-suspended"),
    resume: () => events.push("main-resumed"),
    flushAll: async () => {
      events.push("sqlite-flushed");
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.runTransient("Agent Host ready Renderer reload", commitAction(() => {
      events.push("reload-started");
      throw new Error("reload failed");
    })),
    /Agent Host ready Renderer reload.*reload failed/,
  );
  assert.deepEqual(events, [
    "renderer-drained",
    "main-suspended",
    "sqlite-flushed",
    "reload-started",
    "main-resumed",
    "renderer-resumed",
  ]);
  assert.deepEqual(diagnostics, [
    "Agent Host ready Renderer reload blocked because the destructive lifecycle action failed: reload failed",
  ]);
});

test("destructive transient action timeout restores Main and Renderer scheduling", async () => {
  const events: string[] = [];
  const diagnostics: string[] = [];
  let mainSuspended = false;
  let rendererAccepting = true;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    drainRenderer: async () => {
      rendererAccepting = false;
      events.push("renderer-drained");
    },
    resumeRenderer: async () => {
      rendererAccepting = true;
      events.push("renderer-resumed");
    },
    suspend: () => {
      mainSuspended = true;
      events.push("main-suspended");
    },
    resume: () => {
      mainSuspended = false;
      events.push("main-resumed");
    },
    flushAll: async () => {
      events.push("sqlite-flushed");
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => withTestTimeout(
      fence.runTransient(
        "BrowserWindow close",
        () => new Promise<() => void>(() => {
          events.push("close-started");
        }),
      ),
      80,
    ),
    /BrowserWindow close.*Destructive lifecycle action timed out after 20ms/,
  );
  assert.equal(mainSuspended, false);
  assert.equal(rendererAccepting, true);
  assert.deepEqual(events, [
    "renderer-drained",
    "main-suspended",
    "sqlite-flushed",
    "close-started",
    "main-resumed",
    "renderer-resumed",
  ]);
  assert.deepEqual(diagnostics, [
    "BrowserWindow close blocked because the destructive lifecycle action failed: Destructive lifecycle action timed out after 20ms.",
  ]);
});

test("a destructive commit that becomes ready after timeout can never take effect", async () => {
  let destructiveEffect = false;
  let actionTimer: ReturnType<typeof setTimeout> | null = null;
  let abortListenerRemoved = false;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    drainRenderer: async () => undefined,
    resumeRenderer: async () => undefined,
    suspend: () => undefined,
    resume: () => undefined,
    flushAll: async () => undefined,
    reportError: () => undefined,
  });

  await assert.rejects(
    () => fence.runTransient("BrowserWindow close", (signal) =>
      new Promise<() => void>((resolve) => {
        const onAbort = (): void => {
          if (actionTimer) clearTimeout(actionTimer);
          signal.removeEventListener("abort", onAbort);
          abortListenerRemoved = true;
          setTimeout(() => resolve(() => {
            destructiveEffect = true;
          }), 20);
        };
        signal.addEventListener("abort", onAbort);
        actionTimer = setTimeout(() => resolve(() => {
          destructiveEffect = true;
        }), 40);
      })),
    /Destructive lifecycle action timed out after 20ms/,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 60));

  assert.equal(destructiveEffect, false);
  assert.equal(abortListenerRemoved, true);
});

test("app quit timeout never destroys Renderer after scheduling recovery", async () => {
  let mainSuspended = false;
  let rendererAccepting = true;
  let rendererDestroyed = false;
  let latePreparationTimer: ReturnType<typeof setTimeout> | null = null;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    drainRenderer: async () => {
      rendererAccepting = false;
    },
    resumeRenderer: async () => {
      rendererAccepting = true;
    },
    suspend: () => {
      mainSuspended = true;
    },
    resume: () => {
      mainSuspended = false;
    },
    flushAll: async () => undefined,
    reportError: () => undefined,
  });

  await assert.rejects(
    () => fence.runShutdown(
      "app quit",
      (signal) => new Promise<void>((resolve) => {
        const onAbort = (): void => {
          if (latePreparationTimer) clearTimeout(latePreparationTimer);
          signal.removeEventListener("abort", onAbort);
          setTimeout(resolve, 20);
        };
        signal.addEventListener("abort", onAbort);
        latePreparationTimer = setTimeout(resolve, 40);
      }),
      () => {
        rendererDestroyed = true;
      },
    ),
    /Destructive lifecycle action timed out after 20ms/,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 60));

  assert.equal(rendererDestroyed, false);
  assert.equal(mainSuspended, false);
  assert.equal(rendererAccepting, true);
});

test("app quit preparation failure keeps Renderer alive and restores scheduling", async () => {
  let mainSuspended = false;
  let rendererAccepting = true;
  let rendererDestroyed = false;
  const diagnostics: string[] = [];
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    drainRenderer: async () => {
      rendererAccepting = false;
    },
    resumeRenderer: async () => {
      rendererAccepting = true;
    },
    suspend: () => {
      mainSuspended = true;
    },
    resume: () => {
      mainSuspended = false;
    },
    flushAll: async () => undefined,
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(
    () => fence.runShutdown(
      "app quit",
      () => {
        throw new Error("Agent Host stop failed");
      },
      () => {
        rendererDestroyed = true;
      },
    ),
    /app quit.*Agent Host stop failed/,
  );

  assert.equal(rendererDestroyed, false);
  assert.equal(mainSuspended, false);
  assert.equal(rendererAccepting, true);
  assert.deepEqual(diagnostics, [
    "app quit blocked because the destructive lifecycle action failed: Agent Host stop failed",
  ]);
});

test("Renderer drain acknowledgement timeout blocks destructive transient", async () => {
  const events: string[] = [];
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    drainRenderer: async () => {
      events.push("renderer-drain-started");
      await new Promise<void>(() => undefined);
    },
    resumeRenderer: async () => {
      events.push("renderer-resumed");
    },
    suspend: () => assert.fail("Main must not suspend without a Renderer drain ack"),
    resume: () => assert.fail("Main was never suspended"),
    flushAll: async () => assert.fail("SQLite must not flush without a Renderer drain ack"),
    reportError: (message) => events.push(message),
  });

  await assert.rejects(
    () => fence.runTransient(
      "BrowserWindow close",
      () => assert.fail("close must not run without a Renderer drain ack"),
    ),
    /Renderer layout drain timed out after 20ms/,
  );
  assert.deepEqual(events, [
    "renderer-drain-started",
    "BrowserWindow close blocked because the latest Renderer layout could not be staged: Renderer layout drain timed out after 20ms.",
    "renderer-resumed",
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
    ...NOOP_RENDERER_LIFECYCLE,
    timeoutMs: 100,
    suspend: () => persistence.suspendScheduling(),
    resume: () => persistence.resumeScheduling(),
    flushAll: () => persistence.flushAll(),
    reportError: () => undefined,
  });

  persistence.schedule(layout(440));
  const lifecycle = fence.runTransient(reason, commitAction(() => {
    assert.fail("failed flush must keep the Renderer open");
  }));
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
    ...NOOP_RENDERER_LIFECYCLE,
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
      () => {
        hostStopped = true;
      },
      () => assert.fail("timed-out flush must not destroy the Renderer"),
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
    () => {
      hostStopped = true;
    },
    () => undefined,
  );
  assert.equal(hostStopped, true);
  assert.equal(suspended, true);
});

test("Renderer drain acknowledgement timeout blocks app quit and restores both schedulers", async () => {
  const events: string[] = [];
  let mainSuspended = false;
  let rendererAccepting = true;
  let drainAttempts = 0;
  const fence = new LayoutPersistenceFence({
    timeoutMs: 20,
    drainRenderer: async () => {
      drainAttempts += 1;
      rendererAccepting = false;
      if (drainAttempts === 1) await new Promise<void>(() => undefined);
      events.push("renderer-drained");
    },
    resumeRenderer: async () => {
      rendererAccepting = true;
      events.push("renderer-resumed");
    },
    suspend: () => {
      mainSuspended = true;
      events.push("main-suspended");
    },
    resume: () => {
      mainSuspended = false;
      events.push("main-resumed");
    },
    flushAll: async () => {
      events.push("flushed");
    },
    reportError: (message) => events.push(message),
  });

  await assert.rejects(() => fence.runShutdown(
    "app quit",
    () => assert.fail("drain timeout must not stop the Agent Host"),
    () => assert.fail("drain timeout must not destroy the Renderer"),
  ), /Renderer layout drain timed out after 20ms/);
  assert.equal(mainSuspended, false);
  assert.equal(rendererAccepting, true);
  assert.deepEqual(events, [
    "app quit blocked because the latest Renderer layout could not be staged: Renderer layout drain timed out after 20ms.",
    "renderer-resumed",
  ]);

  await fence.runShutdown(
    "app quit retry",
    () => {
      events.push("host-stopped");
    },
    () => {
      events.push("renderer-destroyed");
    },
  );
  assert.equal(mainSuspended, true);
  assert.equal(rendererAccepting, false);
  assert.deepEqual(events.slice(-5), [
    "renderer-drained",
    "main-suspended",
    "flushed",
    "host-stopped",
    "renderer-destroyed",
  ]);
});

test("shutdown recovery attempts Renderer resume even when Main resume fails", async () => {
  let rendererResumed = false;
  const diagnostics: string[] = [];
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    drainRenderer: async () => undefined,
    resumeRenderer: async () => {
      rendererResumed = true;
    },
    suspend: () => undefined,
    resume: () => {
      throw new Error("Main scheduler recovery failed");
    },
    flushAll: async () => {
      throw new Error("SQLite busy");
    },
    reportError: (message) => diagnostics.push(message),
  });

  await assert.rejects(() => fence.runShutdown(
    "app quit",
    () => assert.fail("failed flush must not stop the Agent Host"),
    () => assert.fail("failed flush must not destroy the Renderer"),
  ), /SQLite busy.*Main scheduler recovery failed/);
  assert.equal(rendererResumed, true);
  assert.match(diagnostics.at(-1) ?? "", /Layout scheduling recovery failed/);
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
    ...NOOP_RENDERER_LIFECYCLE,
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
  const shutdown = fence.runShutdown("app quit", async () => {
    hostStopStarted?.();
    events.push("host-stop-started");
    await new Promise<void>((resolve) => {
      releaseHostStop = resolve;
    });
    events.push("host-stop-complete");
  }, () => {
    events.push("renderer-destroyed");
  });
  await stopping;

  assert.deepEqual(savedWidths, [440]);
  assert.throws(() => persistence.schedule(layout(560)), /quiescing/i);
  assert.equal(persistence.pendingWorkspaceCount, 0);
  releaseHostStop?.();
  await shutdown;
  assert.deepEqual(events, [
    "suspended",
    "host-stop-started",
    "host-stop-complete",
    "renderer-destroyed",
  ]);
});

test("failed shutdown resumes layout scheduling and a later retry drains the latest revision", async () => {
  let suspended = false;
  let attempts = 0;
  const events: string[] = [];
  const fence = new LayoutPersistenceFence({
    timeoutMs: 100,
    drainRenderer: async () => {
      events.push("renderer-drained");
    },
    resumeRenderer: async () => {
      events.push("renderer-resumed");
    },
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
    () => assert.fail("failed flush must not stop the Agent Host"),
    () => assert.fail("failed flush must not destroy the Renderer"),
  ), /SQLite busy/);
  assert.equal(suspended, false);

  await fence.runShutdown(
    "app quit retry",
    () => {
      events.push("shutdown-complete");
    },
    () => {
      events.push("renderer-destroyed");
    },
  );
  assert.equal(suspended, true);
  assert.deepEqual(events, [
    "renderer-drained",
    "suspended",
    "app quit blocked because the latest Workspace layout could not be saved: SQLite busy",
    "resumed",
    "renderer-resumed",
    "renderer-drained",
    "suspended",
    "flushed-latest",
    "shutdown-complete",
    "renderer-destroyed",
  ]);
});

test("app quit drains a Renderer revision rejected during transient quiesce before Main suspension", async () => {
  const savedWidths: number[] = [];
  const events: string[] = [];
  let firstSave = true;
  let rejectFirstSave: ((error: Error) => void) | undefined;
  let firstSaveStarted: (() => void) | undefined;
  const firstSaveInFlight = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const persistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    async save(value) {
      if (value.paneWidths[0] === 440 && firstSave) {
        firstSave = false;
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
    retryDelayMs: 50,
    async stage(value) {
      if (persistence.isSchedulingSuspended) {
        return { accepted: false, reason: "quiescing" };
      }
      persistence.schedule(value);
      return { accepted: true };
    },
  });
  const fenceOptions = {
    timeoutMs: 100,
    drainRenderer: async () => {
      await stage.quiesceAndDrain("terminal-drain");
      events.push("renderer-drained");
    },
    resumeRenderer: async () => stage.resumeSubmissions(),
    suspend: () => {
      persistence.suspendScheduling();
      events.push("main-suspended");
    },
    resume: () => persistence.resumeScheduling(),
    flushAll: () => persistence.flushAll(),
    reportError: () => undefined,
  };
  const fence = new LayoutPersistenceFence(fenceOptions);

  persistence.schedule(layout(440));
  persistence.suspendScheduling();
  events.push("main-suspended");
  const transient = persistence.flushAll();
  await firstSaveInFlight;

  const latestVisible = stage.submit(layout(560));
  rejectFirstSave?.(new Error("SQLite busy"));
  await assert.rejects(() => transient, /SQLite busy/);
  persistence.resumeScheduling();

  await fence.runShutdown(
    "app quit",
    () => {
      events.push("host-stopped");
    },
    () => {
      events.push("renderer-destroyed");
    },
  );
  stage.dispose();
  await latestVisible;

  assert.deepEqual(savedWidths, [560]);
  assert.deepEqual(events, [
    "main-suspended",
    "renderer-drained",
    "main-suspended",
    "host-stopped",
    "renderer-destroyed",
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
    drainRenderer: async () => {
      events.push("renderer-drained");
    },
    resumeRenderer: async () => {
      events.push("renderer-resumed");
    },
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
    return () => {
      events.push("reload-complete");
    };
  });
  await reloading;
  const close = fence.runTransient("close", commitAction(() => {
    events.push("close-complete");
  }));
  const quit = fence.runShutdown(
    "quit",
    () => {
      events.push("quit-complete");
    },
    () => {
      events.push("quit-renderer-destroyed");
    },
  );
  const duplicateQuit = fence.runShutdown(
    "duplicate quit",
    () => assert.fail("duplicate quit stop must not execute"),
    () => assert.fail("duplicate quit destroy must not execute"),
  );
  assert.strictEqual(duplicateQuit, quit);
  await assert.rejects(
    () => fence.runTransient("late reload", commitAction(() => undefined)),
    /shutdown is already in progress/i,
  );
  releaseReload?.();
  await Promise.all([reload, close, quit]);

  assert.equal(events.filter((event) => event === "quit-complete").length, 1);
  assert.deepEqual(events, [
    "renderer-drained", "suspended", "flushed", "reload-started", "reload-complete",
    "resumed",
    "renderer-drained", "suspended", "flushed", "close-complete", "resumed",
    "renderer-drained", "suspended", "flushed", "quit-complete", "quit-renderer-destroyed",
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

function commitAction(commit: () => void): () => () => void {
  return () => commit;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Layout fence test timed out.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function withTestTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Test guard timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
