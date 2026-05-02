import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { StackInfo } from "./types.js";

const FRAMEWORK_KEYS = [
  "next",
  "react",
  "vue",
  "svelte",
  "express",
  "fastify",
  "nestjs",
  "@nestjs/core",
  "prisma",
  "drizzle",
  "vite",
  "typescript",
  "tailwindcss",
] as const;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
};

export function detectPackageManager(gitRoot: string): string {
  if (existsSync(join(gitRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(join(gitRoot, "yarn.lock"))) {
    return "yarn";
  }

  if (existsSync(join(gitRoot, "package-lock.json"))) {
    return "npm";
  }

  if (existsSync(join(gitRoot, "bun.lockb"))) {
    return "bun";
  }

  return "unknown";
}

export function detectStack(gitRoot: string, sourceFiles: string[]): StackInfo {
  const packageManager = detectPackageManager(gitRoot);
  const packageJsonPath = join(gitRoot, "package.json");

  const frameworks = new Set<string>();
  if (existsSync(packageJsonPath)) {
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };

    for (const key of FRAMEWORK_KEYS) {
      if (deps[key]) {
        frameworks.add(key);
      }
    }
  }

  const languages = new Set<string>();
  for (const filePath of sourceFiles) {
    const ext = extname(filePath);
    const language = LANGUAGE_BY_EXT[ext];
    if (language) {
      languages.add(language);
    }
  }

  return {
    languages: Array.from(languages).sort(),
    frameworks: Array.from(frameworks).sort(),
    packageManager,
  };
}