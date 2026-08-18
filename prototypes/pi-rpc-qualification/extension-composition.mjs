import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROLES = new Set(["registration", "mutator", "policy"]);

export function validateExtensionComposition(entries) {
  assert.ok(
    Array.isArray(entries) && entries.length > 0,
    "empty extension composition",
  );
  const ids = new Set();
  for (const entry of entries) {
    assert.equal(typeof entry.id, "string", "extension id must be a string");
    assert.equal(
      ids.has(entry.id),
      false,
      `duplicate extension id: ${entry.id}`,
    );
    ids.add(entry.id);
    assert.ok(
      ROLES.has(entry.toolCallRole),
      `invalid extension role: ${entry.toolCallRole}`,
    );
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  const policies = entries.filter((entry) => entry.toolCallRole === "policy");
  assert.equal(
    policies.length,
    1,
    "exactly one Tool policy extension is required",
  );
  assert.equal(
    entries.at(-1).toolCallRole,
    "policy",
    "Tool policy extension must be final",
  );
  return entries;
}

export function resolveExtensionProfile(manifest, profile) {
  assert.equal(manifest.version, 1, "unsupported extension manifest version");
  const profileIds = manifest.profiles?.[profile];
  assert.ok(Array.isArray(profileIds), `unknown extension profile: ${profile}`);
  return profileIds.map((id) => {
    const declared = manifest.extensions?.[id];
    assert.ok(declared, `unapproved extension id: ${id}`);
    return { id, ...declared };
  });
}

export async function verifyExtensionFiles(entries, root) {
  for (const entry of entries) {
    const controlledFiles = [
      { path: entry.path, sha256: entry.sha256, entrypoint: true },
      ...(entry.dependencies ?? []),
    ];
    for (const controlled of controlledFiles) {
      assert.match(controlled.sha256, /^[0-9a-f]{64}$/);
      const absolutePath = path.resolve(root, controlled.path);
      assert.equal(
        absolutePath.startsWith(`${path.resolve(root)}${path.sep}`),
        true,
        `extension escapes root: ${controlled.path}`,
      );
      const actualSha256 = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
      assert.equal(
        actualSha256,
        controlled.sha256,
        `extension hash mismatch: ${entry.id}:${controlled.path}`,
      );
      if (controlled.entrypoint) entry.absolutePath = absolutePath;
    }
  }
  return entries;
}

export async function loadExtensionComposition({
  manifestPath,
  root,
  profile,
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = resolveExtensionProfile(manifest, profile);
  validateExtensionComposition(entries);
  return verifyExtensionFiles(entries, root);
}

export function extensionArgs(entries) {
  return entries.flatMap((entry) => ["--extension", entry.absolutePath]);
}
