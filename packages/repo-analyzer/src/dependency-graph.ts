import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DependencyEdge } from "./types.js";

const IMPORT_FROM_REGEX = /import\s+[^"'\n]*?from\s+["']([^"']+)["']/g;
const IMPORT_BARE_REGEX = /import\s+["']([^"']+)["']/g;
const REQUIRE_REGEX = /require\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT_REGEX = /import\(\s*["']([^"']+)["']\s*\)/g;

export function buildDependencyGraph(gitRoot: string, files: string[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const file of files) {
    const absPath = join(gitRoot, file);
    let content = "";

    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    edges.push(...extractEdges(file, content));
  }

  return dedupeEdges(edges);
}

function extractEdges(from: string, content: string): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const match of content.matchAll(IMPORT_FROM_REGEX)) {
    if (match[1]) {
      edges.push({ from, to: match[1], type: "import" });
    }
  }

  for (const match of content.matchAll(IMPORT_BARE_REGEX)) {
    if (match[1]) {
      edges.push({ from, to: match[1], type: "import" });
    }
  }

  for (const match of content.matchAll(REQUIRE_REGEX)) {
    if (match[1]) {
      edges.push({ from, to: match[1], type: "require" });
    }
  }

  for (const match of content.matchAll(DYNAMIC_IMPORT_REGEX)) {
    if (match[1]) {
      edges.push({ from, to: match[1], type: "dynamic" });
    }
  }

  return edges;
}

function dedupeEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const seen = new Set<string>();
  const deduped: DependencyEdge[] = [];

  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(edge);
  }

  return deduped;
}