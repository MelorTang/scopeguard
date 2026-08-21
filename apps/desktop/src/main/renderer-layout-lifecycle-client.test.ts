import assert from "node:assert/strict";
import test from "node:test";

import { RendererLayoutLifecycleClient } from "./renderer-layout-lifecycle-client.js";

test("waits for an exact drain acknowledgement from the target Renderer", async () => {
  const sent: unknown[] = [];
  const client = new RendererLayoutLifecycleClient({
    rendererId: 17,
    send: (request) => sent.push(request),
    timeoutMs: 100,
  });

  const draining = client.drain();
  assert.deepEqual(sent, [{ requestId: "layout-lifecycle-1", action: "drain" }]);
  assert.equal(client.handleResponse(99, {
    requestId: "layout-lifecycle-1",
    action: "drain",
    ok: true,
    drainReceipt: drainReceipt("layout-lifecycle-1"),
  }), false);
  assert.equal(client.handleResponse(17, {
    requestId: "layout-lifecycle-1",
    action: "drain",
    ok: true,
    drainReceipt: drainReceipt("layout-lifecycle-1"),
  }), true);
  assert.deepEqual(await draining, drainReceipt("layout-lifecycle-1"));
});

test("times out a missing drain acknowledgement and can complete a later resume", async () => {
  const sent: unknown[] = [];
  const client = new RendererLayoutLifecycleClient({
    rendererId: 17,
    send: (request) => sent.push(request),
    timeoutMs: 10,
  });

  await assert.rejects(() => client.drain(), /drain acknowledgement timed out/i);
  const resuming = client.resume();
  assert.deepEqual(sent.at(-1), {
    requestId: "layout-lifecycle-2",
    action: "resume",
  });
  client.handleResponse(17, {
    requestId: "layout-lifecycle-2",
    action: "resume",
    ok: true,
  });
  await resuming;
});

test("propagates Renderer lifecycle failures without accepting malformed responses", async () => {
  const client = new RendererLayoutLifecycleClient({
    rendererId: 17,
    send: () => undefined,
    timeoutMs: 100,
  });

  const draining = client.drain();
  assert.throws(() => client.handleResponse(17, {
    requestId: "layout-lifecycle-1",
    action: "drain",
    ok: true,
    drainReceipt: drainReceipt("forged-generation"),
  }), /lifecycle response/i);
  client.handleResponse(17, {
    requestId: "layout-lifecycle-1",
    action: "drain",
    ok: false,
    error: "Renderer coordinator failed.",
  });
  await assert.rejects(() => draining, /Renderer coordinator failed/);
});

function drainReceipt(generation: string) {
  return {
    generation,
    acceptedRevisions: [{
      workspaceId: "workspace",
      revision: 3,
      layout: {
        workspaceId: "workspace",
        openConversationIds: ["conversation"],
        paneConversationIds: ["conversation"],
        paneWidths: [560],
        activeConversationId: "conversation",
        requestedPaneCount: 1,
      },
    }],
  };
}
