import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("Pi Runtime utility probe requires an Electron parent port.");
}

const root = await mkdtemp(join(tmpdir(), "scopeguard-pi-utility-probe-"));
let result: Record<string, unknown>;
try {
  result = await runProbe(root);
} catch (error) {
  result = {
    success: false,
    probeError: error instanceof Error ? error.message : String(error),
  };
} finally {
  await rm(root, { recursive: true, force: true });
}
parentPort.postMessage({ type: "pi-utility-probe-result", result });
process.exit(result.success === true ? 0 : 1);

async function runProbe(root: string): Promise<Record<string, unknown>> {
  const profileDirectory = join(root, "profile");
  const sessionDirectory = join(root, "session");
  await mkdir(profileDirectory);
  await mkdir(sessionDirectory);
  const runtimeEntry = fileURLToPath(import.meta.resolve("@scopeguard/pi-runtime"));
  const runtimePackageDirectory = dirname(dirname(runtimeEntry));
  const piPackageDirectory = join(
    runtimePackageDirectory,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const piCliPath = join(piPackageDirectory, "dist", "cli.js");
  const extensionPath = join(dirname(runtimeEntry), "approval-extension.js");
  const providerName = "scopeguard-utility-probe";
  const model = "utility-probe-model";
  await writeProbeProfile(profileDirectory, providerName, model);

  const args = [
    piCliPath,
    "--mode", "rpc",
    "--provider", providerName,
    "--model", model,
    "--session-dir", sessionDirectory,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension", extensionPath,
    "--no-approve",
    "--offline",
    "--system-prompt", "ScopeGuard utility probe",
    "--no-tools",
  ];
  const probeMode = process.env.SCOPEGUARD_PI_UTILITY_PROBE_MODE ?? "product";
  if (!["product", "host-node", "electron-run-as-node"].includes(probeMode)) {
    throw new Error("Unsupported Pi utility probe mode.");
  }
  const executable = probeMode === "host-node"
    ? requiredEnvironment("SCOPEGUARD_PI_UTILITY_PROBE_HOST_NODE")
    : process.execPath;
  const childEnvironment = cleanProbeEnvironment({
    PI_CODING_AGENT_DIR: profileDirectory,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_PACKAGE_DIR: piPackageDirectory,
    SCOPEGUARD_WORKSPACE_ROOT: "",
    SCOPEGUARD_READ_PERMISSION: "deny",
    ...(probeMode === "electron-run-as-node"
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {}),
  });
  const startedAt = new Date().toISOString();
  const startedMonotonic = performance.now();
  const child = spawn(executable, args, {
    cwd: sessionDirectory,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let parsedRpcRecords = 0;
  let stdoutBuffer = "";
  let responseReceived = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let exitedAt: string | null = null;
  const stdin = {
    writableAtSpawn: child.stdin.writable,
    scopeguardEndAtMs: null as number | null,
    finishAtMs: null as number | null,
    closeAtMs: null as number | null,
    errorAtMs: null as number | null,
  };

  child.stdin.once("finish", () => {
    stdin.finishAtMs = elapsed();
  });
  child.stdin.once("close", () => {
    stdin.closeAtMs = elapsed();
  });
  child.stdin.once("error", () => {
    stdin.errorAtMs = elapsed();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    stdoutBuffer += chunk.toString("utf8");
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        parsedRpcRecords += 1;
        if (record.type === "response" && record.id === "utility-probe-get-state") {
          responseReceived = true;
        }
      } catch {
        // Counts and process lifecycle are the probe evidence; raw output is not emitted.
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
  });

  const close = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      exitedAt = new Date().toISOString();
      resolve();
    });
  });
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
  });

  await Promise.race([
    new Promise<void>((resolve) => child.once("spawn", resolve)),
    spawnError,
  ]);
  const getState = `${JSON.stringify({
    type: "get_state",
    id: "utility-probe-get-state",
  })}\n`;
  child.stdin.write(getState);

  const outcome = await Promise.race([
    waitFor(() => responseReceived, 4_000).then(() => "response" as const),
    close.then(() => "exit" as const),
    spawnError,
  ]);
  if (outcome === "response") {
    stdin.scopeguardEndAtMs = elapsed();
    child.stdin.end();
    const closed = await Promise.race([
      close.then(() => true),
      delay(1_000).then(() => false),
    ]);
    if (!closed) {
      child.kill("SIGKILL");
      await close;
    }
  }

  return {
    success: responseReceived,
    processExecPath: process.execPath,
    processType: process.type ?? null,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? null,
    piCliPath,
    cwd: sessionDirectory,
    sanitizedArgv: sanitizeArgv(args, {
      extensionPath,
      piCliPath,
      profileDirectory,
      sessionDirectory,
    }),
    electronRunAsNodePresent: Object.hasOwn(
      process.env,
      "ELECTRON_RUN_AS_NODE",
    ),
    childSpawnedAt: startedAt,
    childExitedAt: exitedAt,
    childExitCode: exitCode,
    childExitSignal: exitSignal,
    childElapsedMs: Math.round(performance.now() - startedMonotonic),
    stdin,
    stdoutBytes,
    stderrBytes,
    parsedRpcRecords,
    getStateResponseReceived: responseReceived,
  };

  function elapsed(): number {
    return Math.round(performance.now() - startedMonotonic);
  }
}

async function writeProbeProfile(
  profileDirectory: string,
  providerName: string,
  model: string,
): Promise<void> {
  await writeFile(join(profileDirectory, "models.json"), `${JSON.stringify({
    providers: {
      [providerName]: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        models: [{
          id: model,
          name: model,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(
    join(profileDirectory, "settings.json"),
    `${JSON.stringify({ compaction: { enabled: true } }, null, 2)}\n`,
  );
}

function cleanProbeEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]]
      ),
    ),
    ...extra,
  };
}

function sanitizeArgv(
  args: string[],
  paths: Record<string, string>,
): string[] {
  const replacements = new Map([
    [paths.piCliPath, "<PI_CLI>"],
    [paths.sessionDirectory, "<SESSION_DIR>"],
    [paths.extensionPath, "<POLICY_EXTENSION>"],
    [paths.profileDirectory, "<PROFILE_DIR>"],
  ]);
  return args.map((argument) =>
    replacements.get(argument) ??
      (argument === "ScopeGuard utility probe" ? "<SYSTEM_PROMPT>" : argument)
  );
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error(`Pi utility probe timed out after ${timeoutMs}ms.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
