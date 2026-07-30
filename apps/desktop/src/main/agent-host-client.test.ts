import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { UtilityProcess } from "electron";
import type { AgentHostRequest } from "@scopeguard/ipc-contracts";

import {
  AgentHostClient,
  agentHostEnvironment,
  boundedBackoffDelay,
} from "./agent-host-client.js";
import { EncryptedSecretVault } from "./encrypted-secret-vault.js";

test("bounds exponential restart delay", () => {
  assert.equal(boundedBackoffDelay(0, 100, 1_000), 100);
  assert.equal(boundedBackoffDelay(3, 100, 1_000), 800);
  assert.equal(boundedBackoffDelay(8, 100, 1_000), 1_000);
});

test("does not pass provider or cloud credentials into the Agent host", () => {
  assert.deepEqual(
    agentHostEnvironment({
      PATH: "/bin",
      HOME: "/home/user",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
    {
      PATH: "/bin",
      HOME: "/home/user",
    },
  );
});

test("times out readiness and kills the unresponsive host", async () => {
  const fixture = await createClientFixture({
    readyTimeoutMs: 10,
    restartBaseDelayMs: 1_000,
  });
  try {
    await assert.rejects(fixture.client.start(), /did not become ready/);
    assert.equal(fixture.children[0]?.killed, true);
  } finally {
    await fixture.client.stop();
    await fixture.cleanup();
  }
});

test("times out unanswered requests and ignores late responses", async () => {
  const fixture = await createClientFixture({
    requestTimeoutMs: 10,
  });
  try {
    const starting = fixture.client.start();
    fixture.children[0]?.emit("message", {
      type: "host-ready",
      interruptedRuns: 0,
    });
    await starting;

    await assert.rejects(
      fixture.client.request("getWorkspaceSnapshot"),
      /timed out/,
    );
    const request = fixture.children[0]?.messages[0] as AgentHostRequest;
    fixture.children[0]?.emit("message", {
      type: "host-response",
      requestId: request.requestId,
      ok: true,
      result: {},
    });
  } finally {
    await fixture.client.stop();
    await fixture.cleanup();
  }
});

test("restarts with a bounded timer, reports ready again, and stop cancels restart", async () => {
  let readyCount = 0;
  const fixture = await createClientFixture({
    restartBaseDelayMs: 5,
    restartMaxDelayMs: 10,
    onReady: () => {
      readyCount += 1;
    },
  });
  try {
    const starting = fixture.client.start();
    fixture.children[0]?.emit("message", {
      type: "host-ready",
      interruptedRuns: 0,
    });
    await starting;
    assert.equal(readyCount, 1);

    fixture.children[0]?.emit("exit", 1);
    await waitFor(() => fixture.children.length === 2);
    fixture.children[1]?.emit("message", {
      type: "host-ready",
      interruptedRuns: 1,
    });
    await waitFor(() => readyCount === 2);

    fixture.children[1]?.emit("exit", 1);
    await fixture.client.stop();
    await sleep(20);
    assert.equal(fixture.children.length, 2);
  } finally {
    await fixture.client.stop();
    await fixture.cleanup();
  }
});

test("asks the Agent host to shut down before forcing termination", async () => {
  const fixture = await createClientFixture();
  try {
    const starting = fixture.client.start();
    const child = fixture.children[0]!;
    child.emit("message", {
      type: "host-ready",
      interruptedRuns: 0,
    });
    await starting;

    await fixture.client.stop();

    assert.deepEqual(child.messages, [{ type: "host-shutdown" }]);
    assert.equal(child.killed, false);
  } finally {
    await fixture.client.stop();
    await fixture.cleanup();
  }
});

test("forces termination when the Agent host does not shut down in time", async () => {
  const fixture = await createClientFixture({
    autoExitOnShutdown: false,
    shutdownTimeoutMs: 10,
  });
  try {
    const starting = fixture.client.start();
    const child = fixture.children[0]!;
    child.emit("message", {
      type: "host-ready",
      interruptedRuns: 0,
    });
    await starting;

    await fixture.client.stop();

    assert.deepEqual(child.messages, [{ type: "host-shutdown" }]);
    assert.equal(child.killed, true);
  } finally {
    await fixture.client.stop();
    await fixture.cleanup();
  }
});

class MockUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = [];
  readonly stderr = null;
  killed = false;

  constructor(readonly autoExitOnShutdown: boolean) {
    super();
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (
      this.autoExitOnShutdown &&
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "host-shutdown"
    ) {
      queueMicrotask(() => this.emit("exit", 0));
    }
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

async function createClientFixture(options: {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  shutdownTimeoutMs?: number;
  autoExitOnShutdown?: boolean;
  onReady?: () => void;
} = {}): Promise<{
  children: MockUtilityProcess[];
  client: AgentHostClient;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-host-"));
  const children: MockUtilityProcess[] = [];
  const vault = new EncryptedSecretVault(join(directory, "secrets.json"), {
    safeStorage: {
      decryptString: (encrypted) => encrypted.toString("utf8"),
      encryptString: (value) => Buffer.from(value, "utf8"),
      getSelectedStorageBackend: () => "gnome_libsecret",
      isEncryptionAvailable: () => true,
    },
  });
  const client = new AgentHostClient({
    modulePath: "/mock/agent-host.js",
    databasePath: join(directory, "scopeguard.db"),
    vault,
    fork: () => {
      const child = new MockUtilityProcess(options.autoExitOnShutdown ?? true);
      children.push(child);
      return child as unknown as UtilityProcess;
    },
    onRunEvent: () => {},
    readyTimeoutMs: options.readyTimeoutMs ?? 100,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 100,
    restartBaseDelayMs: options.restartBaseDelayMs ?? 100,
    restartMaxDelayMs: options.restartMaxDelayMs ?? 200,
    onReady: options.onReady,
  });
  return {
    children,
    client,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await sleep(2);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
