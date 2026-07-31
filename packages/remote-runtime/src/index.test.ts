import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ProviderAdapter,
  ProviderStreamEvent,
  ProviderTurnRequest,
} from "@scopeguard/agent-runtime";
import type { ProviderProtocol } from "@scopeguard/domain";

import {
  HttpRemoteRuntimeClient,
  RemoteRuntimeProtocolError,
  RemoteRuntimeRequestError,
  RemoteRuntimeService,
  normalizeRuntimeBaseUrl,
  type RemoteRunRecord,
  type RemoteRunSubmission,
} from "./index.js";

test("runs persist without a connected desktop and never store submitted secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-remote-"));
  const databasePath = join(directory, "runtime.sqlite");
  const seenKeys: Array<string | null> = [];
  const service = new RemoteRuntimeService({
    databasePath,
    token: "runtime-token",
    port: 0,
    providerFactory: (protocol) => new FakeProvider(protocol, seenKeys),
  });

  try {
    const { baseUrl } = await service.start();
    const unauthorized = await fetch(`${baseUrl}/v1/health`);
    assert.equal(unauthorized.status, 401);

    const client = new HttpRemoteRuntimeClient({
      baseUrl,
      token: "runtime-token",
    });
    const health = await client.health();
    assert.equal(health.capabilities.persistentRuns, true);
    assert.equal(health.capabilities.fileTools, false);

    const request = makeSubmission("desktop-run-1", "durable request", "provider-secret");
    const submitted = await client.submitRun(request);
    assert.equal(submitted.status === "queued" || submitted.status === "running", true);

    // No poller remains attached. A fresh client reconnects after execution.
    await delay(100);
    const reconnected = new HttpRemoteRuntimeClient({
      baseUrl,
      token: "runtime-token",
    });
    const completed = await waitForTerminal(reconnected, submitted.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.artifact?.content, "远端任务已完成");
    assert.deepEqual(seenKeys, ["provider-secret"]);

    const duplicate = await reconnected.submitRun(request);
    assert.equal(duplicate.id, submitted.id, "client Run IDs must be idempotent");

    const allEvents = await reconnected.getRun(submitted.id, 0);
    assert.equal(allEvents.events.some((event) => event.type === "text-delta"), true);
    assert.equal(allEvents.events.some((event) => event.type === "artifact"), true);

    await service.close();
    const databaseBytes = await readFile(databasePath);
    assert.equal(databaseBytes.includes(Buffer.from("provider-secret")), false);
    assert.equal(databaseBytes.includes(Buffer.from("runtime-token")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling one remote Run does not affect another", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-remote-cancel-"));
  const service = new RemoteRuntimeService({
    databasePath: join(directory, "runtime.sqlite"),
    token: "runtime-token",
    port: 0,
    providerFactory: (protocol) => new FakeProvider(protocol, []),
  });
  try {
    const { baseUrl } = await service.start();
    const client = new HttpRemoteRuntimeClient({ baseUrl, token: "runtime-token" });
    const cancelled = await client.submitRun(
      makeSubmission("desktop-run-cancel", "cancel-me", "secret-a"),
    );
    const completed = await client.submitRun(
      makeSubmission("desktop-run-complete", "keep-going", "secret-b"),
    );
    await client.cancelRun(cancelled.id);

    assert.equal((await waitForTerminal(client, cancelled.id)).status, "cancelled");
    assert.equal((await waitForTerminal(client, completed.id)).status, "completed");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires HTTPS for non-loopback Runtime URLs", () => {
  assert.equal(normalizeRuntimeBaseUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.throws(
    () => normalizeRuntimeBaseUrl("http://runtime.example.com"),
    /must use HTTPS/,
  );
  assert.equal(
    normalizeRuntimeBaseUrl("https://runtime.example.com/"),
    "https://runtime.example.com",
  );
});

test("does not expose Runtime response text or bearer credentials in errors", async () => {
  const client = new HttpRemoteRuntimeClient({
    baseUrl: "https://runtime.example.com",
    token: "runtime-top-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      error: "server echoed runtime-top-secret",
    }), { status: 500 }),
  });

  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.equal(error instanceof RemoteRuntimeRequestError, true);
      assert.equal((error as RemoteRuntimeRequestError).status, 500);
      assert.equal((error as RemoteRuntimeRequestError).retryable, true);
      assert.equal(String(error).includes("runtime-top-secret"), false);
      assert.equal(String(error).includes("server echoed"), false);
      return true;
    },
  );
});

test("marks authorization failures as terminal without trusting response text", async () => {
  const client = new HttpRemoteRuntimeClient({
    baseUrl: "https://runtime.example.com",
    token: "runtime-token",
    fetchImpl: async () => new Response("not-json runtime-token", { status: 401 }),
  });

  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.equal(error instanceof RemoteRuntimeRequestError, true);
      assert.equal((error as RemoteRuntimeRequestError).status, 401);
      assert.equal((error as RemoteRuntimeRequestError).retryable, false);
      assert.equal(String(error).includes("runtime-token"), false);
      return true;
    },
  );
});

test("treats a response-body disconnect as a retryable transport failure", async () => {
  const client = new HttpRemoteRuntimeClient({
    baseUrl: "https://runtime.example.com",
    token: "runtime-token",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error("body disconnected"));
      },
    }), { status: 200 }),
  });

  await assert.rejects(
    () => client.health(),
    (error: unknown) =>
      error instanceof RemoteRuntimeRequestError && error.retryable,
  );
});

test("rejects unknown remote Run states instead of polling indefinitely", async () => {
  const client = new HttpRemoteRuntimeClient({
    baseUrl: "https://runtime.example.com",
    token: "runtime-token",
    fetchImpl: async () => new Response(JSON.stringify({
      run: {
        id: "remote-run",
        clientRunId: "client-run",
        workspaceId: "workspace",
        taskId: "task",
        threadId: "thread",
        agentInstanceId: "agent",
        status: "paused-by-server",
        error: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        lastSequence: 0,
        artifact: null,
      },
      events: [],
    }), { status: 200 }),
  });

  await assert.rejects(
    () => client.getRun("remote-run"),
    (error: unknown) => error instanceof RemoteRuntimeProtocolError,
  );
});

class FakeProvider implements ProviderAdapter {
  constructor(
    readonly protocol: ProviderProtocol,
    readonly seenKeys: Array<string | null>,
  ) {}

  async testConnection() {
    return { ok: true, latencyMs: 1, model: "fake", message: "ok" };
  }

  async *streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderStreamEvent> {
    this.seenKeys.push(request.credentials.apiKey);
    const prompt = request.messages.at(-1)?.content ?? "";
    yield { type: "text-delta", delta: "远端任务" };
    await abortableDelay(prompt === "cancel-me" ? 200 : 25, request.signal);
    yield { type: "text-delta", delta: "已完成" };
    yield { type: "completed", finishReason: "stop" };
  }
}

function makeSubmission(
  clientRunId: string,
  prompt: string,
  apiKey: string,
): RemoteRunSubmission {
  return {
    clientRunId,
    remoteRunId: `remote-${clientRunId}`,
    workspaceId: "workspace-1",
    taskId: "task-1",
    threadId: `thread-${clientRunId}`,
    agentInstanceId: "agent-instance-1",
    artifactTitle: "远端报告",
    provider: {
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      apiKey,
      model: "test-model",
      customHeaders: {},
    },
    messages: [{ role: "user", content: prompt }],
  };
}

async function waitForTerminal(
  client: HttpRemoteRuntimeClient,
  runId: string,
): Promise<RemoteRunRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { run } = await client.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return run;
    }
    await delay(10);
  }
  throw new Error("Remote Run did not finish before the test timeout.");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
