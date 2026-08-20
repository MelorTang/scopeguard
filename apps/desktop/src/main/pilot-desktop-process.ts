import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { terminateProcessTree } from "./pilot-process-tree.js";

const DEFAULT_MAX_DIAGNOSTIC_BYTES = 16_384;
const MAX_DIAGNOSTIC_INPUT_BYTES = 1_048_576;
const TRUNCATED = "[TRUNCATED]\n";

export type PilotLifecycleMetadata = {
  schemaVersion: 1;
  phase: 1 | 2;
  mainPid: number;
  agentHostPid: number;
};

export class PilotDesktopProcessFailure extends Error {
  constructor(
    readonly primaryError: Error,
    readonly cleanupError: Error | null,
    readonly cleanupConfirmed: boolean,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      cleanupError
        ? `${primaryError.message}\nAdditional cleanup diagnostic: ${cleanupError.message}`
        : primaryError.message,
      { cause: primaryError },
    );
    this.name = "PilotDesktopProcessFailure";
  }
}

export async function persistPilotLifecycleMetadata(
  path: string,
  metadata: PilotLifecycleMetadata,
): Promise<void> {
  if (!isPilotLifecycleMetadata(metadata)) {
    throw new Error("Desktop Pilot lifecycle metadata is malformed.");
  }
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function supervisePilotDesktopProcess(options: {
  child: ChildProcess;
  completion: string;
  description: string;
  lifecyclePath: string;
  maxDiagnosticBytes?: number;
  phase: 1 | 2;
  redactions?: string[];
  statePath: string;
  timeoutMs: number;
}): Promise<string> {
  const maxDiagnosticBytes = options.maxDiagnosticBytes ??
    DEFAULT_MAX_DIAGNOSTIC_BYTES;
  if (!Number.isSafeInteger(maxDiagnosticBytes) || maxDiagnosticBytes <= 0) {
    throw new Error("Pilot diagnostic byte limit must be a positive integer.");
  }
  const stdout = new BoundedRedactedDiagnostic(
    maxDiagnosticBytes,
    options.redactions,
  );
  const stderr = new BoundedRedactedDiagnostic(
    maxDiagnosticBytes,
    options.redactions,
  );
  options.child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  options.child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let primaryError: Error | null = null;
  try {
    exit = await waitForRootExit(options.child, options.timeoutMs);
  } catch (error) {
    primaryError = asError(
      error,
      `${options.description} did not report a process exit.`,
    );
  } finally {
    stdout.finish();
    stderr.finish();
  }

  const capturedStdout = stdout.value;
  const capturedStderr = stderr.value;
  if (!primaryError && exit) {
    const missingCompletion = !capturedStdout.includes(options.completion);
    const missingState = !existsSync(options.statePath);
    if (exit.code !== 0 || exit.signal !== null || missingCompletion || missingState) {
      const details = [
        `${options.description} exited code=${String(exit.code)} signal=${String(exit.signal)}.`,
      ];
      if (missingCompletion) details.push("The completion marker was absent.");
      if (missingState) details.push("The success state was absent.");
      details.push(`stdout:\n${capturedStdout || "<empty>"}`);
      details.push(`stderr:\n${capturedStderr || "<empty>"}`);
      primaryError = new Error(details.join("\n"));
    }
  }

  let cleanupError: Error | null = null;
  try {
    const lifecycle = await readPilotLifecycleMetadata(
      options.lifecyclePath,
      options.phase,
      options.child.pid,
    );
    await terminateProcessTree(options.child, {
      knownDescendantPids: async () => [lifecycle.agentHostPid],
    });
  } catch (error) {
    cleanupError = asError(
      error,
      `${options.description} lifecycle metadata or process cleanup failed.`,
    );
    try {
      await terminateProcessTree(options.child, {
        knownDescendantPids: async () => [],
      });
    } catch (bestEffortError) {
      cleanupError = new Error(
        `${cleanupError.message} Best-effort root-tree termination also failed: ${
          asError(bestEffortError, "Unknown process cleanup failure.").message
        }`,
        { cause: cleanupError },
      );
    }
  }

  if (primaryError || cleanupError) {
    throw new PilotDesktopProcessFailure(
      primaryError ?? new Error(`${options.description} cleanup was not confirmed.`),
      cleanupError,
      cleanupError === null,
      capturedStdout,
      capturedStderr,
    );
  }
  return capturedStdout;
}

export async function readPilotLifecycleMetadata(
  path: string,
  expectedPhase: 1 | 2,
  expectedMainPid: number | undefined,
): Promise<PilotLifecycleMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Desktop Pilot lifecycle metadata is unavailable at ${path}: ${
        asError(error, "Unknown lifecycle read failure.").message
      }`,
      { cause: error },
    );
  }
  if (!isPilotLifecycleMetadata(parsed)) {
    throw new Error("Desktop Pilot lifecycle metadata is malformed.");
  }
  if (parsed.phase !== expectedPhase) {
    throw new Error("Desktop Pilot lifecycle metadata has the wrong phase.");
  }
  if (!expectedMainPid || parsed.mainPid !== expectedMainPid) {
    throw new Error("Desktop Pilot lifecycle metadata belongs to another Main process.");
  }
  return parsed;
}

function isPilotLifecycleMetadata(value: unknown): value is PilotLifecycleMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return metadata.schemaVersion === 1 &&
    (metadata.phase === 1 || metadata.phase === 2) &&
    Number.isSafeInteger(metadata.mainPid) && Number(metadata.mainPid) > 0 &&
    Number.isSafeInteger(metadata.agentHostPid) &&
    Number(metadata.agentHostPid) > 0;
}

class BoundedRedactedDiagnostic {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxBytes: number;
  readonly #redactions: string[];
  #raw = "";
  #finished = false;

  constructor(maxBytes: number, redactions: string[] = []) {
    this.#maxBytes = maxBytes;
    this.#redactions = redactions.filter(Boolean);
  }

  append(chunk: Buffer): void {
    if (this.#finished) return;
    this.#appendText(this.#decoder.write(chunk));
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#appendText(this.#decoder.end());
  }

  get value(): string {
    const redacted = sanitize(this.#raw, this.#redactions);
    if (Buffer.byteLength(redacted, "utf8") <= this.#maxBytes) return redacted;
    const budget = Math.max(
      0,
      this.#maxBytes - Buffer.byteLength(TRUNCATED, "utf8"),
    );
    return `${TRUNCATED}${utf8Tail(redacted, budget)}`;
  }

  #appendText(text: string): void {
    if (!text) return;
    this.#raw = utf8Tail(
      `${this.#raw}${text}`,
      MAX_DIAGNOSTIC_INPUT_BYTES,
    );
  }
}

function sanitize(input: string, redactions: string[]): string {
  let value = input;
  for (const secret of redactions) {
    value = value.split(secret).join("[REDACTED]");
  }
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s]+/gi,
      "$1[REDACTED]",
    );
}

function utf8Tail(input: string, maxBytes: number): string {
  const points = Array.from(input);
  const selected: string[] = [];
  let bytes = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maxBytes) break;
    selected.push(point);
    bytes += size;
  }
  return selected.reverse().join("");
}

async function waitForRootExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Process exit timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}
