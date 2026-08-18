import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_STDERR_BYTES = 16_384;
const MAX_WIRE_BUFFER_BYTES = 1_048_576;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 1_024;
const TRUNCATED = "[TRUNCATED]\n";

type JsonRecord = Record<string, unknown>;
type Pending = { resolve: (record: JsonRecord) => void; reject: (error: Error) => void };
type Waiter = Pending & { after: number; predicate: (record: JsonRecord) => boolean };

export class PiProtocolError extends Error {
  override name = "PiProtocolError";
}

export class PiRpcProcess {
  readonly records: JsonRecord[] = [];
  readonly processId: string;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stderr = "";
  #stdout = "";
  #sequence = 0;
  #pending = new Map<string, Pending>();
  #waiters = new Set<Waiter>();
  #exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  #fatal: Error | null = null;

  constructor(
    readonly options: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      processId: string;
      redactions?: string[];
    },
  ) {
    this.processId = options.processId;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error("Pi RPC process already started.");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#appendStderr(chunk));
    this.#exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const error = new Error(
          `Pi RPC exited code=${String(code)} signal=${String(signal)}: ${this.#stderr}`,
        );
        this.#fatal = error;
        this.#rejectAll(error);
        resolve({ code, signal });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Pi RPC failed during startup: code=${String(code)} signal=${String(signal)}: ${this.#stderr}`));
      });
    });
  }

  mark(): number {
    return this.records.length;
  }

  async send(command: JsonRecord, timeoutMs = 15_000): Promise<JsonRecord> {
    if (this.#fatal) throw this.#fatal;
    const id = typeof command.id === "string" ? command.id : `${this.processId}-${++this.#sequence}`;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ ...command, id });
    return timeout(response, timeoutMs, () =>
      `Pi RPC response timed out for ${String(command.type)}: ${this.#stderr || "no stderr"}`, () => {
      this.#pending.delete(id);
    });
  }

  respondToExtension(request: JsonRecord, confirmed: boolean): void {
    this.#write(buildExtensionConfirmation(request, confirmed));
  }

  waitFor(
    predicate: (record: JsonRecord) => boolean,
    options: { after?: number; timeoutMs?: number; description?: string } = {},
  ): Promise<JsonRecord> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    const after = options.after ?? 0;
    const existing = this.records.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    let waiter: Waiter;
    const pending = new Promise<JsonRecord>((resolve, reject) => {
      waiter = { predicate, after, resolve, reject };
      this.#waiters.add(waiter);
    });
    return timeout(
      pending,
      options.timeoutMs ?? 30_000,
      `Pi RPC timed out waiting for ${options.description ?? "record"}.`,
      () => this.#waiters.delete(waiter),
    );
  }

  async close(timeoutMs = 5_000): Promise<void> {
    const child = this.#child;
    if (!child || !this.#exitPromise) return;
    child.stdin.end();
    try {
      await timeout(this.#exitPromise, timeoutMs, "Pi RPC graceful shutdown timed out.");
    } catch (error) {
      child.kill("SIGKILL");
      await this.#exitPromise;
      throw error;
    } finally {
      this.#child = null;
    }
  }

  async kill(): Promise<void> {
    if (!this.#child || !this.#exitPromise) return;
    this.#child.kill("SIGKILL");
    await this.#exitPromise;
    this.#child = null;
  }

  #write(record: JsonRecord): void {
    if (!this.#child?.stdin.writable) throw new Error("Pi RPC stdin is unavailable.");
    this.#child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  #consumeStdout(chunk: Buffer): void {
    this.#stdout += chunk.toString("utf8");
    if (Buffer.byteLength(this.#stdout, "utf8") > MAX_WIRE_BUFFER_BYTES && !this.#stdout.includes("\n")) {
      this.#failProtocol(new PiProtocolError(`Pi RPC JSONL line exceeded ${MAX_WIRE_BUFFER_BYTES} bytes.`));
      return;
    }
    while (this.#stdout.includes("\n")) {
      const newline = this.#stdout.indexOf("\n");
      const line = this.#stdout.slice(0, newline).replace(/\r$/, "");
      this.#stdout = this.#stdout.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_WIRE_BUFFER_BYTES) {
        this.#failProtocol(new PiProtocolError(`Pi RPC JSONL line exceeded ${MAX_WIRE_BUFFER_BYTES} bytes.`));
        return;
      }
      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch (error) {
        const diagnostic = utf8Tail(sanitize(`${String(error)}: ${line}`, this.options.redactions), MAX_PROTOCOL_DIAGNOSTIC_BYTES);
        this.#failProtocol(new PiProtocolError(`Invalid Pi RPC JSONL: ${diagnostic}`));
        return;
      }
      this.records.push(record);
      if (record.type === "response" && typeof record.id === "string") {
        this.#pending.get(record.id)?.resolve(record);
        this.#pending.delete(record.id);
      }
      for (const waiter of [...this.#waiters]) {
        if (this.records.length <= waiter.after || !waiter.predicate(record)) continue;
        this.#waiters.delete(waiter);
        waiter.resolve(record);
      }
    }
  }

  #appendStderr(chunk: Buffer): void {
    const combined = `${this.#stderr}${sanitize(chunk.toString("utf8"), this.options.redactions)}`;
    if (Buffer.byteLength(combined, "utf8") <= MAX_STDERR_BYTES) {
      this.#stderr = combined;
      return;
    }
    const budget = MAX_STDERR_BYTES - Buffer.byteLength(TRUNCATED, "utf8");
    this.#stderr = `${TRUNCATED}${utf8Tail(combined, budget)}`;
  }

  #failProtocol(error: Error): void {
    this.#fatal = error;
    this.#rejectAll(error);
    this.#child?.kill("SIGKILL");
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }
}

export function buildExtensionConfirmation(request: JsonRecord, confirmed: boolean): JsonRecord {
  if (
    request.type !== "extension_ui_request" ||
    request.method !== "confirm" ||
    typeof request.id !== "string" ||
    request.id.length === 0 ||
    typeof confirmed !== "boolean"
  ) {
    throw new PiProtocolError("Invalid Pi extension confirmation request.");
  }
  return { confirmed, type: "extension_ui_response", id: request.id };
}

function sanitize(input: string, redactions: string[] = []): string {
  let value = input;
  for (const secret of redactions.filter(Boolean)) value = value.split(secret).join("[REDACTED]");
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s]+/gi, "$1[REDACTED]");
}

function utf8Tail(input: string, maxBytes: number): string {
  const points = Array.from(input);
  let bytes = 0;
  const selected: string[] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maxBytes) break;
    selected.push(point);
    bytes += size;
  }
  return selected.reverse().join("");
}

function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string | (() => string),
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(typeof message === "function" ? message() : message));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
