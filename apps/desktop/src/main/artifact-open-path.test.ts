import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateArtifactOpenPath } from "./artifact-open-path.js";

test("accepts only a regular file inside the Artifact open directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-artifact-open-"));
  try {
    const openRoot = join(root, "open");
    const versionDirectory = join(openRoot, "version", "copy");
    await mkdir(versionDirectory, { recursive: true });
    const file = join(versionDirectory, "report.docx");
    await writeFile(file, "artifact bytes\n", "utf8");
    assert.equal(await validateArtifactOpenPath(file, root), await realpath(file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects paths outside open storage, including blobs and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-artifact-open-"));
  try {
    const openRoot = join(root, "open");
    const blobRoot = join(root, "blobs", "aa");
    await mkdir(openRoot, { recursive: true });
    await mkdir(blobRoot, { recursive: true });
    const blob = join(blobRoot, "content");
    await writeFile(blob, "immutable bytes\n", "utf8");
    await assert.rejects(validateArtifactOpenPath(blob, root), /open directory/i);

    const link = join(openRoot, "outside.docx");
    await symlink(blob, link);
    await assert.rejects(validateArtifactOpenPath(link, root), /symbolic link|open directory/i);
    await assert.rejects(validateArtifactOpenPath(root, root), /regular file|open directory/i);
    await assert.rejects(validateArtifactOpenPath("relative.docx", root), /absolute/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
