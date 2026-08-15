import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage } from "@electron/asar";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const unpackedRoot = process.argv[2] ?? join(desktopRoot, "release", "win-unpacked");
const executable = join(unpackedRoot, "ScopeGuard.exe");
const asarPath = join(unpackedRoot, "resources", "app.asar");
const executableBytes = await readFile(executable);
const asarBytes = await readFile(asarPath);
const entries = listPackage(asarPath, { isPack: false })
  .map((path) => path.replace(/^[/\\]+/, "").replaceAll("\\", "/"));

for (const required of [
  "package.json",
  "dist/main.js",
  "dist/agent-host.js",
  "dist/preload.cjs",
  "dist-renderer/index.html",
]) {
  if (!entries.includes(required)) {
    throw new Error(`Built ASAR is missing ${required}.`);
  }
}
if (entries.some((path) => path.endsWith(".map") || path.includes("/src/"))) {
  throw new Error("Built ASAR contains source maps or source files.");
}

const packageJson = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
if (packageJson.main !== "dist/main.js" || packageJson.type !== "module") {
  throw new Error("Built ASAR package metadata is invalid.");
}

console.log(JSON.stringify({
  unpackedRoot,
  executableSha256: sha256(executableBytes),
  asarSha256: sha256(asarBytes),
  asarEntryCount: entries.length,
  managedExecutionIncluded: false,
}, null, 2));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
