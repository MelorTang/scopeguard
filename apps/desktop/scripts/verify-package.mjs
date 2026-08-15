import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = join(desktopRoot, ".package", "app");
const files = await listFiles(stageRoot);
const paths = new Set(files.map((path) => relative(stageRoot, path).split(sep).join("/")));

for (const required of [
  "package.json",
  "dist/main.js",
  "dist/agent-host.js",
  "dist/preload.cjs",
  "dist-renderer/index.html",
]) {
  if (!paths.has(required)) {
    throw new Error(`Package staging is missing ${required}.`);
  }
}

const forbiddenPatterns = [
  /(^|\/)src\//,
  /(^|\/)test(s)?\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.map$/,
  /(^|\/)\.env(?:\.|$)/,
  /(?:^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /\.(?:pfx|p12|pem|key)$/i,
];
for (const path of paths) {
  if (forbiddenPatterns.some((pattern) => pattern.test(path))) {
    throw new Error(`Package staging contains forbidden file ${path}.`);
  }
  if (
    path !== "package.json" &&
    !path.startsWith("dist/") &&
    !path.startsWith("dist-renderer/")
  ) {
    throw new Error(`Package staging contains unexpected file ${path}.`);
  }
}

const packageJson = JSON.parse(await readFile(join(stageRoot, "package.json"), "utf8"));
if (
  packageJson.main !== "dist/main.js" ||
  packageJson.type !== "module" ||
  Object.hasOwn(packageJson, "dependencies") ||
  Object.hasOwn(packageJson, "devDependencies")
) {
  throw new Error("Package metadata does not describe the self-contained bundle.");
}

const repositoryRoot = join(desktopRoot, "..", "..");
for (const bundledFile of ["dist/main.js", "dist/agent-host.js"]) {
  const source = await readFile(join(stageRoot, bundledFile), "utf8");
  if (/\b(?:from|import)\s*\(?\s*["']@scopeguard\//.test(source)) {
    throw new Error(`${bundledFile} contains an unresolved Workspace import.`);
  }
  if (source.includes(repositoryRoot)) {
    throw new Error(`${bundledFile} contains the local repository path.`);
  }
}

console.log(JSON.stringify({
  stageRoot,
  fileCount: paths.size,
  bundledWorkspaceImports: false,
  sourceMaps: false,
}, null, 2));

async function listFiles(root) {
  const result = [];
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Package staging contains symbolic link ${path}.`);
    }
    if (stat.isDirectory()) {
      result.push(...await listFiles(path));
    } else if (stat.isFile()) {
      result.push(path);
    } else {
      throw new Error(`Package staging contains unsupported filesystem entry ${path}.`);
    }
  }
  return result;
}
