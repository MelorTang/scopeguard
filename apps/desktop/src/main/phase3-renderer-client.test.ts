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
      return {
        armedAtUnixMs: 1_000,
        dueAtUnixMs: 1_250,
      };
    },
  });
  const receipt = await client.armLateWorkspaceLayoutStage({
    workspaceId: "workspace",
    openConversationIds: ["conversation"],
    paneConversationIds: ["conversation"],
    paneWidths: [560],
    activeConversationId: "conversation",
    requestedPaneCount: 1,
  }, 250);

  assert.deepEqual(receipt, {
    armedAtUnixMs: 1_000,
    dueAtUnixMs: 1_250,
  });
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /window\.scopeguardDesktop/);
  assert.match(scripts[0]!, /setTimeout/);
  assert.match(scripts[0]!, /stageWorkspaceLayout/);
  assert.match(scripts[0]!, /560/);
  assert.doesNotMatch(scripts[0]!, /createMockDesktopApi/);
});

test("Phase 3 Pilot resizes through the real Workbench control", async () => {
  const scripts: string[] = [];
  const client = new Phase3RendererClient({
    async executeJavaScript(source) {
      scripts.push(source);
      return [492, 488, 556];
    },
  });

  assert.deepEqual(
    await client.resizeFirstPaneThroughWorkbench([468, 512, 556]),
    [492, 488, 556],
  );
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /\.workbench/);
  assert.match(scripts[0]!, /role="separator/);
  assert.match(scripts[0]!, /ArrowRight/);
  assert.doesNotMatch(scripts[0]!, /stageWorkspaceLayout/);
  assert.doesNotMatch(scripts[0]!, /createMockDesktopApi/);
});

test("Phase 4 Pilot reads restored Artifact Review state from the production Renderer", async () => {
  const scripts: string[] = [];
  const client = new Phase3RendererClient({
    async executeJavaScript(source) {
      scripts.push(source);
      return {
        title: "Quarterly report.docx",
        versionId: "version-1",
        comparisonVersionId: "version-2",
        text: "Pi bash Tool + Node.js input-hash",
      };
    },
  });

  const result = await client.readArtifactReview({
    artifactTitle: "Quarterly report.docx",
    versionId: "version-1",
    comparisonVersionId: "version-2",
    toolchain: "Pi bash Tool + Node.js",
    inputHash: "input-hash",
  });
  assert.equal(result.versionId, "version-1");
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /\.artifact-review/);
  assert.match(scripts[0]!, /审阅版本/);
  assert.match(scripts[0]!, /对比版本/);
  assert.doesNotMatch(scripts[0]!, /createMockDesktopApi/);
});
