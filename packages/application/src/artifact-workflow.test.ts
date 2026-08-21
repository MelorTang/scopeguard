import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScopeGuardStore } from "@scopeguard/storage-sqlite";

import {
  ArtifactWorkflow,
  WorkspaceFileConflictError,
} from "./artifact-workflow.js";

test("captures a stable Agent-produced Workspace File as immutable content", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, artifactRoot, fixture }) => {
    const sourcePath = join(workspaceRoot, "report.md");
    await writeFile(sourcePath, "first artifact\n", "utf8");
    const run = completedRun(store, fixture, "confirmed");

    const captured = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "report.md",
      producedByConversationId: fixture.conversation.id,
      producedByRunId: run.id,
      toolchain: "Agent Skill: documents",
      limitations: ["Rendered by an external application."],
    });

    const expectedHash = hash("first artifact\n");
    assert.equal(captured.version.contentHash, expectedHash);
    assert.equal(captured.version.version, 1);
    assert.equal(captured.version.producedByRunId, run.id);
    assert.equal(captured.artifact.currentVersionId, captured.version.id);
    assert.equal(await readFile(sourcePath, "utf8"), "first artifact\n");
    assert.equal(
      await readFile(join(artifactRoot, "blobs", expectedHash.slice(0, 2), expectedHash), "utf8"),
      "first artifact\n",
    );

    await writeFile(sourcePath, "second artifact\n", "utf8");
    const second = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "report.md",
      artifactId: captured.artifact.id,
      toolchain: "manual external editor",
    });
    assert.equal(second.version.version, 2);
    assert.equal(second.version.parentVersionId, captured.version.id);
    assert.equal(store.listArtifactVersions(captured.artifact.id).length, 2);
  });
});

test("does not promote failed or effect-unknown Runs as successful Artifact Versions", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, fixture }) => {
    await writeFile(join(workspaceRoot, "uncertain.txt"), "uncertain\n", "utf8");
    const run = completedRun(store, fixture, "effect_unknown");
    await assert.rejects(
      workflow.captureWorkspaceFile({
        workspaceId: fixture.workspace.id,
        relativePath: "uncertain.txt",
        producedByRunId: run.id,
        toolchain: "Agent write Tool",
      }),
      /known Tool effects/i,
    );
    assert.equal(store.listArtifacts(fixture.workspace.id).length, 0);
  });
});

test("exports with expected hashes and never silently overwrites a Workspace conflict", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, fixture }) => {
    const sourcePath = join(workspaceRoot, "draft.txt");
    await writeFile(sourcePath, "captured\n", "utf8");
    const captured = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "draft.txt",
      toolchain: "manual import",
    });

    await writeFile(sourcePath, "changed elsewhere\n", "utf8");
    await assert.rejects(
      workflow.exportArtifactVersion({
        workspaceId: fixture.workspace.id,
        versionId: captured.version.id,
        relativePath: "draft.txt",
        expectedContentHash: captured.version.source!.contentHash,
      }),
      (error: unknown) => error instanceof WorkspaceFileConflictError,
    );
    assert.equal(await readFile(sourcePath, "utf8"), "changed elsewhere\n");

    const exported = await workflow.exportArtifactVersion({
      workspaceId: fixture.workspace.id,
      versionId: captured.version.id,
      relativePath: "exports/final.txt",
      expectedContentHash: null,
    });
    assert.equal(exported.contentHash, captured.version.contentHash);
    assert.equal(await readFile(join(workspaceRoot, "exports/final.txt"), "utf8"), "captured\n");
    await assert.rejects(
      workflow.exportArtifactVersion({
        workspaceId: fixture.workspace.id,
        versionId: captured.version.id,
        relativePath: "exports/final.txt",
        expectedContentHash: null,
      }),
      /no longer matches|appeared|conflict|version selected/i,
    );

    await writeFile(sourcePath, "replaceable\n", "utf8");
    const replaceableHash = hash("replaceable\n");
    const replaced = await workflow.exportArtifactVersion({
      workspaceId: fixture.workspace.id,
      versionId: captured.version.id,
      relativePath: "draft.txt",
      expectedContentHash: replaceableHash,
    });
    assert.equal(replaced.contentHash, captured.version.contentHash);
    assert.equal(await readFile(sourcePath, "utf8"), "captured\n");
  });
});

test("rejects Workspace paths that escape through a symlink", async () => {
  await withFixture(async ({ workflow, workspaceRoot, root, fixture }) => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(workspaceRoot, "escape.txt"));
    await assert.rejects(
      workflow.captureWorkspaceFile({
        workspaceId: fixture.workspace.id,
        relativePath: "escape.txt",
        toolchain: "manual import",
      }),
      /outside its Workspace/i,
    );
  });
});

async function withFixture(
  run: (value: {
    root: string;
    workspaceRoot: string;
    artifactRoot: string;
    store: ScopeGuardStore;
    workflow: ArtifactWorkflow;
    fixture: ReturnType<typeof createFixture>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-artifact-workflow-"));
  const workspaceRoot = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspaceRoot, { recursive: true });
  const store = new ScopeGuardStore(join(root, "scopeguard.db"));
  const fixture = createFixture(store, workspaceRoot);
  const workflow = new ArtifactWorkflow({ store, artifactRoot });
  await workflow.initialize();
  try {
    await run({ root, workspaceRoot, artifactRoot, store, workflow, fixture });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createFixture(store: ScopeGuardStore, workspaceRoot: string) {
  const workspace = store.createWorkspace({ name: "Workspace", localRootPath: workspaceRoot });
  const provider = store.saveProviderProfile({
    name: "Provider",
    protocol: "openai-compatible",
    baseUrl: "http://localhost/v1",
    defaultModel: "model",
  }, null);
  const agent = store.createAgent({
    workspaceId: workspace.id,
    name: "Agent",
    instructions: "",
    providerProfileId: provider.id,
  });
  const conversation = store.createConversation({ workspaceId: workspace.id, agentId: agent.id });
  return { workspace, provider, agent, conversation };
}

function completedRun(
  store: ScopeGuardStore,
  fixture: ReturnType<typeof createFixture>,
  effect: "confirmed" | "effect_unknown",
) {
  const run = store.createRun(fixture.conversation.id, {
    agentId: fixture.agent.id,
    providerProfileId: fixture.provider.id,
    providerProtocol: fixture.provider.protocol,
    providerBaseUrl: fixture.provider.baseUrl,
    model: fixture.provider.defaultModel,
    instructions: "",
    executionProfile: "request-approval",
    toolPolicy: fixture.agent.toolPolicy,
  });
  store.updateRunStatus(run.id, "preparing");
  store.updateRunStatus(run.id, "running", undefined, effect);
  return store.updateRunStatus(run.id, "completed", undefined, effect);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
