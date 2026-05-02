import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildDependencyGraph } from "./dependency-graph.js";
import { detectStack } from "./detect-stack.js";
import { scanRepo } from "./scan-repo.js";
import type { CodeArea, ProjectConfig, ProjectMap } from "./types.js";

export function buildProjectMap(gitRoot: string, dataDirName = ".agentboard"): ProjectMap {
  const configPath = join(gitRoot, dataDirName, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${dataDirName}/config.json. Run \`scopeguard init\` (or \`agentboard init\`) first.`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8")) as ProjectConfig;
  const scanned = scanRepo(gitRoot);
  const stack = detectStack(gitRoot, scanned.sourceFiles);
  const dependencyGraph = buildDependencyGraph(gitRoot, scanned.sourceFiles);
  const areas = buildAreas(scanned.areaPaths, scanned.allFiles, dependencyGraph);

  const map: ProjectMap = {
    projectId: config.projectId,
    generatedAt: new Date().toISOString(),
    rootPath: normalizePath(gitRoot),
    summary: `Detected ${areas.length} areas, ${scanned.sourceFiles.length} source files, and ${dependencyGraph.length} dependency edges.`,
    stack,
    areas,
    dependencyGraph,
  };

  const outputPath = join(gitRoot, dataDirName, "project-map.json");
  writeFileSync(outputPath, `${JSON.stringify(map, null, 2)}\n`, "utf-8");

  return map;
}

function buildAreas(areaPaths: string[], allFiles: string[], edges: ProjectMap["dependencyGraph"]): CodeArea[] {
  return areaPaths.map((areaPath) => {
    const areaFiles = allFiles.filter((file) => file === areaPath || file.startsWith(`${areaPath}/`));
    const areaEdges = edges.filter((edge) => edge.from === areaPath || edge.from.startsWith(`${areaPath}/`));

    const externalDeps = new Set(
      areaEdges
        .map((edge) => edge.to)
        .filter((dep) => !dep.startsWith("."))
        .map((dep) => dep.split("/")[0] ?? dep),
    );

    const relatedTests = areaFiles.filter(
      (file) => file.includes("/test") || file.includes("/tests") || file.endsWith(".test.ts") || file.endsWith(".spec.ts"),
    );

    const riskLevel = areaFiles.length > 150 ? "high" : areaFiles.length > 40 ? "medium" : "low";

    return {
      id: areaPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, ""),
      name: basename(areaPath),
      paths: [areaPath],
      summary: `${areaFiles.length} files detected under ${areaPath}.`,
      dependencies: Array.from(externalDeps).sort(),
      relatedTests,
      riskLevel,
    };
  });
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
