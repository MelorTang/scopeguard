import { spawn } from "node:child_process";

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

function timeoutAfter(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

export function classifyRpcRecord(record) {
  if (record?.type === "response") return "response";
  if (KNOWN_EVENT_TYPES.has(record?.type)) return "event";
  return "unknown";
}

export class RpcProcess {
  constructor({ cliPath, cwd, env, args, label }) {
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.env = env;
    this.args = args;
    this.label = label;
    this.records = [];
    this.stderr = "";
    this.stdoutRemainder = "";
    this.pending = new Map();
    this.waiters = new Set();
    this.sequence = 0;
    this.child = null;
    this.exit = null;
  }

  async start() {
    if (this.child) throw new Error(`${this.label}: already started`);

    this.child = spawn(process.execPath, [this.cliPath, "--mode", "rpc", ...this.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });

    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        const result = { code, signal, stderr: this.stderr };
        for (const { reject } of this.pending.values()) {
          reject(new Error(`${this.label}: exited code=${code} signal=${signal}`));
        }
        this.pending.clear();
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
          reject(new Error(`${this.label}: startup exit code=${code} signal=${signal}: ${this.stderr}`));
        });
      }),
      timeoutAfter(3_000, `${this.label}: startup timeout`),
    ]);
    return this;
  }

  mark() {
    return this.records.length;
  }

  async send(command, timeoutMs = 10_000) {
    if (!this.child?.stdin.writable) throw new Error(`${this.label}: stdin unavailable`);
    const id = command.id ?? `${this.label}-${++this.sequence}`;
    const payload = { ...command, id };
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return Promise.race([
      response,
      timeoutAfter(timeoutMs, `${this.label}: response timeout for ${command.type}`),
    ]).finally(() => this.pending.delete(id));
  }

  async waitFor(predicate, { after = 0, timeoutMs = 15_000, description = "record" } = {}) {
    const existing = this.records.slice(after).find(predicate);
    if (existing) return existing;

    const waiting = new Promise((resolve, reject) => {
      const waiter = { predicate, after, resolve, reject };
      this.waiters.add(waiter);
    });
    return Promise.race([
      waiting,
      timeoutAfter(timeoutMs, `${this.label}: timeout waiting for ${description}`),
    ]);
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
    return Promise.race([
      this.exit,
      timeoutAfter(timeoutMs, `${this.label}: graceful shutdown timeout`),
    ]);
  }

  async kill(signal = "SIGKILL", timeoutMs = 5_000) {
    if (!this.child) return { code: null, signal: null, stderr: this.stderr };
    this.child.kill(signal);
    return Promise.race([
      this.exit,
      timeoutAfter(timeoutMs, `${this.label}: ${signal} timeout`),
    ]);
  }

  #consumeStdout(chunk) {
    this.stdoutRemainder += chunk.toString("utf8");
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
        throw new Error(`${this.label}: invalid JSONL stdout: ${error.message}: ${line}`);
      }
      record.__classification = classifyRpcRecord(record);
      this.records.push(record);
      if (record.type === "response" && record.id && this.pending.has(record.id)) {
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
}
