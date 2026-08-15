import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";

import type { Id } from "@scopeguard/domain";

import {
  ManagedExecutionUnavailableError,
  type ManagedExecutionAdapter,
  type ManagedExecutionContext,
  type ManagedExecutionRequest,
  type ManagedExecutionResult,
} from "./index.js";

const MAX_NATIVE_OUTPUT_BYTES = 256_000;
const SERVICE_TIMEOUT_MS = 210_000;
const CLEANUP_TIMEOUT_MS = 210_000;
const TERMINATION_WAIT_MS = 5_000;
const COMMAND_WORKER = [
  'const { spawn } = require("node:child_process");',
  "const command = `\"${process.argv[2]}\"`;",
  "const child = spawn(process.argv[1], [\"/d\", \"/s\", \"/c\", command], { stdio: \"inherit\", windowsHide: true, windowsVerbatimArguments: true });",
  "child.once(\"error\", (error) => { console.error(error.message); process.exit(126); });",
  "child.once(\"close\", (code, signal) => process.exit(signal ? 125 : (code ?? 126)));",
].join("");

export type WindowsLpacManagedExecutionConfig = {
  installationRoot: string;
  serviceClientPath: string;
  launcherPath: string;
  lifetimeBrokerPath: string;
  pipeName: string;
  runtimeId?: string;
  diagnosticsDirectory: string;
  profileStateDirectory: string;
  resolveWorkspaceId(request: ManagedExecutionRequest): Promise<string> | string;
  platform?: NodeJS.Platform;
};

export type NativeProcessInput = {
  executable: string;
  args: string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
};

export type NativeProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  cancellation: "cancelled" | "timeout" | "shutdown" | null;
  terminationConfirmed: boolean;
};

export interface NativeProcessRunner {
  run(input: NativeProcessInput): Promise<NativeProcessResult>;
  shutdown(): Promise<void>;
}

type PreparedExecution = {
  executionId: string;
  workspaceId: string;
  runtimeId: string;
  profileName: string;
  packageSid: string;
  profileCleanupRequired: boolean;
  runtime: {
    runtimeId: string;
    executablePath: string;
    capabilities: string[];
  };
};

export class WindowsLpacManagedExecutionAdapter
implements ManagedExecutionAdapter {
  readonly #config: WindowsLpacManagedExecutionConfig;
  readonly #runner: NativeProcessRunner;
  readonly #active = new Map<Id, { controller: AbortController; settled: Promise<void> }>();
  #recovery: Promise<void> | null = null;
  #shuttingDown = false;

  constructor(
    config: WindowsLpacManagedExecutionConfig,
    runner: NativeProcessRunner = new SpawnNativeProcessRunner(),
  ) {
    this.#config = config;
    this.#runner = runner;
  }

  async execute(
    request: ManagedExecutionRequest,
    context: ManagedExecutionContext,
  ): Promise<ManagedExecutionResult> {
    if (this.#shuttingDown) {
      throw new ManagedExecutionUnavailableError(
        "The Windows LPAC execution Broker is shutting down.",
      );
    }
    if (this.#active.has(request.executionId)) {
      throw new Error(`Managed execution is already active: ${request.executionId}`);
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", forwardAbort, { once: true });
    if (context.signal.aborted) forwardAbort();

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      resolveSettled = resolvePromise;
    });
    this.#active.set(request.executionId, { controller, settled });
    try {
      return await this.#execute(request, { ...context, signal: controller.signal });
    } finally {
      context.signal.removeEventListener("abort", forwardAbort);
      this.#active.delete(request.executionId);
      resolveSettled();
    }
  }

  async #execute(
    request: ManagedExecutionRequest,
    context: ManagedExecutionContext,
  ): Promise<ManagedExecutionResult> {
    this.#emit(context, request.executionId, "accepted");
    await this.#verifyInstallation();
    this.#recovery ??= this.#recoverProfileIntents();
    await this.#recovery;
    const workspaceId = await this.#config.resolveWorkspaceId(request);
    assertIdentifier(workspaceId, /^workspace\.[a-z][a-z0-9-]{0,62}$/, "workspaceId");
    const runtimeId = this.#config.runtimeId ?? "scopeguard.node";
    assertIdentifier(runtimeId, /^scopeguard\.[a-z][a-z0-9.-]{0,63}$/, "runtimeId");
    assertIdentifier(request.executionId, /^[0-9a-f]{32}$/, "executionId");

    const profileName = `ScopeGuardExec_${request.executionId}`;
    let profileIntentPersisted = false;
    let prepared = false;
    let prepareAttempted = false;
    let commandResult: NativeProcessResult | null = null;
    let primaryError: Error | null = null;
    let cleanupError: Error | null = null;
    let output = "";
    let outputTruncated = false;

    try {
      this.#emit(context, request.executionId, "provisioning");
      await this.#writeProfileIntent(request.executionId, profileName, "planned");
      profileIntentPersisted = true;
      const profile = await this.#runRequired({
        executable: this.#config.launcherPath,
        args: ["profile", "--name", profileName],
        timeoutMs: 30_000,
        signal: context.signal,
      }, "AppContainer Profile creation");
      if (!/^S-1-15-2-/.test(profile.stdout.trim())) {
        throw new Error("LPAC launcher returned an invalid Package SID.");
      }
      await this.#writeProfileIntent(request.executionId, profileName, "created");

      prepareAttempted = true;
      const preparedResponse = await this.#serviceRequest({
        schemaVersion: 1,
        operation: "prepare",
        requestId: compactUuid(),
        executionId: request.executionId,
        issuedAtUtc: new Date().toISOString(),
        workspaceId,
        runtimeId,
      }, context.signal);
      const preparedResult = parsePreparedExecution(preparedResponse);
      if (
        preparedResult.executionId !== request.executionId ||
        preparedResult.workspaceId !== workspaceId ||
        preparedResult.runtimeId !== runtimeId ||
        preparedResult.profileName !== profileName ||
        preparedResult.packageSid !== profile.stdout.trim() ||
        !preparedResult.profileCleanupRequired ||
        preparedResult.runtime.runtimeId !== runtimeId ||
        preparedResult.runtime.capabilities.length !== 1 ||
        preparedResult.runtime.capabilities[0] !== "registryRead"
      ) {
        throw new Error("Provisioner response does not match the requested LPAC policy.");
      }
      prepared = true;

      this.#emit(context, request.executionId, "running");
      commandResult = await this.#runner.run({
        executable: this.#config.lifetimeBrokerPath,
        args: [
          "--parent-pid",
          String(process.pid),
          "--ready",
          resolve(this.#config.profileStateDirectory, `${request.executionId}.ready`),
          "--",
          this.#config.launcherPath,
          "run",
          "--name",
          profileName,
          "--cwd",
          request.workspaceRoot,
          "--timeout",
          String(Math.max(1, Math.ceil(request.timeoutMs / 1_000))),
          "--lpac",
          "--capability",
          "registryRead",
          "--stream-output",
          "--diagnostics",
          resolve(this.#config.diagnosticsDirectory, `${request.executionId}.log`),
          "--",
          preparedResult.runtime.executablePath,
          "-e",
          COMMAND_WORKER,
          process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
          request.command,
        ],
        cwd: request.workspaceRoot,
        environment: request.environment,
        timeoutMs: request.timeoutMs + 15_000,
        signal: context.signal,
        onOutput: (stream, chunk) => {
          context.onEvent?.({
            executionId: request.executionId,
            stage: "running",
            at: new Date().toISOString(),
            stream,
            chunk,
          });
        },
      });
      output = `${commandResult.stdout}${commandResult.stderr}`;
      outputTruncated = commandResult.outputTruncated;
    } catch (error) {
      primaryError = asError(error);
    } finally {
      this.#emit(context, request.executionId, "cleaning");
      const cleanupErrors: Error[] = [];
      if (prepareAttempted) {
        try {
          await this.#serviceRequest({
            schemaVersion: 1,
            operation: "cleanup",
            requestId: compactUuid(),
            executionId: request.executionId,
            issuedAtUtc: new Date().toISOString(),
          }, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
        } catch (error) {
          cleanupErrors.push(asError(error));
        }
      }
      if (profileIntentPersisted) {
        try {
          await this.#runRequired({
            executable: this.#config.launcherPath,
            args: ["delete", "--name", profileName],
            timeoutMs: 30_000,
            signal: AbortSignal.timeout(30_000),
          }, "AppContainer Profile cleanup");
          await this.#deleteProfileIntent(request.executionId);
        } catch (error) {
          cleanupErrors.push(asError(error));
        }
      }
      if (cleanupErrors.length > 0) {
        cleanupError = new Error(cleanupErrors.map((error) => error.message).join("; "));
      }
    }

    if (cleanupError) {
      this.#emit(context, request.executionId, "failed");
      return {
        executionId: request.executionId,
        status: "failed",
        exitCode: commandResult?.exitCode ?? null,
        output,
        outputTruncated,
        termination: commandResult?.terminationConfirmed ? "confirmed" : "unconfirmed",
        cleanup: "failed",
        effect: commandResult ? "unknown" : "none",
        error: `Managed execution cleanup was not confirmed: ${cleanupError.message}`,
      };
    }
    if (primaryError) {
      this.#emit(context, request.executionId, "failed");
      return {
        executionId: request.executionId,
        status: "failed",
        exitCode: commandResult?.exitCode ?? null,
        output,
        outputTruncated,
        termination: commandResult
          ? commandResult.terminationConfirmed ? "confirmed" : "unconfirmed"
          : "not-started",
        cleanup: prepared || profileIntentPersisted ? "clean" : "not-required",
        effect: commandResult ? "unknown" : "none",
        error: primaryError.message,
      };
    }
    if (!commandResult) {
      throw new Error("Managed execution ended without a command result.");
    }

    const status = commandResult.cancellation === "timeout" || commandResult.exitCode === 124
      ? "timed-out"
      : commandResult.cancellation === "shutdown"
        ? "shut-down"
        : commandResult.cancellation
          ? "cancelled"
          : commandResult.exitCode === 0
            ? "exited"
            : "failed";
    this.#emit(
      context,
      request.executionId,
      status === "failed" ? "failed" : "completed",
    );
    return {
      executionId: request.executionId,
      status,
      exitCode: commandResult.exitCode,
      output,
      outputTruncated,
      termination: commandResult.terminationConfirmed ? "confirmed" : "unconfirmed",
      cleanup: "clean",
      effect: status === "exited" ? "confirmed" : "unknown",
      error: status === "failed"
        ? `LPAC command exited with code ${commandResult.exitCode ?? "unknown"}.`
        : undefined,
    };
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const active = [...this.#active.values()];
    for (const execution of active) {
      const error = new Error("Desktop execution Broker is shutting down.");
      error.name = "ManagedExecutionShutdown";
      execution.controller.abort(error);
    }
    await Promise.allSettled(active.map((execution) => execution.settled));
    await this.#runner.shutdown();
  }

  async #verifyInstallation(): Promise<void> {
    if ((this.#config.platform ?? process.platform) !== "win32") {
      throw new ManagedExecutionUnavailableError(
        "Windows LPAC managed execution is only available on Windows.",
      );
    }
    if (!this.#config.pipeName || !/^[A-Za-z0-9._-]{1,128}$/.test(this.#config.pipeName)) {
      throw new ManagedExecutionUnavailableError("Provisioner pipe configuration is invalid.");
    }
    const root = await realpath(this.#config.installationRoot);
    await mkdir(this.#config.profileStateDirectory, { recursive: true, mode: 0o700 });
    for (const path of [
      this.#config.serviceClientPath,
      this.#config.launcherPath,
      this.#config.lifetimeBrokerPath,
    ]) {
      if (!isAbsolute(path)) {
        throw new ManagedExecutionUnavailableError("Managed execution binary path is not absolute.");
      }
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new ManagedExecutionUnavailableError("Managed execution binary is not a regular file.");
      }
      const canonical = await realpath(path);
      const fromRoot = relative(root, canonical);
      if (fromRoot === ".." || fromRoot.startsWith(`..\\`) || isAbsolute(fromRoot)) {
        throw new ManagedExecutionUnavailableError(
          "Managed execution binary is outside the protected installation root.",
        );
      }
    }
  }

  async #recoverProfileIntents(): Promise<void> {
    const entries = await readdir(this.#config.profileStateDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.name.endsWith(".ready")) {
        await unlink(resolve(this.#config.profileStateDirectory, entry.name)).catch(() => {});
        continue;
      }
      if (/^[0-9a-f]{32}\.json\.[0-9a-f]{32}\.tmp$/.test(entry.name)) {
        await unlink(resolve(this.#config.profileStateDirectory, entry.name));
        continue;
      }
      if (!entry.isFile() || !/^[0-9a-f]{32}\.json$/.test(entry.name)) {
        throw new Error(`Unknown Broker Profile intent state: ${entry.name}`);
      }
      const executionId = entry.name.slice(0, 32);
      const path = resolve(this.#config.profileStateDirectory, entry.name);
      const intent = requireExactRecord(
        JSON.parse(await readFile(path, "utf8")) as unknown,
        ["schemaVersion", "executionId", "profileName", "state", "updatedAtUtc"],
        "Broker Profile intent",
      );
      if (
        intent.schemaVersion !== 1 ||
        intent.executionId !== executionId ||
        intent.profileName !== `ScopeGuardExec_${executionId}` ||
        (intent.state !== "planned" && intent.state !== "created") ||
        typeof intent.updatedAtUtc !== "string"
      ) {
        throw new Error(`Broker Profile intent is invalid: ${entry.name}`);
      }
      await this.#serviceRequest({
        schemaVersion: 1,
        operation: "cleanup",
        requestId: compactUuid(),
        executionId,
        issuedAtUtc: new Date().toISOString(),
      }, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
      await this.#runRequired({
        executable: this.#config.launcherPath,
        args: ["delete", "--name", intent.profileName],
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(30_000),
      }, "Broker Profile startup recovery");
      await unlink(path);
    }
  }

  async #writeProfileIntent(
    executionId: string,
    profileName: string,
    state: "planned" | "created",
  ): Promise<void> {
    const path = resolve(this.#config.profileStateDirectory, `${executionId}.json`);
    const temporary = `${path}.${compactUuid()}.tmp`;
    await writeFile(temporary, JSON.stringify({
      schemaVersion: 1,
      executionId,
      profileName,
      state,
      updatedAtUtc: new Date().toISOString(),
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }

  async #deleteProfileIntent(executionId: string): Promise<void> {
    await unlink(resolve(this.#config.profileStateDirectory, `${executionId}.json`));
    await unlink(resolve(this.#config.profileStateDirectory, `${executionId}.ready`)).catch(() => {});
  }

  async #serviceRequest(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await this.#runRequired({
      executable: this.#config.serviceClientPath,
      args: ["--client", "--pipe", this.#config.pipeName],
      stdin: JSON.stringify(payload),
      timeoutMs: SERVICE_TIMEOUT_MS,
      signal,
    }, "Provisioner service request");
    try {
      const response = JSON.parse(result.stdout) as unknown;
      const record = requireRecord(response, "Provisioner response");
      if (record.ok !== true) {
        const error = requireRecord(record.error, "Provisioner error");
        throw new Error(String(error.message ?? "Provisioner rejected the request."));
      }
      return record.result;
    } catch (error) {
      throw new Error(`Provisioner response is invalid: ${asError(error).message}`);
    }
  }

  async #runRequired(input: NativeProcessInput, operation: string): Promise<NativeProcessResult> {
    const result = await this.#runner.run(input);
    if (result.cancellation || result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `${operation} failed${detail ? `: ${detail}` : ` with exit code ${result.exitCode ?? "unknown"}`}.`,
      );
    }
    return result;
  }

  #emit(
    context: ManagedExecutionContext,
    executionId: Id,
    stage: "accepted" | "provisioning" | "running" | "cleaning" | "completed" | "failed",
  ): void {
    context.onEvent?.({ executionId, stage, at: new Date().toISOString() });
  }
}

export class SpawnNativeProcessRunner implements NativeProcessRunner {
  readonly #running = new Set<NativeProcess>();

  async run(input: NativeProcessInput): Promise<NativeProcessResult> {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const running = new NativeProcess(child, input.onOutput);
    this.#running.add(running);
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
    let requestCancellation!: (
      reason: NonNullable<NativeProcessResult["cancellation"]>,
    ) => void;
    const cancellationRequested = new Promise<
      NonNullable<NativeProcessResult["cancellation"]>
    >((resolvePromise) => {
      requestCancellation = resolvePromise;
    });
    const abort = () => requestCancellation(signalReason(input.signal));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const timeout = setTimeout(() => requestCancellation("timeout"), input.timeoutMs);
    try {
      return await Promise.race([
        running.result,
        cancellationRequested.then(async (reason) => {
          try {
            await running.terminate(reason);
            return await running.result;
          } catch {
            return running.unconfirmedResult(reason);
          }
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      this.#running.delete(running);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#running].map((process) => process.terminate("shutdown")));
  }
}

class NativeProcess {
  readonly result: Promise<NativeProcessResult>;
  readonly #child: ChildProcess;
  #reason: NativeProcessResult["cancellation"] = null;
  #termination?: Promise<void>;
  #stdout = "";
  #stderr = "";
  #outputBytes = 0;
  #outputTruncated = false;

  constructor(
    child: ChildProcess,
    onOutput?: NativeProcessInput["onOutput"],
  ) {
    this.#child = child;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const accepted = chunk.subarray(
        0,
        Math.max(0, MAX_NATIVE_OUTPUT_BYTES - this.#outputBytes),
      );
      const text = accepted.toString("utf8");
      if (stream === "stdout") this.#stdout += text;
      else this.#stderr += text;
      this.#outputBytes += accepted.byteLength;
      this.#outputTruncated ||= accepted.byteLength < chunk.byteLength;
      if (text) onOutput?.(stream, text);
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    this.result = new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolvePromise({
        exitCode,
        stdout: this.#stdout,
        stderr: this.#stderr,
        outputTruncated: this.#outputTruncated,
        cancellation: this.#reason,
        terminationConfirmed: true,
      }));
    });
  }

  terminate(reason: NonNullable<NativeProcessResult["cancellation"]>): Promise<void> {
    this.#reason ??= reason;
    this.#termination ??= this.#terminate();
    return this.#termination;
  }

  unconfirmedResult(
    reason: NonNullable<NativeProcessResult["cancellation"]>,
  ): NativeProcessResult {
    return {
      exitCode: null,
      stdout: this.#stdout,
      stderr: this.#stderr,
      outputTruncated: this.#outputTruncated,
      cancellation: reason,
      terminationConfirmed: false,
    };
  }

  async #terminate(): Promise<void> {
    const pid = this.#child.pid;
    if (!pid || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      taskkill.once("error", reject);
      taskkill.once("close", () => resolvePromise());
    });
    await Promise.race([
      this.result.then(() => undefined),
      new Promise<void>((_, reject) => setTimeout(
        () => reject(new Error(`Failed to terminate native process tree ${pid}.`)),
        TERMINATION_WAIT_MS,
      )),
    ]);
  }
}

function parsePreparedExecution(value: unknown): PreparedExecution {
  const record = requireRecord(value, "Provisioner prepare result");
  const runtime = requireRecord(record.runtime, "Provisioner runtime");
  if (!Array.isArray(runtime.capabilities) || runtime.capabilities.some((item) => typeof item !== "string")) {
    throw new Error("Provisioner runtime capabilities are invalid.");
  }
  return {
    executionId: requireString(record.executionId, "executionId"),
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    runtimeId: requireString(record.runtimeId, "runtimeId"),
    profileName: requireString(record.profileName, "profileName"),
    packageSid: requireString(record.packageSid, "packageSid"),
    profileCleanupRequired: record.profileCleanupRequired === true,
    runtime: {
      runtimeId: requireString(runtime.runtimeId, "runtime.runtimeId"),
      executablePath: requireString(runtime.executablePath, "runtime.executablePath"),
      capabilities: runtime.capabilities as string[],
    },
  };
}

function compactUuid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function assertIdentifier(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new Error(`${field} is invalid.`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  expected: string[],
  field: string,
): Record<string, unknown> {
  const record = requireRecord(value, field);
  if (Object.keys(record).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${field} has unexpected properties.`);
  }
  return record;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function signalReason(signal: AbortSignal): "cancelled" | "shutdown" {
  return signal.reason instanceof Error && signal.reason.name === "ManagedExecutionShutdown"
    ? "shutdown"
    : "cancelled";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
