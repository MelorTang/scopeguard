import { spawn } from "node:child_process";

const DEFAULT_MAX_STDERR_BYTES = 16_384;
const MAX_PROTOCOL_LINE_BYTES = 1_024;
const MAX_WIRE_BUFFER_BYTES = 1_048_576;

const KNOWN_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
  "extension_ui_request",
]);

function withTimeout(promise, ms, message, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function sanitizeDiagnostic(value, redactions = []) {
  let sanitized = String(value);
  for (const secret of redactions.filter(Boolean)) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s]+/gi,
      "$1[REDACTED]",
    );
}

export function classifyRpcRecord(record) {
  if (record?.type === "response") return "response";
  if (KNOWN_EVENT_TYPES.has(record?.type)) return "event";
  return "unknown";
}

export class RpcProcess {
  constructor({
    cliPath,
    cwd,
    env,
    args = [],
    label,
    command = process.execPath,
    commandArgs,
    redactValues = [],
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  }) {
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.env = env;
    this.args = args;
    this.label = label;
    this.command = command;
    this.commandArgs = commandArgs ?? [cliPath, "--mode", "rpc", ...args];
    this.redactValues = redactValues;
    this.maxStderrBytes = maxStderrBytes;
    this.records = [];
    this.stderr = "";
    this.stderrCarry = "";
    this.stderrTruncated = false;
    this.stdoutRemainder = "";
    this.pending = new Map();
    this.waiters = new Set();
    this.sequence = 0;
    this.child = null;
    this.exit = null;
    this.protocolError = null;
    this.protocolFailure = new Promise((resolve) => {
      this.resolveProtocolFailure = resolve;
    });
  }

  async start() {
    if (this.child) throw new Error(`${this.label}: already started`);

    this.child = spawn(this.command, this.commandArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.#appendStderr(chunk));

    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.#flushStderrCarry();
        const result = { code, signal, stderr: this.stderr };
        this.#rejectOperations(
          new Error(`${this.label}: exited code=${code} signal=${signal}`),
        );
        resolve(result);
      });
    });

    await Promise.race([
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        this.child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        this.child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(
            new Error(
              `${this.label}: startup exit code=${code} signal=${signal}: ${this.stderr}`,
            ),
          );
        });
      }),
      withTimeout(
        new Promise(() => {}),
        3_000,
        `${this.label}: startup timeout`,
      ),
    ]);
    return this;
  }

  mark() {
    return this.records.length;
  }

  async send(command, timeoutMs = 10_000) {
    if (!this.child?.stdin.writable)
      throw new Error(`${this.label}: stdin unavailable`);
    const id = command.id ?? `${this.label}-${++this.sequence}`;
    const payload = { ...command, id };
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return withTimeout(
      response,
      timeoutMs,
      `${this.label}: response timeout for ${command.type}`,
      () => {
        this.pending.delete(id);
      },
    ).finally(() => this.pending.delete(id));
  }

  write(record) {
    if (!this.child?.stdin.writable)
      throw new Error(`${this.label}: stdin unavailable`);
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
    return record;
  }

  respondToExtension(request, response) {
    if (request.type !== "extension_ui_request") {
      throw new Error(`${this.label}: expected extension_ui_request`);
    }
    return this.write({
      type: "extension_ui_response",
      id: request.id,
      ...response,
    });
  }

  async waitFor(
    predicate,
    { after = 0, timeoutMs = 15_000, description = "record" } = {},
  ) {
    const existing = this.records.slice(after).find(predicate);
    if (existing) return existing;

    let waiter;
    const waiting = new Promise((resolve, reject) => {
      waiter = { predicate, after, resolve, reject };
      this.waiters.add(waiter);
    });
    return withTimeout(
      waiting,
      timeoutMs,
      `${this.label}: timeout waiting for ${description}`,
      () => {
        this.waiters.delete(waiter);
      },
    );
  }

  async waitForSettled(after = 0, timeoutMs = 20_000) {
    return this.waitFor((record) => record.type === "agent_settled", {
      after,
      timeoutMs,
      description: "agent_settled",
    });
  }

  async gracefulShutdown(timeoutMs = 5_000) {
    if (!this.child) return { code: null, signal: null, stderr: this.stderr };
    this.child.stdin.end();
    return withTimeout(
      this.exit,
      timeoutMs,
      `${this.label}: graceful shutdown timeout`,
    );
  }

  async kill(signal = "SIGKILL", timeoutMs = 5_000) {
    if (!this.child) return { code: null, signal: null, stderr: this.stderr };
    this.child.kill(signal);
    return withTimeout(
      this.exit,
      timeoutMs,
      `${this.label}: ${signal} timeout`,
    );
  }

  async waitForProtocolFailure(timeoutMs = 5_000) {
    if (this.protocolError) return this.protocolError;
    return withTimeout(
      this.protocolFailure,
      timeoutMs,
      `${this.label}: protocol failure timeout`,
    );
  }

  #consumeStdout(chunk) {
    this.stdoutRemainder += chunk.toString("utf8");
    if (
      this.stdoutRemainder.length > MAX_WIRE_BUFFER_BYTES &&
      !this.stdoutRemainder.includes("\n")
    ) {
      const safePrefix = sanitizeDiagnostic(
        this.stdoutRemainder,
        this.redactValues,
      ).slice(0, MAX_PROTOCOL_LINE_BYTES);
      this.stdoutRemainder = "";
      this.#failProtocol(
        new Error(`${this.label}: JSONL line exceeds limit: ${safePrefix}`),
      );
      return;
    }
    while (true) {
      const newline = this.stdoutRemainder.indexOf("\n");
      if (newline < 0) break;
      let line = this.stdoutRemainder.slice(0, newline);
      this.stdoutRemainder = this.stdoutRemainder.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        const safeLine = sanitizeDiagnostic(line, this.redactValues).slice(
          0,
          MAX_PROTOCOL_LINE_BYTES,
        );
        const safeError = sanitizeDiagnostic(error.message, this.redactValues);
        this.#failProtocol(
          new Error(
            `${this.label}: invalid JSONL stdout: ${safeError}: ${safeLine}`,
          ),
        );
        return;
      }
      record.__classification = classifyRpcRecord(record);
      this.records.push(record);
      if (
        record.type === "response" &&
        record.id &&
        this.pending.has(record.id)
      ) {
        this.pending.get(record.id).resolve(record);
      }
      for (const waiter of [...this.waiters]) {
        if (this.records.length <= waiter.after) continue;
        if (!waiter.predicate(record)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(record);
      }
    }
  }

  #appendStderr(chunk) {
    const carryLimit = Math.max(
      256,
      ...this.redactValues.map((value) => value.length + 64),
    );
    const combined = `${this.stderrCarry}${chunk.toString("utf8")}`;
    const splitAt = Math.max(0, combined.length - carryLimit);
    this.stderrCarry = combined.slice(splitAt);
    this.#appendSanitizedStderr(combined.slice(0, splitAt));
  }

  #flushStderrCarry() {
    this.#appendSanitizedStderr(this.stderrCarry);
    this.stderrCarry = "";
  }

  #appendSanitizedStderr(value) {
    if (!value) return;
    let safe = `${this.stderr}${sanitizeDiagnostic(value, this.redactValues)}`;
    if (safe.length > this.maxStderrBytes) {
      safe = safe.slice(-this.maxStderrBytes);
      this.stderrTruncated = true;
    }
    this.stderr = `${this.stderrTruncated ? "[TRUNCATED]\n" : ""}${safe.replace(/^\[TRUNCATED\]\n/, "")}`;
  }

  #failProtocol(error) {
    if (this.protocolError) return;
    this.protocolError = error;
    this.resolveProtocolFailure(error);
    this.#rejectOperations(error);
    this.child?.kill("SIGKILL");
  }

  #rejectOperations(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}
