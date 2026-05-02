import { existsSync } from "node:fs";
import { join } from "node:path";

export type DataDirName = ".scopeguard" | ".agentboard";

export type DataDirResolution = {
  dataDir: string;
  dataDirName: DataDirName;
  compatibilityMode: boolean;
};

export function resolveDataDir(gitRoot: string): DataDirResolution {
  const scopeguardDir = join(gitRoot, ".scopeguard");
  const agentboardDir = join(gitRoot, ".agentboard");

  if (existsSync(scopeguardDir)) {
    return {
      dataDir: scopeguardDir,
      dataDirName: ".scopeguard",
      compatibilityMode: false,
    };
  }

  if (existsSync(agentboardDir)) {
    return {
      dataDir: agentboardDir,
      dataDirName: ".agentboard",
      compatibilityMode: true,
    };
  }

  return {
    dataDir: scopeguardDir,
    dataDirName: ".scopeguard",
    compatibilityMode: false,
  };
}

export function dataPath(gitRoot: string, ...parts: string[]): string {
  const resolved = resolveDataDir(gitRoot);
  return join(resolved.dataDir, ...parts);
}

