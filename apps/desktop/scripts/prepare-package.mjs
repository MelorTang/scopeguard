import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = join(desktopRoot, ".package", "app");
const stageDist = join(stageRoot, "dist");
const rendererSource = join(desktopRoot, "dist-renderer");
const rendererTarget = join(stageRoot, "dist-renderer");
const desktopPackage = JSON.parse(
  await readFile(join(desktopRoot, "package.json"), "utf8"),
);

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageDist, { recursive: true });

for (const [entry, outfile] of [
  ["src/main.ts", "main.js"],
  ["src/agent-host.ts", "agent-host.js"],
]) {
  await build({
    entryPoints: [join(desktopRoot, entry)],
    outfile: join(stageDist, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    conditions: ["node", "import"],
    external: ["electron"],
    legalComments: "none",
    sourcemap: false,
    logLevel: "info",
  });
}

await copyFile(join(desktopRoot, "src", "preload.cjs"), join(stageDist, "preload.cjs"));
await cp(rendererSource, rendererTarget, {
  recursive: true,
  filter: (source) => !source.endsWith(".map"),
});

await writeFile(
  join(stageRoot, "package.json"),
  `${JSON.stringify({
    name: "scopeguard-desktop",
    productName: "ScopeGuard",
    description: "Local-first multi-Agent desktop workspace",
    author: "MelorTang",
    version: desktopPackage.version,
    private: true,
    type: "module",
    main: "dist/main.js",
  }, null, 2)}\n`,
  "utf8",
);

console.log(`Prepared package staging directory: ${stageRoot}`);
