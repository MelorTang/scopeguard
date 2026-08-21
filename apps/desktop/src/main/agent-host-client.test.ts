import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { UtilityProcess } from "electron";

import {
  AgentHostClient,
  boundedBackoffDelay,
} from "./agent-host-client.js";
import { isolatedChildEnvironment } from "./child-process-environment.js";

test("bounds Agent host restart delay", () => {
  assert.equal(boundedBackoffDelay(0, 100, 1_000), 100);
  assert.equal(boundedBackoffDelay(3, 100, 1_000), 800);
  assert.equal(boundedBackoffDelay(8, 100, 1_000), 1_000);
});

test("does not inherit Provider or cloud credentials", () => {
  assert.deepEqual(
    isolatedChildEnvironment({
      PATH: "/bin",
      HOME: "/home/user",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
    { PATH: "/bin", HOME: "/home/user" },
  );
});

test("kills an Agent host that misses its ready deadline", async () => {
  const child = new FakeUtilityProcess();
  const client = createClient(() => child, { readyTimeoutMs: 20 });
  await assert.rejects(client.start(), /did not become ready/);
  assert.equal(child.killed, true);
  await client.stop();
});

test("times out requests and ignores a late reply without poisoning the next request", async () => {
  const child = new FakeUtilityProcess();
  const client = createClient(() => child, { requestTimeoutMs: 20 });
  queueMicrotask(() => child.message({ type: "host-ready", interruptedRuns: 0 }));
  await client.start();

  const first = client.request("getWorkspaceSnapshot");
  const firstRequest = await waitForRequest(child);
  await assert.rejects(first, /timed out/);
  child.message({ type: "host-response", requestId: firstRequest.requestId, ok: true, result: "late" });

  const second = client.request<string>("getWorkspaceSnapshot");
  const secondRequest = await waitForRequest(child, 2);
  child.message({ type: "host-response", requestId: secondRequest.requestId, ok: true, result: "healthy" });
  assert.equal(await second, "healthy");
  await client.stop();
});

test("restarts after a crash and reports the replacement ready", async () => {
  const children: FakeUtilityProcess[] = [];
  let readyCount = 0;
  const client = createClient(() => {
    const child = new FakeUtilityProcess();
    children.push(child);
    queueMicrotask(() => child.message({ type: "host-ready", interruptedRuns: 0 }));
    return child;
  }, {
    restartBaseDelayMs: 10,
    restartMaxDelayMs: 10,
    onReady: () => { readyCount += 1; },
  });
  await client.start();
  children[0]!.exit(9);
  await waitUntil(() => children.length === 2 && readyCount === 2);
  assert.notEqual(children[0]!.pid, children[1]!.pid);
  await client.stop();
});

test("stop cancels a scheduled Agent host restart", async () => {
  const children: FakeUtilityProcess[] = [];
  const client = createClient(() => {
    const child = new FakeUtilityProcess();
    children.push(child);
    queueMicrotask(() => child.message({ type: "host-ready", interruptedRuns: 0 }));
    return child;
  }, { restartBaseDelayMs: 50, restartMaxDelayMs: 50 });
  await client.start();
  children[0]!.exit(9);
  await client.stop();
  await delay(80);
  assert.equal(children.length, 1);
});

test("uses graceful shutdown first and kills an unresponsive Agent host", async () => {
  const graceful = new FakeUtilityProcess();
  graceful.onPost = (message) => {
    if ((message as { type?: string }).type === "host-shutdown") queueMicrotask(() => graceful.exit(0));
  };
  const gracefulClient = createClient(() => graceful, { shutdownTimeoutMs: 20 });
  queueMicrotask(() => graceful.message({ type: "host-ready", interruptedRuns: 0 }));
  await gracefulClient.start();
  await gracefulClient.stop();
  assert.equal(graceful.killed, false);

  const forced = new FakeUtilityProcess();
  forced.autoExitOnShutdown = false;
  const forcedClient = createClient(() => forced, { shutdownTimeoutMs: 20 });
  queueMicrotask(() => forced.message({ type: "host-ready", interruptedRuns: 0 }));
  await forcedClient.start();
  await forcedClient.stop();
  assert.equal(forced.killed, true);
});

test("stop fails without clearing a live Agent host when forced termination is rejected", async () => {
  const child = new FakeUtilityProcess();
  child.autoExitOnShutdown = false;
  child.killResult = false;
  const client = createClient(() => child, { shutdownTimeoutMs: 10 });
  queueMicrotask(() => child.message({ type: "host-ready", interruptedRuns: 0 }));
  await client.start();

  await assert.rejects(client.stop(), /could not be terminated/i);
  assert.equal(client.processId, child.pid);

  child.killResult = true;
  await client.stop();
  assert.equal(client.processId, null);
});

test("stop fails when forced termination is accepted but no exit is observed", async () => {
  const child = new FakeUtilityProcess();
  child.autoExitOnShutdown = false;
  child.autoExitOnKill = false;
  const client = createClient(() => child, { shutdownTimeoutMs: 10 });
  queueMicrotask(() => child.message({ type: "host-ready", interruptedRuns: 0 }));
  await client.start();

  await assert.rejects(client.stop(), /did not exit after forced termination/i);
  assert.equal(client.processId, child.pid);
  child.exit(137);
});

let nextPid = 10_000;

class FakeUtilityProcess extends EventEmitter {
  readonly pid = nextPid++;
  readonly stderr = new PassThrough();
  readonly messages: unknown[] = [];
  killed = false;
  autoExitOnShutdown = true;
  autoExitOnKill = true;
  killResult = true;
  onPost: ((message: unknown) => void) | null = null;
  #exited = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onPost?.(message);
    if (
      this.autoExitOnShutdown &&
      (message as { type?: string }).type === "host-shutdown"
    ) queueMicrotask(() => this.exit(0));
  }

  kill(): boolean {
    if (this.killed || !this.killResult) return false;
    this.killed = true;
    if (this.autoExitOnKill) queueMicrotask(() => this.exit(137));
    return true;
  }

  message(message: unknown): void {
    this.emit("message", message);
  }

  exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    this.emit("exit", code);
  }
}

function createClient(
  fork: () => FakeUtilityProcess,
  options: Partial<{
    readyTimeoutMs: number;
    requestTimeoutMs: number;
    shutdownTimeoutMs: number;
    restartBaseDelayMs: number;
    restartMaxDelayMs: number;
    onReady: () => void;
  }> = {},
): AgentHostClient {
  return new AgentHostClient({
    modulePath: "/fixture/agent-host.js",
    databasePath: "/fixture/scopeguard.db",
    piSessionRoot: "/fixture/pi-sessions",
    vault: {} as never,
    fork: () => fork() as unknown as UtilityProcess,
    onRunEvent() {},
    ...options,
  });
}

async function waitForRequest(
  child: FakeUtilityProcess,
  count = 1,
): Promise<{ requestId: string }> {
  await waitUntil(() => child.messages.filter(isHostRequest).length >= count);
  return child.messages.filter(isHostRequest)[count - 1] as { requestId: string };
}

function isHostRequest(message: unknown): message is { type: "host-request"; requestId: string } {
  return Boolean(message && typeof message === "object" && (message as { type?: string }).type === "host-request");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Agent host fixture state.");
    await delay(5);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
