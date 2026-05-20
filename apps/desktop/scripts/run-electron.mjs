import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let electronPath;
try {
  electronPath = require.resolve("electron/cli.js");
} catch {
  console.error("Electron is not installed for @scopeguard/desktop.");
  console.error("Install it with: pnpm --filter @scopeguard/desktop add -D electron");
  process.exit(1);
}

const child = spawn(process.execPath, [electronPath, join(desktopRoot, "dist", "main.js"), ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
