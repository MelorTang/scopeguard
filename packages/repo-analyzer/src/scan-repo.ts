import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScannedRepo } from "./types.js";

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".agentboard",
  ".scopeguard",
  "coverage",
  ".cache",
  "turbo",
]);

const AREA_NAMES = new Set([
  "app",
  "src",
  "packages",
  "components",
  "lib",
  "server",
  "api",
  "tests",
  "test",
  "docs",
  "scripts",
]);

export function scanRepo(gitRoot: string): ScannedRepo {
  const allFiles: string[] = [];
  const sourceFiles: string[] = [];

  walkFiles(gitRoot, "", allFiles, sourceFiles);

  return {
    allFiles,
    sourceFiles,
    areaPaths: collectAreaPaths(gitRoot),
  };
}

function walkFiles(gitRoot: string, relativeDir: string, allFiles: string[], sourceFiles: string[]): void {
  const currentDir = join(gitRoot, relativeDir);

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      if (!SKIP_DIRS.has(entry.name)) {
        // allow hidden files but continue hidden directories only if not explicitly skipped
      }
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const childRel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      walkFiles(gitRoot, childRel, allFiles, sourceFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileRelPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    allFiles.push(fileRelPath);

    const ext = entry.name.includes(".") ? `.${entry.name.split(".").pop() ?? ""}` : "";
    if (SCANNABLE_EXTENSIONS.has(ext)) {
      sourceFiles.push(fileRelPath);
    }
  }
}

function collectAreaPaths(gitRoot: string): string[] {
  const areaPaths = new Set<string>();
  const levelOneDirs = listChildDirs(gitRoot);

  for (const levelOne of levelOneDirs) {
    if (AREA_NAMES.has(levelOne)) {
      areaPaths.add(levelOne);
    }

    const levelOneAbs = join(gitRoot, levelOne);
    const levelTwoDirs = listChildDirs(levelOneAbs);
    for (const levelTwo of levelTwoDirs) {
      if (AREA_NAMES.has(levelTwo)) {
        areaPaths.add(`${levelOne}/${levelTwo}`);
      }
    }
  }

  return Array.from(areaPaths).sort();
}

function listChildDirs(dirPath: string): string[] {
  const dirs: string[] = [];

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    try {
      const childPath = join(dirPath, entry.name);
      if (statSync(childPath).isDirectory()) {
        dirs.push(entry.name);
      }
    } catch {
      // ignore unreadable entries
    }
  }

  return dirs;
}
