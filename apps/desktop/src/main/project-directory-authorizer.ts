import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

type DirectoryAuthorization = {
  rootPath: string;
  expiresAt: number;
};

export class ProjectDirectoryAuthorizer {
  readonly #authorizations = new Map<number, DirectoryAuthorization>();
  readonly #authorizationTtlMs: number;
  readonly #now: () => number;

  constructor(options?: {
    authorizationTtlMs?: number;
    now?: () => number;
  }) {
    this.#authorizationTtlMs = options?.authorizationTtlMs ?? 120_000;
    this.#now = options?.now ?? Date.now;
  }

  authorize(senderId: number, rootPath: string): void {
    this.#authorizations.set(senderId, {
      rootPath,
      expiresAt: this.#now() + this.#authorizationTtlMs,
    });
  }

  revoke(senderId: number): void {
    this.#authorizations.delete(senderId);
  }

  async consume(senderId: number, submittedPath: string): Promise<string> {
    const authorization = this.#authorizations.get(senderId);
    this.#authorizations.delete(senderId);

    if (!authorization || authorization.expiresAt < this.#now()) {
      throw new Error(
        "Project directory authorization is missing or expired. Choose the folder again.",
      );
    }

    const canonicalPath = await canonicalizeProjectDirectory(submittedPath);
    if (canonicalPath !== authorization.rootPath) {
      throw new Error(
        "The submitted project directory does not match the folder just selected.",
      );
    }
    return canonicalPath;
  }
}

export async function canonicalizeProjectDirectory(
  inputPath: string,
): Promise<string> {
  if (!isAbsolute(inputPath)) {
    throw new Error("Project directory must be an absolute path.");
  }

  const canonicalPath = await realpath(resolve(inputPath));
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new Error("Project path must reference an existing directory.");
  }
  if (canonicalPath === parse(canonicalPath).root) {
    throw new Error("The filesystem root cannot be registered as a project.");
  }
  return canonicalPath;
}
