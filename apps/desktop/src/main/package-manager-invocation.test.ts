import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preparePnpmInvocation } from "./package-manager-invocation.js";

test("pnpm staging keeps Windows metacharacters in one argv value", async () => {
  const fixture = await createPnpmFixture();
  const runtimePath = String.raw`C:\Scope Guard & Review (Phase 2)\runtime`;
  try {
    assert.deepEqual(preparePnpmInvocation({
      args: ["--dir", runtimePath, "install", "--frozen-lockfile"],
      nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
      pnpmEntryPath: fixture.entryPath,
    }), {
      command: String.raw`C:\Program Files\nodejs\node.exe`,
      args: [
        fixture.entryPath,
        "--dir",
        runtimePath,
        "install",
        "--frozen-lockfile",
      ],
    });
  } finally {
    await fixture.dispose();
  }
});

test("pnpm staging rejects a missing or untrusted JS entry", async () => {
  const missing = join(tmpdir(), `scopeguard-missing-pnpm-${process.pid}.cjs`);
  assert.throws(
    () => preparePnpmInvocation({ args: [], pnpmEntryPath: missing }),
    /trusted pnpm entry is unavailable/,
  );

  const fixture = await createPnpmFixture("11.0.0");
  try {
    assert.throws(
      () => preparePnpmInvocation({
        args: [],
        pnpmEntryPath: join(fixture.entryPath, ".."),
      }),
      /trusted pnpm entry is unavailable/,
    );
    assert.throws(
      () => preparePnpmInvocation({
        args: [],
        pnpmEntryPath: fixture.entryPath,
      }),
      /untrusted package/,
    );
  } finally {
    await fixture.dispose();
  }
});

test("pnpm staging resolves the pinned workspace package through Node", () => {
  const invocation = preparePnpmInvocation({ args: ["--version"] });
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0] ?? "", /pnpm\.cjs$/);
  assert.deepEqual(invocation.args.slice(1), ["--version"]);
});

async function createPnpmFixture(version = "10.0.0"): Promise<{
  entryPath: string;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-pnpm-entry-"));
  const packageRoot = join(root, "pnpm");
  const bin = join(packageRoot, "bin");
  const entryPath = join(bin, "pnpm.cjs");
  await mkdir(bin, { recursive: true });
  await writeFile(entryPath, "// fixture\n");
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "pnpm",
    version,
    bin: { pnpm: "bin/pnpm.cjs" },
  })}\n`);
  return {
    entryPath: await realpath(entryPath),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
