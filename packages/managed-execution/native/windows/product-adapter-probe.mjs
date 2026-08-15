import { mkdir, writeFile } from "node:fs/promises";

import { WindowsLpacManagedExecutionAdapter } from "../../dist/index.js";

const options = parseOptions(process.argv.slice(2));
const executionId = crypto.randomUUID().replaceAll("-", "");
const outputPath = `${options.workspace}\\product-adapter-output.txt`;
const events = [];
const adapter = new WindowsLpacManagedExecutionAdapter({
  installationRoot: options.installationRoot,
  serviceClientPath: options.serviceClient,
  launcherPath: options.launcher,
  lifetimeBrokerPath: options.lifetimeBroker,
  pipeName: options.pipe,
  runtimeId: "scopeguard.node",
  diagnosticsDirectory: options.diagnostics,
  profileStateDirectory: options.profileState,
  resolveWorkspaceId: () => "workspace.primary",
});

await mkdir(options.diagnostics, { recursive: true });
let result;
try {
  result = await adapter.execute({
    executionId,
    projectId: "product-adapter-probe",
    threadId: "product-adapter-probe",
    runId: "product-adapter-probe",
    workspaceRoot: options.workspace,
    command: `echo product-adapter-ok> "${outputPath}" && echo streamed-output`,
    timeoutMs: 30_000,
    environment: allowedEnvironment(process.env),
  }, {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
} finally {
  await adapter.shutdown();
}

const evidence = {
  passed:
    result?.status === "exited" &&
    result.exitCode === 0 &&
    result.cleanup === "clean" &&
    result.termination === "confirmed" &&
    result.output.includes("streamed-output") &&
    events.some((event) => event.stream === "stdout" && event.chunk?.includes("streamed-output")),
  executionId,
  result,
  stages: events.filter((event) => !event.chunk).map((event) => event.stage),
  streamedEvents: events.filter((event) => event.chunk).length,
};
await writeFile(options.result, JSON.stringify(evidence, null, 2), "utf8");
console.log(JSON.stringify(evidence));
if (!evidence.passed) process.exitCode = 1;

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, "");
    const value = args[index + 1];
    if (!name || !value) throw new Error("Product adapter probe options are incomplete.");
    parsed[name] = value;
  }
  const required = [
    "installation-root",
    "service-client",
    "launcher",
    "lifetime-broker",
    "pipe",
    "workspace",
    "diagnostics",
    "profile-state",
    "result",
  ];
  for (const name of required) {
    if (!parsed[name]) throw new Error(`Missing --${name}.`);
  }
  return {
    installationRoot: parsed["installation-root"],
    serviceClient: parsed["service-client"],
    launcher: parsed.launcher,
    lifetimeBroker: parsed["lifetime-broker"],
    pipe: parsed.pipe,
    workspace: parsed.workspace,
    diagnostics: parsed.diagnostics,
    profileState: parsed["profile-state"],
    result: parsed.result,
  };
}

function allowedEnvironment(source) {
  const names = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ];
  return Object.fromEntries(names.flatMap((name) =>
    source[name] === undefined ? [] : [[name, source[name]]]));
}
