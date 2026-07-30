import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preparePrivateDataDirectory } from "./private-data-directory.js";

test("creates a private application data directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not meaningful on Windows.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "scopeguard-private-data-"));
  const directory = join(root, "nested", "data");
  try {
    await preparePrivateDataDirectory(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tightens an existing application data directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not meaningful on Windows.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "scopeguard-private-data-"));
  try {
    await chmod(directory, 0o755);
    await preparePrivateDataDirectory(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
