import { execFile } from "node:child_process";
import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stageRoot = join(desktopRoot, ".package", "app");
const stageDist = join(stageRoot, "dist");
const rendererSource = join(desktopRoot, "dist-renderer");
const rendererTarget = join(stageRoot, "dist-renderer");
const runtimeTarget = join(stageRoot, "runtime");
const runtimeDeployTarget = join(desktopRoot, ".package", "pi-runtime-deploy");
const runtimeDeploymentSource = join(desktopRoot, "runtime-deployment");
const desktopPackage = JSON.parse(
  await readFile(join(desktopRoot, "package.json"), "utf8"),
);

const execFileAsync = promisify(execFile);

await Promise.all([
  rm(stageRoot, { recursive: true, force: true }),
  rm(runtimeDeployTarget, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(stageDist, { recursive: true }),
  mkdir(runtimeTarget, { recursive: true }),
  mkdir(runtimeDeployTarget, { recursive: true }),
]);

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
    banner: {
      js: "import { createRequire as __scopeguardCreateRequire } from 'node:module'; const require = __scopeguardCreateRequire(import.meta.url);",
    },
    legalComments: "none",
    sourcemap: false,
    logLevel: "info",
  });
}

const repositoryRoot = join(desktopRoot, "..", "..");
const pnpmArgs = [
  "--dir", runtimeDeployTarget,
  "--config.node-linker=hoisted",
  "install",
  "--ignore-workspace",
  "--prod",
  "--frozen-lockfile",
];
const pnpmInvocation = process.platform === "win32"
  ? {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...pnpmArgs],
    }
  : { command: "pnpm", args: pnpmArgs };
try {
  await Promise.all([
    copyFile(
      join(runtimeDeploymentSource, "package.json"),
      join(runtimeDeployTarget, "package.json"),
    ),
    copyFile(
      join(runtimeDeploymentSource, "pnpm-lock.yaml"),
      join(runtimeDeployTarget, "pnpm-lock.yaml"),
    ),
  ]);
  await execFileAsync(pnpmInvocation.command, pnpmInvocation.args, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  await rm(join(runtimeDeployTarget, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
  await cp(
    join(runtimeDeployTarget, "node_modules"),
    join(runtimeTarget, "node_modules"),
    {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    },
  );
} finally {
  await rm(runtimeDeployTarget, { recursive: true, force: true });
}

const piRuntimeDist = join(repositoryRoot, "packages", "pi-runtime", "dist");
for (const file of [
  "approval-extension.js",
  "approval-policy.js",
  "electron-node-bootstrap.js",
  "extension-manifest.json",
]) {
  await copyFile(join(piRuntimeDist, file), join(runtimeTarget, file));
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
