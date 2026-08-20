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
  assert.equal(scripts.length, 2);
  for (const source of scripts) {
    assert.match(source, /window\.scopeguardDesktop/);
    assert.doesNotMatch(source, /createMockDesktopApi/);
  }
  assert.match(scripts[1]!, /copyHandoffPrompt/);
  assert.match(scripts[1]!, /exact text/);
});
