import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    const inputPath = join(workspaceRoot, "inputs", "brief.md");
    await mkdir(join(workspaceRoot, "inputs"), { recursive: true });
    await writeFile(inputPath, "source brief\n", "utf8");
    await writeFile(sourcePath, "first artifact\n", "utf8");
    const run = completedRun(store, fixture, "confirmed");

    const captured = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "report.md",
      inputRelativePaths: ["inputs/brief.md"],
      producedByConversationId: fixture.conversation.id,
      producedByRunId: run.id,
      toolchain: "Agent Skill: documents",
      limitations: ["Rendered by an external application."],
      validationStatus: "passed",
      validationSummary: "The output reopened with the expected text.",
    });

    const expectedHash = hash("first artifact\n");
    assert.equal(captured.version.contentHash, expectedHash);
    assert.equal(captured.version.version, 1);
    assert.equal(captured.version.producedByRunId, run.id);
    assert.deepEqual(captured.version.inputs, [{
      workspaceId: fixture.workspace.id,
      relativePath: "inputs/brief.md",
      contentHash: hash("source brief\n"),
      byteSize: Buffer.byteLength("source brief\n"),
    }]);
    assert.equal(captured.artifact.currentVersionId, captured.version.id);
    assert.equal(await readFile(sourcePath, "utf8"), "first artifact\n");
    assert.equal(
      await readFile(join(artifactRoot, "blobs", expectedHash.slice(0, 2), expectedHash), "utf8"),
      "first artifact\n",
    );

    await writeFile(sourcePath, "second artifact\n", "utf8");
    const secondRun = completedRun(store, fixture, "confirmed");
    const second = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "report.md",
      artifactId: captured.artifact.id,
      producedByConversationId: fixture.conversation.id,
      producedByRunId: secondRun.id,
      toolchain: "external editor",
      validationStatus: "passed",
      validationSummary: "The revised output reopened with the expected text.",
    });
    assert.equal(second.version.version, 2);
    assert.equal(second.version.parentVersionId, captured.version.id);
    assert.equal(store.listArtifactVersions(captured.artifact.id).length, 2);
  });
});

test("does not promote failed, no-effect, or effect-unknown Runs as successful Artifact Versions", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, fixture }) => {
    await writeFile(join(workspaceRoot, "uncertain.txt"), "uncertain\n", "utf8");
    const invalidRuns = [
      completedRun(store, fixture, "none"),
      completedRun(store, fixture, "effect_unknown"),
      failedRun(store, fixture),
    ];
    for (const run of invalidRuns) {
      await assert.rejects(
        workflow.captureWorkspaceFile({
          workspaceId: fixture.workspace.id,
          relativePath: "uncertain.txt",
          producedByConversationId: fixture.conversation.id,
          producedByRunId: run.id,
          toolchain: "Agent write Tool",
          validationStatus: "passed",
          validationSummary: "The output reopened.",
        }),
        /completed Run with confirmed Tool effects/i,
      );
    }
    assert.equal(store.listArtifacts(fixture.workspace.id).length, 0);
  });
});

test("requires a confirmed producing Run and passed validation for every successful Version", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, fixture }) => {
    await writeFile(join(workspaceRoot, "result.docx"), "candidate\n", "utf8");
    await assert.rejects(
      workflow.captureWorkspaceFile({
        workspaceId: fixture.workspace.id,
        relativePath: "result.docx",
        producedByConversationId: fixture.conversation.id,
        producedByRunId: "",
        toolchain: "Agent file Tool",
        validationStatus: "passed",
        validationSummary: "The output reopened.",
      }),
      /confirmed producing Run/i,
    );

    const run = completedRun(store, fixture, "confirmed");
    const partialCapture = {
      workspaceId: fixture.workspace.id,
      relativePath: "result.docx",
      producedByConversationId: fixture.conversation.id,
      producedByRunId: run.id,
      toolchain: "Agent file Tool",
      validationStatus: "partial",
      validationSummary: "The output reopened, but embedded objects were not preserved.",
    } as const;
    await assert.rejects(
      workflow.captureWorkspaceFile(partialCapture),
      /passed validation/i,
    );
    assert.equal(store.listArtifacts(fixture.workspace.id).length, 0);
  });
});

test("rejects a new Version whose Workspace File format differs from its Artifact", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, fixture }) => {
    await writeFile(join(workspaceRoot, "result.docx"), "docx bytes\n", "utf8");
    const firstRun = completedRun(store, fixture, "confirmed");
    const first = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "result.docx",
      producedByConversationId: fixture.conversation.id,
      producedByRunId: firstRun.id,
      toolchain: "Agent DOCX Tool",
      validationStatus: "passed",
      validationSummary: "The DOCX reopened.",
    });
    await writeFile(join(workspaceRoot, "result.pdf"), "pdf bytes\n", "utf8");
    const secondRun = completedRun(store, fixture, "confirmed");
    await assert.rejects(
      workflow.captureWorkspaceFile({
        workspaceId: fixture.workspace.id,
        relativePath: "result.pdf",
        artifactId: first.artifact.id,
        producedByConversationId: fixture.conversation.id,
        producedByRunId: secondRun.id,
        toolchain: "Agent PDF Tool",
        validationStatus: "passed",
        validationSummary: "The PDF reopened.",
      }),
      /format.*Artifact|Artifact.*format/i,
    );
    assert.equal(store.listArtifactVersions(first.artifact.id).length, 1);
  });
});

test("rolls back a first capture when Version publication fails", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, artifactRoot, fixture }) => {
    await writeFile(join(workspaceRoot, "result.docx"), "candidate\n", "utf8");
    const run = completedRun(store, fixture, "confirmed");
    await assert.rejects(
      workflow.captureWorkspaceFile({
        workspaceId: fixture.workspace.id,
        relativePath: "result.docx",
        producedByConversationId: fixture.conversation.id,
        producedByRunId: run.id,
        toolchain: " invalid toolchain ",
        validationStatus: "passed",
        validationSummary: "The output reopened.",
      }),
      /toolchain/i,
    );
    assert.equal(store.listArtifacts(fixture.workspace.id).length, 0);
    await assert.rejects(
      stat(join(artifactRoot, "blobs", hash("candidate\n").slice(0, 2), hash("candidate\n"))),
      /ENOENT/,
    );
  });
});

test("exports only to a new path and never silently overwrites a Workspace conflict", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, fixture }) => {
    const sourcePath = join(workspaceRoot, "draft.txt");
    await writeFile(sourcePath, "captured\n", "utf8");
    const run = completedRun(store, fixture, "confirmed");
    const captured = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "draft.txt",
      producedByConversationId: fixture.conversation.id,
      producedByRunId: run.id,
      toolchain: "Agent file Tool",
      validationStatus: "passed",
      validationSummary: "The output reopened.",
    });

    await writeFile(sourcePath, "changed elsewhere\n", "utf8");
    await assert.rejects(
      workflow.exportArtifactVersion({
        workspaceId: fixture.workspace.id,
        versionId: captured.version.id,
        relativePath: "draft.txt",
      }),
      (error: unknown) => error instanceof WorkspaceFileConflictError,
    );
    assert.equal(await readFile(sourcePath, "utf8"), "changed elsewhere\n");

    const exported = await workflow.exportArtifactVersion({
      workspaceId: fixture.workspace.id,
      versionId: captured.version.id,
      relativePath: "exports/final.txt",
    });
    assert.equal(exported.contentHash, captured.version.contentHash);
    assert.equal(await readFile(join(workspaceRoot, "exports/final.txt"), "utf8"), "captured\n");
    await assert.rejects(
      workflow.exportArtifactVersion({
        workspaceId: fixture.workspace.id,
        versionId: captured.version.id,
        relativePath: "exports/final.txt",
      }),
      /no longer matches|appeared|conflict|version selected/i,
    );

    await writeFile(sourcePath, "must remain\n", "utf8");
    await assert.rejects(
      workflow.exportArtifactVersion({
        workspaceId: fixture.workspace.id,
        versionId: captured.version.id,
        relativePath: "draft.txt",
      }),
      /new path|already exists|conflict/i,
    );
    assert.equal(await readFile(sourcePath, "utf8"), "must remain\n");
  });
});

test("rejects Workspace paths that escape through a symlink", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, root, fixture }) => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(workspaceRoot, "escape.txt"));
    const run = completedRun(store, fixture, "confirmed");
    await assert.rejects(
      workflow.captureWorkspaceFile({
        workspaceId: fixture.workspace.id,
        relativePath: "escape.txt",
        producedByConversationId: fixture.conversation.id,
        producedByRunId: run.id,
        toolchain: "Agent file Tool",
        validationStatus: "passed",
        validationSummary: "The output reopened.",
      }),
      /outside its Workspace/i,
    );
  });
});

test("does not create export directories through a Workspace symlink", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, root, fixture }) => {
    await writeFile(join(workspaceRoot, "source.txt"), "captured\n", "utf8");
    const run = completedRun(store, fixture, "confirmed");
    const captured = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "source.txt",
      producedByConversationId: fixture.conversation.id,
      producedByRunId: run.id,
      toolchain: "Agent file Tool",
      validationStatus: "passed",
      validationSummary: "The output reopened.",
    });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(workspaceRoot, "linked"));

    await assert.rejects(
      workflow.exportArtifactVersion({
        workspaceId: fixture.workspace.id,
        versionId: captured.version.id,
        relativePath: "linked/created/final.txt",
      }),
      /symbolic link|outside its Workspace/i,
    );
    await assert.rejects(stat(join(outside, "created")), /ENOENT/);
  });
});

test("prepares an external-open copy without exposing mutable Artifact storage", async () => {
  await withFixture(async ({ store, workflow, workspaceRoot, artifactRoot, fixture }) => {
    await writeFile(join(workspaceRoot, "quarterly-report.docx"), "immutable bytes\n", "utf8");
    const run = completedRun(store, fixture, "confirmed");
    const captured = await workflow.captureWorkspaceFile({
      workspaceId: fixture.workspace.id,
      relativePath: "quarterly-report.docx",
      producedByConversationId: fixture.conversation.id,
      producedByRunId: run.id,
      toolchain: "Agent Skill: documents",
      validationStatus: "passed",
      validationSummary: "The DOCX reopened with readable text.",
    });

    const openedPath = await workflow.prepareArtifactVersionOpen(captured.version.id);
    assert.match(openedPath, /quarterly-report\.docx$/);
    assert.equal(await readFile(openedPath, "utf8"), "immutable bytes\n");

    await writeFile(openedPath, "edited external copy\n", "utf8");
    const storagePath = join(
      artifactRoot,
      "blobs",
      captured.version.contentHash.slice(0, 2),
      captured.version.contentHash,
    );
    assert.equal(await readFile(storagePath, "utf8"), "immutable bytes\n");
    assert.equal(
      await readFile(await workflow.prepareArtifactVersionOpen(captured.version.id), "utf8"),
      "immutable bytes\n",
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
  effect: "none" | "confirmed" | "effect_unknown",
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

function failedRun(
  store: ScopeGuardStore,
  fixture: ReturnType<typeof createFixture>,
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
  store.updateRunStatus(run.id, "running");
  return store.updateRunStatus(run.id, "failed", "Tool unavailable.");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
