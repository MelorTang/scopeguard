import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHostToMainMessage } from "@scopeguard/ipc-contracts";
import type { ManagedExecutionRequest } from "@scopeguard/managed-execution";

import { AgentHostManagedExecutionAdapter } from "../agent-host-managed-execution.js";

const request: ManagedExecutionRequest = {
  executionId: "execution",
  projectId: "project",
  threadId: "thread",
  runId: "run",
  workspaceRoot: "/workspace",
  command: "echo ready",
  timeoutMs: 30_000,
  environment: {},
};

test("forwards managed execution events and results over the private host port", async () => {
  const messages: AgentHostToMainMessage[] = [];
  const stages: string[] = [];
  const adapter = new AgentHostManagedExecutionAdapter({
    postMessage: (message) => messages.push(message),
  });
  const executing = adapter.execute(request, {
    signal: new AbortController().signal,
    onEvent: (event) => stages.push(event.stage),
  });
  const outbound = messages[0];
  assert.equal(outbound?.type, "host-managed-execution-request");
  if (outbound?.type !== "host-managed-execution-request") return;

  adapter.handleEvent({
    type: "host-managed-execution-event",
    requestId: outbound.requestId,
    event: {
      executionId: request.executionId,
      stage: "running",
      at: new Date().toISOString(),
    },
  });
  adapter.handleResponse({
    type: "host-managed-execution-response",
    requestId: outbound.requestId,
    ok: true,
    result: {
      executionId: request.executionId,
      status: "exited",
      exitCode: 0,
      output: "ready",
      outputTruncated: false,
      termination: "confirmed",
      cleanup: "clean",
      effect: "confirmed",
    },
  });

  assert.deepEqual(stages, ["running"]);
  assert.equal((await executing).output, "ready");
});

test("maps an AbortSignal to the matching private cancel request", async () => {
  const messages: AgentHostToMainMessage[] = [];
  const controller = new AbortController();
  const adapter = new AgentHostManagedExecutionAdapter({
    postMessage: (message) => messages.push(message),
  });
  const executing = adapter.execute(request, { signal: controller.signal });
  const outbound = messages[0];
  assert.equal(outbound?.type, "host-managed-execution-request");
  if (outbound?.type !== "host-managed-execution-request") return;

  controller.abort();
  assert.deepEqual(messages[1], {
    type: "host-managed-execution-cancel",
    requestId: outbound.requestId,
  });
  adapter.handleResponse({
    type: "host-managed-execution-response",
    requestId: outbound.requestId,
    ok: true,
    result: {
      executionId: request.executionId,
      status: "cancelled",
      exitCode: null,
      output: "Command cancelled.",
      outputTruncated: false,
      termination: "confirmed",
      cleanup: "clean",
      effect: "unknown",
    },
  });
  assert.equal((await executing).status, "cancelled");
});
