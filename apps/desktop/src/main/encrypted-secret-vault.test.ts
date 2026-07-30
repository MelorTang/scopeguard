import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { EncryptedSecretVault } from "./encrypted-secret-vault.js";

test("serializes concurrent read-modify-write operations without losing secrets", async () => {
  const fixture = await createVaultFixture();
  try {
    await Promise.all([
      fixture.vault.put("provider:first", "first-secret"),
      fixture.vault.put("provider:second", "second-secret"),
    ]);

    assert.equal(await fixture.vault.get("provider:first"), "first-secret");
    assert.equal(await fixture.vault.get("provider:second"), "second-secret");
    assert.deepEqual(
      (await readdir(fixture.directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a failed vault operation does not poison subsequent writes", async () => {
  let shouldFail = true;
  const fixture = await createVaultFixture({
    encryptString(value) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("injected encryption failure");
      }
      return Buffer.from(value, "utf8");
    },
  });
  try {
    await assert.rejects(
      fixture.vault.put("provider:failed", "secret"),
      /injected encryption failure/,
    );
    await fixture.vault.put("provider:healthy", "next-secret");
    assert.equal(await fixture.vault.get("provider:healthy"), "next-secret");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects Electron basic_text storage on Linux", async () => {
  const fixture = await createVaultFixture(
    {
      getSelectedStorageBackend: () => "basic_text",
    },
    "linux",
  );
  try {
    await assert.rejects(
      fixture.vault.put("provider:test", "secret"),
      /basic_text/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createVaultFixture(
  overrides: Partial<{
    decryptString: (encrypted: Buffer) => string;
    encryptString: (plainText: string) => Buffer;
    getSelectedStorageBackend: () =>
      | "basic_text"
      | "gnome_libsecret"
      | "kwallet"
      | "kwallet5"
      | "kwallet6"
      | "unknown";
    isEncryptionAvailable: () => boolean;
  }> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<{
  directory: string;
  vault: EncryptedSecretVault;
}> {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-vault-"));
  const storage = {
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
    encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
    getSelectedStorageBackend: () => "gnome_libsecret" as const,
    isEncryptionAvailable: () => true,
    ...overrides,
  };
  return {
    directory,
    vault: new EncryptedSecretVault(join(directory, "providers.json"), {
      safeStorage: storage,
      platform,
    }),
  };
}
