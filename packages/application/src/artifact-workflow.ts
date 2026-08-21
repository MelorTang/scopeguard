import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseArtifactFormat,
  parseSha256Digest,
  parseWorkspaceRelativePath,
  type AgentRun,
  type Artifact,
  type ArtifactVersion,
  type Conversation,
  type CreateArtifactInput,
  type CreateArtifactVersionInput,
  type Id,
  type Workspace,
  type WorkspaceFileVersion,
} from "@scopeguard/domain";

export type CaptureWorkspaceFileInput = {
  workspaceId: Id;
  relativePath: string;
  artifactId?: Id;
  title?: string;
  format?: string;
  producedByConversationId?: Id | null;
  producedByRunId?: Id | null;
  toolchain: string;
  limitations?: string[];
};

export type ExportArtifactVersionInput = {
  workspaceId: Id;
  versionId: Id;
  relativePath: string;
  expectedContentHash: string | null;
};

export type CapturedArtifactVersion = {
  artifact: Artifact;
  version: ArtifactVersion;
};

export interface ArtifactWorkflowStore {
  getWorkspace(id: Id): Workspace | null;
  getArtifact(id: Id): Artifact | null;
  createArtifact(input: CreateArtifactInput): Artifact;
  getArtifactVersion(id: Id): ArtifactVersion | null;
  getArtifactVersionStorageKey(id: Id): string | null;
  createArtifactVersion(input: CreateArtifactVersionInput, storageKey: string): ArtifactVersion;
  getConversation(id: Id): Conversation | null;
  getRun(id: Id): AgentRun | null;
}

export class WorkspaceFileConflictError extends Error {
  readonly code = "workspace_file_conflict";
  readonly relativePath: string;

  constructor(relativePath: string, message: string) {
    super(message);
    this.name = "WorkspaceFileConflictError";
    this.relativePath = relativePath;
  }
}

export class ArtifactWorkflow {
  readonly #store: ArtifactWorkflowStore;
  readonly #artifactRoot: string;
  readonly #pathLocks = new Map<string, Promise<void>>();

  constructor(options: { store: ArtifactWorkflowStore; artifactRoot: string }) {
    if (!isAbsolute(options.artifactRoot)) {
      throw new Error("Artifact storage root must be absolute.");
    }
    this.#store = options.store;
    this.#artifactRoot = options.artifactRoot;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.#artifactRoot, "blobs"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#artifactRoot, "staging"), { recursive: true, mode: 0o700 });
  }

  async captureWorkspaceFile(
    raw: CaptureWorkspaceFileInput,
  ): Promise<CapturedArtifactVersion> {
    const workspace = this.#requireWorkspace(raw.workspaceId);
    const relativePath = parseWorkspaceRelativePath(raw.relativePath);
    const sourcePath = await resolveExistingWorkspaceFile(workspace, relativePath);
    const provenance = this.#validateProvenance(workspace, raw);
    const captured = await this.#captureStableFile(sourcePath, workspace.id, relativePath);
    const storageKey = await this.#publishBlob(captured.stagingPath, captured.version);

    let artifact = raw.artifactId ? this.#store.getArtifact(raw.artifactId) : null;
    if (raw.artifactId && (!artifact || artifact.workspaceId !== workspace.id)) {
      throw new Error("Artifact capture target must belong to the Workspace.");
    }
    if (!artifact) {
      artifact = this.#store.createArtifact({
        workspaceId: workspace.id,
        title: raw.title?.trim() || basenameFromPortablePath(relativePath),
        format: parseArtifactFormat(raw.format ?? formatFromPath(relativePath)),
        sourceRelativePath: relativePath,
        associatedConversationId: provenance.conversationId,
      });
    }

    const version = this.#store.createArtifactVersion({
      artifactId: artifact.id,
      parentVersionId: artifact.currentVersionId,
      source: captured.version,
      contentHash: captured.version.contentHash,
      byteSize: captured.version.byteSize,
      producedByConversationId: provenance.conversationId,
      producedByRunId: provenance.runId,
      toolchain: raw.toolchain,
      limitations: raw.limitations ?? [],
    }, storageKey);
    return { artifact: this.#store.getArtifact(artifact.id)!, version };
  }

  async exportArtifactVersion(
    raw: ExportArtifactVersionInput,
  ): Promise<WorkspaceFileVersion> {
    const workspace = this.#requireWorkspace(raw.workspaceId);
    const relativePath = parseWorkspaceRelativePath(raw.relativePath);
    const expected = raw.expectedContentHash === null
      ? null
      : parseSha256Digest(raw.expectedContentHash, "Expected Workspace File contentHash");
    const version = this.#store.getArtifactVersion(raw.versionId);
    if (!version) throw new Error(`Artifact Version not found: ${raw.versionId}`);
    const artifact = this.#store.getArtifact(version.artifactId);
    if (!artifact || artifact.workspaceId !== workspace.id) {
      throw new Error("Artifact Version export target must belong to the Workspace.");
    }
    const storageKey = this.#store.getArtifactVersionStorageKey(version.id);
    if (!storageKey) throw new Error("Artifact Version content is unavailable.");
    const blobPath = resolveStorageKey(this.#artifactRoot, storageKey);
    const blob = await hashRegularFile(blobPath);
    if (blob.contentHash !== version.contentHash || blob.byteSize !== version.byteSize) {
      throw new Error("Artifact Version content failed its stored identity check.");
    }

    const workspaceRoot = await requireWorkspaceRoot(workspace);
    const destinationPath = resolve(workspaceRoot, ...relativePath.split("/"));
    await assertParentInsideWorkspace(workspaceRoot, destinationPath);
    return this.#withPathLock(destinationPath, async () => {
      const before = await optionalFileVersion(destinationPath, workspace.id, relativePath);
      assertExpectedWorkspaceVersion(relativePath, before, expected);
      const tempPath = join(dirname(destinationPath), `.scopeguard-${randomUUID()}.tmp`);
      try {
        await copyFile(blobPath, tempPath, constants.COPYFILE_EXCL);
        const candidate = await hashRegularFile(tempPath);
        if (candidate.contentHash !== version.contentHash || candidate.byteSize !== version.byteSize) {
          throw new Error("Artifact export candidate failed its content identity check.");
        }
        const current = await optionalFileVersion(destinationPath, workspace.id, relativePath);
        assertSameObservedWorkspaceVersion(relativePath, before, current);
        if (current === null) {
          try {
            await link(tempPath, destinationPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new WorkspaceFileConflictError(
                relativePath,
                "Workspace File appeared before Artifact export could publish it.",
              );
            }
            throw error;
          }
          await unlink(tempPath);
        } else {
          await rename(tempPath, destinationPath);
        }
        const published = await optionalFileVersion(destinationPath, workspace.id, relativePath);
        if (
          !published ||
          published.contentHash !== version.contentHash ||
          published.byteSize !== version.byteSize
        ) {
          throw new Error("Published Workspace File failed its Artifact Version identity check.");
        }
        return published;
      } finally {
        await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
  }

  #requireWorkspace(id: Id): Workspace {
    const workspace = this.#store.getWorkspace(id);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);
    return workspace;
  }

  #validateProvenance(
    workspace: Workspace,
    input: CaptureWorkspaceFileInput,
  ): { conversationId: Id | null; runId: Id | null } {
    const conversationId = input.producedByConversationId ?? null;
    const runId = input.producedByRunId ?? null;
    const conversation = conversationId ? this.#store.getConversation(conversationId) : null;
    if (conversationId && (!conversation || conversation.workspaceId !== workspace.id)) {
      throw new Error("Artifact producer Conversation must belong to the Workspace.");
    }
    if (runId) {
      const run = this.#store.getRun(runId);
      if (!run || run.status !== "completed" || run.effect === "effect_unknown") {
        throw new Error("Only a completed Run with known Tool effects may produce an Artifact Version.");
      }
      const owner = this.#store.getConversation(run.conversationId);
      if (
        !owner ||
        owner.workspaceId !== workspace.id ||
        (conversation && conversation.id !== owner.id)
      ) {
        throw new Error("Artifact producer Run must match its Workspace and Conversation.");
      }
      return { conversationId: owner.id, runId: run.id };
    }
    return { conversationId, runId: null };
  }

  async #captureStableFile(
    sourcePath: string,
    workspaceId: Id,
    relativePath: string,
  ): Promise<{ stagingPath: string; version: WorkspaceFileVersion }> {
    const before = await hashRegularFile(sourcePath);
    const stagingPath = join(this.#artifactRoot, "staging", `${randomUUID()}.tmp`);
    try {
      await copyFile(sourcePath, stagingPath, constants.COPYFILE_EXCL);
      const [copy, after] = await Promise.all([
        hashRegularFile(stagingPath),
        hashRegularFile(sourcePath),
      ]);
      if (
        before.contentHash !== after.contentHash ||
        before.byteSize !== after.byteSize ||
        copy.contentHash !== after.contentHash ||
        copy.byteSize !== after.byteSize
      ) {
        throw new WorkspaceFileConflictError(
          relativePath,
          "Workspace File changed while ScopeGuard was capturing the Artifact Version.",
        );
      }
      return {
        stagingPath,
        version: {
          workspaceId,
          relativePath,
          contentHash: after.contentHash,
          byteSize: after.byteSize,
        },
      };
    } catch (error) {
      await unlink(stagingPath).catch(() => {});
      throw error;
    }
  }

  async #publishBlob(
    stagingPath: string,
    version: WorkspaceFileVersion,
  ): Promise<string> {
    const storageKey = `${version.contentHash.slice(0, 2)}/${version.contentHash}`;
    const destination = resolveStorageKey(this.#artifactRoot, storageKey);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await link(stagingPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await hashRegularFile(destination);
      if (
        existing.contentHash !== version.contentHash ||
        existing.byteSize !== version.byteSize
      ) {
        throw new Error("Content-addressed Artifact storage contains mismatched bytes.");
      }
    } finally {
      await unlink(stagingPath).catch(() => {});
    }
    return storageKey;
  }

  async #withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#pathLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const queued = previous.then(() => current);
    this.#pathLocks.set(path, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#pathLocks.get(path) === queued) this.#pathLocks.delete(path);
    }
  }
}

async function requireWorkspaceRoot(workspace: Workspace): Promise<string> {
  if (!workspace.localRootPath) {
    throw new Error("Workspace has no local directory.");
  }
  const root = await realpath(workspace.localRootPath);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error("Workspace local root is not a directory.");
  return root;
}

async function resolveExistingWorkspaceFile(
  workspace: Workspace,
  relativePath: string,
): Promise<string> {
  const root = await requireWorkspaceRoot(workspace);
  const candidate = resolve(root, ...relativePath.split("/"));
  const resolved = await realpath(candidate);
  assertInside(root, resolved, "Workspace File resolves outside its Workspace.");
  const metadata = await lstat(resolved);
  if (!metadata.isFile()) throw new Error("Workspace File must be a regular file.");
  return resolved;
}

async function assertParentInsideWorkspace(root: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const parent = await realpath(dirname(destinationPath));
  assertInside(root, parent, "Workspace export directory resolves outside its Workspace.");
}

function assertInside(root: string, candidate: string, message: string): void {
  const path = relative(root, candidate);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(message);
}

async function hashRegularFile(path: string): Promise<{ contentHash: string; byteSize: number }> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Artifact content must be a regular file.");
    const bytes = await readFile(handle);
    return {
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    };
  } finally {
    await handle.close();
  }
}

async function optionalFileVersion(
  path: string,
  workspaceId: Id,
  relativePath: string,
): Promise<WorkspaceFileVersion | null> {
  try {
    const value = await hashRegularFile(path);
    return { workspaceId, relativePath, ...value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertExpectedWorkspaceVersion(
  relativePath: string,
  observed: WorkspaceFileVersion | null,
  expectedContentHash: string | null,
): void {
  if (expectedContentHash === null && observed === null) return;
  if (expectedContentHash !== null && observed?.contentHash === expectedContentHash) return;
  throw new WorkspaceFileConflictError(
    relativePath,
    observed
      ? "Workspace File no longer matches the version selected for Artifact export."
      : "Workspace File was removed before Artifact export.",
  );
}

function assertSameObservedWorkspaceVersion(
  relativePath: string,
  before: WorkspaceFileVersion | null,
  current: WorkspaceFileVersion | null,
): void {
  if (
    before?.contentHash === current?.contentHash &&
    before?.byteSize === current?.byteSize
  ) return;
  if (before === null && current === null) return;
  throw new WorkspaceFileConflictError(
    relativePath,
    "Workspace File changed while Artifact export was being prepared.",
  );
}

function resolveStorageKey(root: string, storageKey: string): string {
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(storageKey)) {
    throw new Error("Artifact storage key is invalid.");
  }
  return join(root, "blobs", ...storageKey.split("/"));
}

function formatFromPath(relativePath: string): string {
  const extension = extname(relativePath).slice(1).toLowerCase();
  return extension || "file";
}

function basenameFromPortablePath(relativePath: string): string {
  return relativePath.split("/").at(-1)!;
}
