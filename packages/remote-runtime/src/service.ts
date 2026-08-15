import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  NativeAgentRuntime,
  type ModelToolDefinition,
  type ProviderAdapter,
  type ToolRegistry,
} from "@scopeguard/agent-runtime";
import {
  normalizeProviderBaseUrl,
  type AgentToolPolicy,
  type ProviderProtocol,
} from "@scopeguard/domain";
import { createProviderAdapter } from "@scopeguard/provider-adapters";

import {
  REMOTE_RUNTIME_PROTOCOL_VERSION,
  parseRemoteRunSubmission,
  type RemoteArtifact,
  type RemoteRunEvent,
  type RemoteRunPollResult,
  type RemoteRunRecord,
  type RemoteRunStatus,
  type RemoteRunSubmission,
  type RemoteRuntimeHealth,
} from "./protocol.js";

const MAX_REQUEST_BYTES = 2_000_000;
const NO_TOOLS_POLICY: AgentToolPolicy = {
  readFiles: "deny",
  writeFiles: "deny",
  runCommands: "deny",
};

const EMPTY_TOOLS: ToolRegistry = {
  definitions: (): ModelToolDefinition[] => [],
  get: () => null,
};

type ProviderFactory = (protocol: ProviderProtocol) => ProviderAdapter;

export type RemoteRuntimeServiceOptions = {
  databasePath: string;
  token: string;
  host?: string;
  port?: number;
  providerFactory?: ProviderFactory;
};

type RunningJob = {
  controller: AbortController;
  settled: Promise<void>;
};

export class RemoteRuntimeService {
  readonly #host: string;
  readonly #port: number;
  readonly #token: string;
  readonly #providerFactory: ProviderFactory;
  readonly #store: RemoteJobStore;
  readonly #runtimeRoot: string;
  readonly #jobs = new Map<string, RunningJob>();
  #server: Server | null = null;

  constructor(options: RemoteRuntimeServiceOptions) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 8787;
    this.#token = options.token.trim();
    if (!this.#token) {
      throw new Error("SCOPEGUARD_RUNTIME_TOKEN is required.");
    }
    this.#providerFactory = options.providerFactory
      ?? ((protocol) => createProviderAdapter({ protocol }));
    this.#store = new RemoteJobStore(options.databasePath);
    this.#runtimeRoot = resolve(dirname(options.databasePath), "workspace");
    mkdirSync(this.#runtimeRoot, { recursive: true, mode: 0o700 });
  }

  async start(): Promise<{ baseUrl: string }> {
    if (this.#server) {
      throw new Error("Remote Runtime is already running.");
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError
          ? error.message
          : "Remote Runtime request failed.";
        sendJson(response, status, { error: message });
      });
    });
    this.#server = server;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#port, this.#host);
    });
    const address = server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("Remote Runtime did not expose a listening address.");
    }
    const host = address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
    return { baseUrl: `http://${host}:${address.port}` };
  }

  async close(): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      job.controller.abort(new Error("Remote Runtime service is shutting down."));
    }
    await Promise.allSettled(jobs.map((job) => job.settled));
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
        server.closeAllConnections();
      });
    }
    this.#store.close();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#isAuthorized(request.headers.authorization)) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, { error: "Remote Runtime authentication failed." });
      return;
    }
    const url = new URL(request.url ?? "/", "http://runtime.invalid");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      const health: RemoteRuntimeHealth = {
        service: "scopeguard-runtime",
        protocolVersion: REMOTE_RUNTIME_PROTOCOL_VERSION,
        status: "online",
        capabilities: {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        },
        serverTime: new Date().toISOString(),
      };
      sendJson(response, 200, health);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const input = parseRemoteRunSubmission(await readJsonBody(request));
      const existing = this.#store.getByClientRunId(input.clientRunId);
      if (existing) {
        sendJson(response, 200, existing);
        return;
      }
      const run = this.#store.createRun(input);
      this.#startExecution(run.id, input);
      sendJson(response, 202, this.#store.requireRun(run.id));
      return;
    }
    const match = /^\/v1\/runs\/([^/]+?)(\/cancel)?$/.exec(url.pathname);
    if (!match) {
      sendJson(response, 404, { error: "Remote Runtime route was not found." });
      return;
    }
    const runId = decodeURIComponent(match[1]!);
    if (request.method === "GET" && !match[2]) {
      const after = parseAfterSequence(url.searchParams.get("after"));
      const result: RemoteRunPollResult = {
        run: this.#store.requireRun(runId),
        events: this.#store.listEvents(runId, after),
      };
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && match[2] === "/cancel") {
      const run = this.#store.requireRun(runId);
      if (!isTerminal(run.status)) {
        const running = this.#jobs.get(run.id);
        if (running) {
          this.#store.setStatus(run.id, "cancelling");
          running.controller.abort(new DOMException("Run cancelled.", "AbortError"));
        } else {
          this.#store.setStatus(run.id, "cancelled");
        }
      }
      sendJson(response, 200, this.#store.requireRun(run.id));
      return;
    }
    sendJson(response, 405, { error: "Remote Runtime method is not allowed." });
  }

  #startExecution(runId: string, input: RemoteRunSubmission): void {
    const controller = new AbortController();
    const settled = this.#execute(runId, input, controller).finally(() => {
      this.#jobs.delete(runId);
    });
    this.#jobs.set(runId, { controller, settled });
  }

  async #execute(
    runId: string,
    input: RemoteRunSubmission,
    controller: AbortController,
  ): Promise<void> {
    const sensitive = [input.provider.apiKey ?? ""].filter(Boolean);
    try {
      this.#store.setStatus(runId, "running");
      const runtime = new NativeAgentRuntime(
        this.#providerFactory(input.provider.protocol),
        EMPTY_TOOLS,
      );
      const result = await runtime.run(
        {
          projectId: input.workspaceId,
          projectRoot: this.#runtimeRoot,
          threadId: input.threadId,
          runId,
          credentials: {
            ...input.provider,
            baseUrl: normalizeProviderBaseUrl(input.provider.baseUrl),
            customHeaders: {},
          },
          messages: input.messages,
          executionProfile: "request-approval",
          toolPolicy: NO_TOOLS_POLICY,
          signal: controller.signal,
          allowUserInput: false,
        },
        {
          // Remote Runtime deliberately does not retain model-visible payloads.
          onRequestManifest: () => {},
          onTextDelta: (delta) => {
            this.#store.appendEvent(runId, {
              type: "text-delta",
              delta,
              at: new Date().toISOString(),
            });
          },
          onUsage: () => {},
          onAssistantTurn: async (turn) => Object.fromEntries(
            turn.toolCalls.map((call) => [call.providerCallId, randomUUID()]),
          ),
          onToolCallStatus: () => {},
          requestApproval: async () => "denied" as const,
          requestInput: async () => {
            throw new Error(
              "User input is unavailable while a Run executes unattended on a remote Runtime.",
            );
          },
          onToolResult: () => {},
        },
      );
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      this.#store.createArtifact(
        runId,
        input.artifactTitle,
        result.finalText.trim() || "Remote Agent completed without text output.",
      );
      this.#store.setStatus(runId, "completed");
    } catch (error) {
      const current = this.#store.requireRun(runId);
      if (isTerminal(current.status)) {
        return;
      }
      if (controller.signal.aborted) {
        this.#store.setStatus(runId, "cancelled");
        return;
      }
      const message = redactExactSecrets(
        error instanceof Error ? error.message : String(error),
        sensitive,
      );
      this.#store.setStatus(runId, "failed", message.slice(0, 4_000));
    }
  }

  #isAuthorized(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ")) {
      return false;
    }
    const actual = Buffer.from(header.slice("Bearer ".length));
    const expected = Buffer.from(this.#token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

class RemoteJobStore {
  readonly #database: DatabaseSync;
  readonly #path: string | null;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.#path = databasePath === ":memory:" ? null : databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    if (this.#path) {
      this.#database.exec("PRAGMA journal_mode = WAL");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS remote_jobs (
        id TEXT PRIMARY KEY,
        client_run_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        thread_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        artifact_title TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS remote_events (
        run_id TEXT NOT NULL REFERENCES remote_jobs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS remote_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES remote_jobs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remote_events_run_sequence
        ON remote_events(run_id, sequence);
    `);
    this.#recoverAfterRestart();
    this.#secureFiles();
  }

  close(): void {
    this.#database.close();
    this.#secureFiles();
  }

  createRun(input: RemoteRunSubmission): RemoteRunRecord {
    const id = input.remoteRunId;
    const now = new Date().toISOString();
    this.#run(
      `INSERT INTO remote_jobs (
        id, client_run_id, workspace_id, task_id, thread_id,
        agent_instance_id, artifact_title, status, error,
        created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, NULL)`,
      id,
      input.clientRunId,
      input.workspaceId,
      input.taskId,
      input.threadId,
      input.agentInstanceId,
      input.artifactTitle,
      now,
    );
    this.appendEvent(id, { type: "status", status: "queued", at: now });
    return this.requireRun(id);
  }

  getByClientRunId(clientRunId: string): RemoteRunRecord | null {
    const row = this.#get(
      "SELECT * FROM remote_jobs WHERE client_run_id = ?",
      clientRunId,
    );
    return row ? this.#mapRun(row) : null;
  }

  requireRun(runId: string): RemoteRunRecord {
    const row = this.#get("SELECT * FROM remote_jobs WHERE id = ?", runId);
    if (!row) {
      throw new HttpError(404, "Remote Run was not found.");
    }
    return this.#mapRun(row);
  }

  setStatus(runId: string, status: RemoteRunStatus, error?: string): void {
    const now = new Date().toISOString();
    const startedAt = status === "running" ? now : null;
    const completedAt = isTerminal(status) ? now : null;
    this.#run(
      `UPDATE remote_jobs SET
        status = ?, error = ?,
        started_at = COALESCE(started_at, ?),
        completed_at = COALESCE(completed_at, ?)
       WHERE id = ?`,
      status,
      error ?? null,
      startedAt,
      completedAt,
      runId,
    );
    this.appendEvent(runId, {
      type: "status",
      status,
      ...(error ? { error } : {}),
      at: now,
    });
  }

  appendEvent(
    runId: string,
    event:
      | Omit<Extract<RemoteRunEvent, { type: "status" }>, "sequence" | "runId">
      | Omit<Extract<RemoteRunEvent, { type: "text-delta" }>, "sequence" | "runId">
      | Omit<Extract<RemoteRunEvent, { type: "artifact" }>, "sequence" | "runId">,
  ): RemoteRunEvent {
    const row = this.#get(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM remote_events WHERE run_id = ?`,
      runId,
    );
    const stored = {
      ...event,
      sequence: Number(row?.next_sequence ?? 1),
      runId,
    } as RemoteRunEvent;
    this.#run(
      `INSERT INTO remote_events (
        run_id, sequence, type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      runId,
      stored.sequence,
      stored.type,
      JSON.stringify(stored),
      stored.at,
    );
    return stored;
  }

  listEvents(runId: string, afterSequence: number): RemoteRunEvent[] {
    this.requireRun(runId);
    return this.#all(
      `SELECT payload_json FROM remote_events
       WHERE run_id = ? AND sequence > ? ORDER BY sequence`,
      runId,
      afterSequence,
    ).map((row) => JSON.parse(String(row.payload_json)) as RemoteRunEvent);
  }

  createArtifact(runId: string, title: string, content: string): RemoteArtifact {
    const artifact: RemoteArtifact = {
      id: randomUUID(),
      runId,
      title,
      mimeType: "text/markdown",
      content,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    this.#run(
      `INSERT INTO remote_artifacts (
        id, run_id, title, mime_type, content, version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      artifact.id,
      artifact.runId,
      artifact.title,
      artifact.mimeType,
      artifact.content,
      artifact.version,
      artifact.createdAt,
    );
    this.appendEvent(runId, {
      type: "artifact",
      artifact,
      at: artifact.createdAt,
    });
    return artifact;
  }

  #mapRun(row: UnknownRow): RemoteRunRecord {
    const runId = String(row.id);
    const sequence = this.#get(
      "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM remote_events WHERE run_id = ?",
      runId,
    );
    const artifactRow = this.#get(
      "SELECT * FROM remote_artifacts WHERE run_id = ?",
      runId,
    );
    return {
      id: runId,
      clientRunId: String(row.client_run_id),
      workspaceId: String(row.workspace_id),
      taskId: nullableString(row.task_id),
      threadId: String(row.thread_id),
      agentInstanceId: String(row.agent_instance_id),
      status: String(row.status) as RemoteRunStatus,
      error: nullableString(row.error),
      createdAt: String(row.created_at),
      startedAt: nullableString(row.started_at),
      completedAt: nullableString(row.completed_at),
      lastSequence: Number(sequence?.last_sequence ?? 0),
      artifact: artifactRow ? mapArtifact(artifactRow) : null,
    };
  }

  #recoverAfterRestart(): void {
    const rows = this.#all(
      `SELECT id FROM remote_jobs
       WHERE status IN ('queued', 'running', 'cancelling')`,
    );
    for (const row of rows) {
      this.setStatus(
        String(row.id),
        "failed",
        "Remote Runtime restarted before this Run completed.",
      );
    }
  }

  #run(sql: string, ...parameters: SQLInputValue[]): void {
    this.#database.prepare(sql).run(...parameters);
  }

  #get(sql: string, ...parameters: SQLInputValue[]): UnknownRow | undefined {
    return this.#database.prepare(sql).get(...parameters) as UnknownRow | undefined;
  }

  #all(sql: string, ...parameters: SQLInputValue[]): UnknownRow[] {
    return this.#database.prepare(sql).all(...parameters) as UnknownRow[];
  }

  #secureFiles(): void {
    if (!this.#path) {
      return;
    }
    for (const path of [this.#path, `${this.#path}-wal`, `${this.#path}-shm`]) {
      if (existsSync(path)) {
        chmodSync(path, 0o600);
      }
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

type UnknownRow = Record<string, unknown>;

function mapArtifact(row: UnknownRow): RemoteArtifact {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    title: String(row.title),
    mimeType: "text/markdown",
    content: String(row.content),
    version: 1,
    createdAt: String(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function isTerminal(status: RemoteRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function parseAfterSequence(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, "Event cursor must be a non-negative integer.");
  }
  return parsed;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "Remote Runtime request exceeded the size limit.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Remote Runtime request must contain valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function redactExactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
    value,
  );
}
