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
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseArtifactFormat,
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
  inputRelativePaths?: string[];
  artifactId?: Id;
  title?: string;
  format?: string;
  producedByConversationId: Id;
  producedByRunId: Id;
  toolchain: string;
  limitations?: string[];
  validationStatus: "passed" | "partial" | "failed";
  validationSummary: string;
};

export type ExportArtifactVersionInput = {
  workspaceId: Id;
  versionId: Id;
  relativePath: string;
};

export type CapturedArtifactVersion = {
  artifact: Artifact;
  version: ArtifactVersion;
};

export interface ArtifactWorkflowStore {
  getWorkspace(id: Id): Workspace | null;
  getArtifact(id: Id): Artifact | null;
  createArtifactWithVersion(
    artifact: CreateArtifactInput,
    version: Omit<CreateArtifactVersionInput, "artifactId" | "parentVersionId">,
    storageKey: string,
  ): CapturedArtifactVersion;
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
    await mkdir(join(this.#artifactRoot, "open"), { recursive: true, mode: 0o700 });
  }

  async captureWorkspaceFile(
    raw: CaptureWorkspaceFileInput,
  ): Promise<CapturedArtifactVersion> {
    const workspace = this.#requireWorkspace(raw.workspaceId);
    const relativePath = parseWorkspaceRelativePath(raw.relativePath);
    const sourcePath = await resolveExistingWorkspaceFile(workspace, relativePath);
    const provenance = this.#validateProvenance(workspace, raw);
    const artifact = raw.artifactId ? this.#store.getArtifact(raw.artifactId) : null;
    if (raw.artifactId && (!artifact || artifact.workspaceId !== workspace.id)) {
      throw new Error("Artifact capture target must belong to the Workspace.");
    }
    const format = captureFormat(relativePath, raw.format, artifact);
    const observedInputs = await observeWorkspaceInputs(
      workspace,
      raw.inputRelativePaths ?? [],
    );
    const captured = await this.#captureStableFile(sourcePath, workspace.id, relativePath);
    try {
      await verifyWorkspaceInputs(observedInputs);
    } catch (error) {
      await unlink(captured.stagingPath).catch(() => {});
      throw error;
    }
    return this.#publishAndRecord(captured, (storageKey) => {
      const versionInput = {
        inputs: observedInputs.map(({ version }) => version),
        source: captured.version,
        contentHash: captured.version.contentHash,
        byteSize: captured.version.byteSize,
        producedByConversationId: provenance.conversationId,
        producedByRunId: provenance.runId,
        toolchain: raw.toolchain,
        limitations: raw.limitations ?? [],
        validationStatus: "passed" as const,
        validationSummary: raw.validationSummary,
      };
      if (!artifact) {
        return this.#store.createArtifactWithVersion({
          workspaceId: workspace.id,
          title: raw.title?.trim() || basenameFromPortablePath(relativePath),
          format,
          sourceRelativePath: relativePath,
          associatedConversationId: provenance.conversationId,
        }, versionInput, storageKey);
      }
      const version = this.#store.createArtifactVersion({
        ...versionInput,
        artifactId: artifact.id,
        parentVersionId: artifact.currentVersionId,
      }, storageKey);
      return { artifact: this.#store.getArtifact(artifact.id)!, version };
    });
  }

  async exportArtifactVersion(
    raw: ExportArtifactVersionInput,
  ): Promise<WorkspaceFileVersion> {
    const workspace = this.#requireWorkspace(raw.workspaceId);
    const relativePath = parseWorkspaceRelativePath(raw.relativePath);
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
    await ensureWorkspaceParentDirectory(workspaceRoot, destinationPath);
    return this.#withPathLock(pathLockKey(destinationPath), async () => {
      const before = await optionalWorkspaceFileVersion(
        workspaceRoot,
        destinationPath,
        workspace.id,
        relativePath,
      );
      if (before) {
        throw new WorkspaceFileConflictError(
          relativePath,
          "Artifact export requires a new Workspace path; the target already exists.",
        );
      }
      const tempPath = join(dirname(destinationPath), `.scopeguard-${randomUUID()}.tmp`);
      try {
        await copyFile(blobPath, tempPath, constants.COPYFILE_EXCL);
        const candidate = await hashRegularFile(tempPath);
        if (candidate.contentHash !== version.contentHash || candidate.byteSize !== version.byteSize) {
          throw new Error("Artifact export candidate failed its content identity check.");
        }
        const current = await optionalWorkspaceFileVersion(
          workspaceRoot,
          destinationPath,
          workspace.id,
          relativePath,
        );
        if (current) {
          throw new WorkspaceFileConflictError(
            relativePath,
            "Workspace File appeared before Artifact export could publish it.",
          );
        }
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
        const published = await optionalWorkspaceFileVersion(
          workspaceRoot,
          destinationPath,
          workspace.id,
          relativePath,
        );
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

  async prepareArtifactVersionOpen(versionId: Id): Promise<string> {
    const version = this.#store.getArtifactVersion(versionId);
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`);
    const artifact = this.#store.getArtifact(version.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${version.artifactId}`);
    const storageKey = this.#store.getArtifactVersionStorageKey(version.id);
    if (!storageKey) throw new Error("Artifact Version content is unavailable.");
    const blobPath = resolveStorageKey(this.#artifactRoot, storageKey);
    const blob = await hashRegularFile(blobPath);
    if (blob.contentHash !== version.contentHash || blob.byteSize !== version.byteSize) {
      throw new Error("Artifact Version content failed its stored identity check.");
    }

    const openDirectory = join(this.#artifactRoot, "open", version.id, randomUUID());
    await mkdir(openDirectory, { recursive: true, mode: 0o700 });
    const outputPath = join(openDirectory, externalOpenFileName(artifact));
    await copyFile(blobPath, outputPath, constants.COPYFILE_EXCL);
    const output = await hashRegularFile(outputPath);
    if (output.contentHash !== version.contentHash || output.byteSize !== version.byteSize) {
      await unlink(outputPath).catch(() => {});
      throw new Error("External-open copy failed its Artifact Version identity check.");
    }
    return outputPath;
  }

  #requireWorkspace(id: Id): Workspace {
    const workspace = this.#store.getWorkspace(id);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);
    return workspace;
  }

  #validateProvenance(
    workspace: Workspace,
    input: CaptureWorkspaceFileInput,
  ): { conversationId: Id; runId: Id } {
    if (input.validationStatus !== "passed") {
      throw new Error("Only an output with passed validation may become an Artifact Version.");
    }
    const conversationId = input.producedByConversationId;
    const runId = input.producedByRunId;
    if (!conversationId || !runId) {
      throw new Error("Every Artifact Version requires a confirmed producing Run and Conversation.");
    }
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation || conversation.workspaceId !== workspace.id) {
      throw new Error("Artifact producer Conversation must belong to the Workspace.");
    }
    const run = this.#store.getRun(runId);
    if (!run || run.status !== "completed" || run.effect !== "confirmed") {
      throw new Error("Only a completed Run with confirmed Tool effects may produce an Artifact Version.");
    }
    const owner = this.#store.getConversation(run.conversationId);
    if (!owner || owner.workspaceId !== workspace.id || conversation.id !== owner.id) {
      throw new Error("Artifact producer Run must match its Workspace and Conversation.");
    }
    return { conversationId: owner.id, runId: run.id };
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

  async #publishAndRecord(
    captured: { stagingPath: string; version: WorkspaceFileVersion },
    record: (storageKey: string) => CapturedArtifactVersion,
  ): Promise<CapturedArtifactVersion> {
    const storageKey = `${captured.version.contentHash.slice(0, 2)}/${captured.version.contentHash}`;
    const destination = resolveStorageKey(this.#artifactRoot, storageKey);
    return this.#withPathLock(destination, async () => {
      const published = await this.#publishBlob(captured.stagingPath, captured.version);
      try {
        return record(published.storageKey);
      } catch (error) {
        if (published.created) {
          try {
            await unlink(published.destination);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Artifact publication failed and its unreferenced Blob could not be removed.",
            );
          }
        }
        throw error;
      }
    });
  }

  async #publishBlob(
    stagingPath: string,
    version: WorkspaceFileVersion,
  ): Promise<{ storageKey: string; destination: string; created: boolean }> {
    const storageKey = `${version.contentHash.slice(0, 2)}/${version.contentHash}`;
    const destination = resolveStorageKey(this.#artifactRoot, storageKey);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      await link(stagingPath, destination);
      created = true;
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
    return { storageKey, destination, created };
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

async function observeWorkspaceInputs(
  workspace: Workspace,
  relativePaths: readonly string[],
): Promise<Array<{ path: string; version: WorkspaceFileVersion }>> {
  if (relativePaths.length > 64) {
    throw new Error("Artifact capture accepts at most 64 input Workspace Files.");
  }
  const paths = relativePaths.map(parseWorkspaceRelativePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Artifact input Workspace File paths must not contain duplicates.");
  }
  return await Promise.all(paths.map(async (relativePath) => {
    const path = await resolveExistingWorkspaceFile(workspace, relativePath);
    return {
      path,
      version: {
        workspaceId: workspace.id,
        relativePath,
        ...await hashRegularFile(path),
      },
    };
  }));
}

async function verifyWorkspaceInputs(
  observed: ReadonlyArray<{ path: string; version: WorkspaceFileVersion }>,
): Promise<void> {
  for (const input of observed) {
    let current: { contentHash: string; byteSize: number };
    try {
      current = await hashRegularFile(input.path);
    } catch (error) {
      throw new WorkspaceFileConflictError(
        input.version.relativePath,
        `Artifact input Workspace File became unavailable while its result was captured: ${messageFromError(error)}`,
      );
    }
    if (
      current.contentHash !== input.version.contentHash ||
      current.byteSize !== input.version.byteSize
    ) {
      throw new WorkspaceFileConflictError(
        input.version.relativePath,
        "Artifact input Workspace File changed while its result was being captured.",
      );
    }
  }
}

async function ensureWorkspaceParentDirectory(
  root: string,
  destinationPath: string,
): Promise<void> {
  assertInside(root, destinationPath, "Workspace export path resolves outside its Workspace.");
  const segments = relative(root, destinationPath).split(sep).slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("Workspace export directory must not be a symbolic link.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Workspace export parent must be a directory.");
    }
    assertInside(
      root,
      await realpath(current),
      "Workspace export directory resolves outside its Workspace.",
    );
  }
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

async function optionalWorkspaceFileVersion(
  root: string,
  path: string,
  workspaceId: Id,
  relativePath: string,
): Promise<WorkspaceFileVersion | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Workspace export target must not be a symbolic link.");
    }
    assertInside(
      root,
      await realpath(path),
      "Workspace export target resolves outside its Workspace.",
    );
    const value = await hashRegularFile(path);
    return { workspaceId, relativePath, ...value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function captureFormat(
  relativePath: string,
  declaredFormat: string | undefined,
  artifact: Artifact | null,
): string {
  const pathFormat = parseArtifactFormat(formatFromPath(relativePath));
  const format = parseArtifactFormat(declaredFormat ?? pathFormat);
  if (pathFormat !== "file" && format !== pathFormat) {
    throw new Error("Artifact format must match the Workspace File extension.");
  }
  if (artifact && artifact.format !== format) {
    throw new Error("A new Artifact Version format must match its Artifact.");
  }
  return format;
}

function pathLockKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function basenameFromPortablePath(relativePath: string): string {
  return relativePath.split("/").at(-1)!;
}

function externalOpenFileName(artifact: Artifact): string {
  const preferred = artifact.sourceRelativePath
    ? basenameFromPortablePath(artifact.sourceRelativePath)
    : artifact.title;
  const safe = preferred
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180) || "artifact";
  if (extname(safe)) return safe;
  const extension = /^[a-z0-9]{1,16}$/.test(artifact.format) ? artifact.format : "bin";
  return `${safe}.${extension}`;
}
