import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { parse, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  canonicalizeProjectDirectory,
  ProjectDirectoryAuthorizer,
} from "./project-directory-authorizer.js";

test("consumes a picker authorization once for the same canonical directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-project-"));
  try {
    const canonicalPath = await canonicalizeProjectDirectory(directory);
    const authorizer = new ProjectDirectoryAuthorizer();
    authorizer.authorize(42, canonicalPath);

    assert.equal(await authorizer.consume(42, directory), canonicalPath);
    await assert.rejects(
      authorizer.consume(42, directory),
      /missing or expired/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mismatched and expired authorizations fail closed and are consumed", async () => {
  const first = await mkdtemp(join(tmpdir(), "scopeguard-project-a-"));
  const second = await mkdtemp(join(tmpdir(), "scopeguard-project-b-"));
  try {
    let now = 100;
    const authorizer = new ProjectDirectoryAuthorizer({
      authorizationTtlMs: 10,
      now: () => now,
    });
    authorizer.authorize(7, await canonicalizeProjectDirectory(first));
    await assert.rejects(authorizer.consume(7, second), /does not match/);
    await assert.rejects(authorizer.consume(7, first), /missing or expired/);

    authorizer.authorize(7, await canonicalizeProjectDirectory(first));
    now = 111;
    await assert.rejects(authorizer.consume(7, first), /missing or expired/);
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

test("canonicalization rejects files, relative paths, and filesystem root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-project-"));
  const filePath = join(directory, "file.txt");
  await writeFile(filePath, "not a directory");
  try {
    await assert.rejects(
      canonicalizeProjectDirectory("relative/project"),
      /absolute path/,
    );
    await assert.rejects(
      canonicalizeProjectDirectory(filePath),
      /existing directory/,
    );
    await assert.rejects(
      canonicalizeProjectDirectory(parse(directory).root),
      /filesystem root/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
