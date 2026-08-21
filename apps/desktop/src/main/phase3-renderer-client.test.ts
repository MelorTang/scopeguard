import assert from "node:assert/strict";
import test from "node:test";

import { Phase3RendererClient } from "./phase3-renderer-client.js";

test("Phase 3 Pilot calls only the production preload API in a real Renderer", async () => {
  const scripts: string[] = [];
  const client = new Phase3RendererClient({
    async executeJavaScript(source) {
      scripts.push(source);
      return { ok: true };
    },
  });
  assert.deepEqual(await client.invoke("getWorkspaceSnapshot"), { ok: true });
  assert.deepEqual(await client.invoke("copyHandoffPrompt", "exact text"), { ok: true });
  assert.deepEqual(await client.invoke("stageWorkspaceLayout", {
    workspaceId: "workspace",
    openConversationIds: [],
    paneConversationIds: [],
    paneWidths: [],
    activeConversationId: null,
    requestedPaneCount: 1,
  }), { ok: true });
  assert.equal(scripts.length, 3);
  for (const source of scripts) {
    assert.match(source, /window\.scopeguardDesktop/);
    assert.doesNotMatch(source, /createMockDesktopApi/);
  }
  assert.match(scripts[1]!, /copyHandoffPrompt/);
  assert.match(scripts[1]!, /exact text/);
  assert.match(scripts[2]!, /stageWorkspaceLayout/);
});

test("Phase 3 Pilot arms a delayed layout revision through production preload IPC", async () => {
  const scripts: string[] = [];
  const client = new Phase3RendererClient({
    async executeJavaScript(source) {
      scripts.push(source);
    },
  });
  await client.armLateWorkspaceLayoutStage({
    workspaceId: "workspace",
    openConversationIds: ["conversation"],
    paneConversationIds: ["conversation"],
    paneWidths: [560],
    activeConversationId: "conversation",
    requestedPaneCount: 1,
  }, 250);

  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /window\.scopeguardDesktop/);
  assert.match(scripts[0]!, /setTimeout/);
  assert.match(scripts[0]!, /stageWorkspaceLayout/);
  assert.match(scripts[0]!, /560/);
  assert.doesNotMatch(scripts[0]!, /createMockDesktopApi/);
});
