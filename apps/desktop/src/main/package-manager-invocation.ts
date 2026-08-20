import { realpathSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

const PNPM_VERSION = "10.0.0";
const PNPM_ENTRY = join("bin", "pnpm.cjs");
const resolvePackage = createRequire(import.meta.url);

export function preparePnpmInvocation(options: {
  args: readonly string[];
  nodePath?: string;
  pnpmEntryPath?: string;
}): { args: string[]; command: string } {
  const entryPath = validatePnpmEntry(
    options.pnpmEntryPath ?? resolveInstalledPnpmEntry(),
  );
  return {
    command: options.nodePath ?? process.execPath,
    args: [entryPath, ...options.args],
  };
}

function resolveInstalledPnpmEntry(): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = resolvePackage.resolve("pnpm");
  } catch (error) {
    throw new Error("The trusted pnpm package is unavailable.", { cause: error });
  }
  return join(dirname(packageJsonPath), PNPM_ENTRY);
}

function validatePnpmEntry(candidate: string): string {
  if (!isAbsolute(candidate)) {
    throw new Error("The trusted pnpm entry must be an absolute path.");
  }
  let entryPath: string;
  try {
    entryPath = realpathSync(candidate);
    if (!statSync(entryPath).isFile()) {
      throw new Error("The resolved pnpm entry is not a file.");
    }
  } catch (error) {
    throw new Error(`The trusted pnpm entry is unavailable at ${candidate}.`, {
      cause: error,
    });
  }

  const packageRoot = dirname(dirname(entryPath));
  let packageJson: {
    name?: unknown;
    version?: unknown;
    bin?: { pnpm?: unknown };
  };
  try {
    packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as typeof packageJson;
  } catch (error) {
    throw new Error("The trusted pnpm package metadata is unavailable.", {
      cause: error,
    });
  }
  if (
    packageJson.name !== "pnpm" ||
    packageJson.version !== PNPM_VERSION ||
    packageJson.bin?.pnpm !== "bin/pnpm.cjs"
  ) {
    throw new Error("The resolved pnpm entry belongs to an untrusted package.");
  }
  const declaredEntry = realpathSync(join(packageRoot, packageJson.bin.pnpm));
  if (declaredEntry !== entryPath) {
    throw new Error("The resolved pnpm entry does not match package metadata.");
  }
  return entryPath;
}
