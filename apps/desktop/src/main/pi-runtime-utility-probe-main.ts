import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, utilityProcess } from "electron";

import { agentHostEnvironment } from "./agent-host-client.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

void app.whenReady().then(async () => {
  const hostNode = process.env.SCOPEGUARD_PI_UTILITY_PROBE_HOST_NODE;
  if (!hostNode) {
    throw new Error("Pi Runtime utility probe host Node path is required.");
  }
  const probeEnvironment = {
    ...agentHostEnvironment(),
    SCOPEGUARD_PI_UTILITY_PROBE_HOST_NODE: hostNode,
    ...(process.env.SCOPEGUARD_PI_UTILITY_PROBE_MODE === undefined
      ? {}
      : {
          SCOPEGUARD_PI_UTILITY_PROBE_MODE:
            process.env.SCOPEGUARD_PI_UTILITY_PROBE_MODE,
        }),
  };
  const child = utilityProcess.fork(
    join(moduleDirectory, "pi-runtime-utility-probe-child.js"),
    [],
    {
      env: probeEnvironment,
      serviceName: "ScopeGuard Pi Runtime Utility Probe",
      stdio: "pipe",
    },
  );
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let settled = false;
    const finish = (value: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        success: false,
        probeError: "Electron utility process probe timed out after 8 seconds.",
      });
    }, 8_000);
    child.on("message", (message: unknown) => {
      const value = message as Record<string, unknown> | null;
      if (
        value?.type === "pi-utility-probe-result" &&
        value.result &&
        typeof value.result === "object"
      ) {
        finish(value.result as Record<string, unknown>);
      }
    });
    child.once("exit", (code) => {
      finish({
        success: false,
        probeError: `Electron utility process exited before reporting evidence (code=${code}).`,
      });
    });
    child.once("error", (_type, location) => {
      finish({
        success: false,
        probeError: `Electron utility process failed at ${location}.`,
      });
    });
  });
  console.log(JSON.stringify(result));
  app.exit(result.success === true ? 0 : 1);
}).catch((error: unknown) => {
  console.log(JSON.stringify({
    success: false,
    probeError: error instanceof Error ? error.message : String(error),
  }));
  app.exit(1);
});
