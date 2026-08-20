import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
environment.SCOPEGUARD_PI_UTILITY_PROBE_HOST_NODE = process.execPath;
const child = spawn(
  electronPath,
  [join(desktopRoot, "dist", "main", "pi-runtime-utility-probe-main.js")],
  {
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Pi Runtime utility probe exited by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
