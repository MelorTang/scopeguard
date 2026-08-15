import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateWorkspaceFileSelection } from "./workspace-file-selection.js";

test("returns portable relative paths for files inside a Workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-workspace-files-"));
  try {
    const nested = join(root, "docs");
    const filePath = join(nested, "brief.md");
    await mkdir(nested);
    await writeFile(filePath, "brief");

    assert.deepEqual(
      await validateWorkspaceFileSelection(root, [filePath]),
      [{ name: "brief.md", relativePath: "docs/brief.md" }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects outside files and symlinks that escape the Workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-workspace-root-"));
  const outside = await mkdtemp(join(tmpdir(), "scopeguard-workspace-outside-"));
  try {
    const outsideFile = join(outside, "secret.txt");
    const linkPath = join(root, "linked-secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, linkPath);

    await assert.rejects(
      validateWorkspaceFileSelection(root, [outsideFile]),
      /inside the current Workspace/,
    );
    await assert.rejects(
      validateWorkspaceFileSelection(root, [linkPath]),
      /inside the current Workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
