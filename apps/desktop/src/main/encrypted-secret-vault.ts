import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { SafeStorage } from "electron";

type SecretFile = {
  version: 1;
  entries: Record<string, string>;
};

export class EncryptedSecretVault {
  readonly #filePath: string;
  readonly #safeStorage: Pick<
    SafeStorage,
    | "decryptString"
    | "encryptString"
    | "getSelectedStorageBackend"
    | "isEncryptionAvailable"
  >;
  readonly #platform: NodeJS.Platform;
  #operationQueue: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    options: {
      safeStorage: Pick<
        SafeStorage,
        | "decryptString"
        | "encryptString"
        | "getSelectedStorageBackend"
        | "isEncryptionAvailable"
      >;
      platform?: NodeJS.Platform;
    },
  ) {
    this.#filePath = filePath;
    this.#safeStorage = options.safeStorage;
    this.#platform = options.platform ?? process.platform;
  }

  async put(reference: string, secret: string): Promise<string> {
    return this.#enqueue(async () => {
      this.#assertSecureStorage();
      const file = await this.#read();
      file.entries[reference] = this.#safeStorage
        .encryptString(secret)
        .toString("base64");
      await this.#write(file);
      return reference;
    });
  }

  async get(reference: string): Promise<string | null> {
    return this.#enqueue(async () => {
      const file = await this.#read();
      const encoded = file.entries[reference];
      if (!encoded) {
        return null;
      }
      this.#assertSecureStorage();
      try {
        return this.#safeStorage.decryptString(Buffer.from(encoded, "base64"));
      } catch {
        throw new Error("Stored provider credentials could not be decrypted.");
      }
    });
  }

  async delete(reference: string): Promise<void> {
    await this.#enqueue(async () => {
      const file = await this.#read();
      if (!(reference in file.entries)) {
        return;
      }
      delete file.entries[reference];
      await this.#write(file);
    });
  }

  async #read(): Promise<SecretFile> {
    try {
      const contents = await readFile(this.#filePath, "utf8");
      const parsed: unknown = JSON.parse(contents);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).version === 1
      ) {
        const entries = (parsed as Record<string, unknown>).entries;
        if (entries && typeof entries === "object" && !Array.isArray(entries)) {
          return {
            version: 1,
            entries: Object.fromEntries(
              Object.entries(entries).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          };
        }
      }
      throw new Error("Credential file has an unsupported format.");
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  async #write(file: SecretFile): Promise<void> {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#filePath);
      await chmod(this.#filePath, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  #assertSecureStorage(): void {
    if (!this.#safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Secure credential storage is not available on this operating system.",
      );
    }
    if (
      this.#platform === "linux"
      && this.#safeStorage.getSelectedStorageBackend() === "basic_text"
    ) {
      throw new Error(
        "Electron basic_text credential storage is not secure enough for provider secrets.",
      );
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue
      .catch(() => {})
      .then(operation);
    this.#operationQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
