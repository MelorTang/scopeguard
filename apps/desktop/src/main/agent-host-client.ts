import { randomUUID } from "node:crypto";

import type {
  ForkOptions,
  UtilityProcess,
} from "electron";

import type {
  AgentHostMethod,
  AgentHostRequest,
  AgentHostSecretRequest,
  AgentHostSecretResponse,
  AgentHostToMainMessage,
  MainToAgentHostMessage,
} from "@scopeguard/ipc-contracts";
import type { RunEvent } from "@scopeguard/domain";

import { EncryptedSecretVault } from "./encrypted-secret-vault.js";
import { isolatedChildEnvironment } from "./child-process-environment.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type AgentHostFork = (
  modulePath: string,
  args: string[],
  options: ForkOptions,
) => UtilityProcess;

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 500;
const DEFAULT_RESTART_MAX_DELAY_MS = 10_000;

export class AgentHostClient {
  readonly #modulePath: string;
  readonly #databasePath: string;
  readonly #piSessionRoot: string;
  readonly #artifactRoot: string;
  readonly #piCliPath: string | undefined;
  readonly #piRuntimeAssetRoot: string | undefined;
  readonly #vault: EncryptedSecretVault;
  readonly #fork: AgentHostFork;
  readonly #onRunEvent: (event: RunEvent) => void;
  readonly #onReady: () => void | Promise<void>;
  readonly #readyTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #restartBaseDelayMs: number;
  readonly #restartMaxDelayMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #child: UtilityProcess | null = null;
  #readyPromise: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #restartAttempt = 0;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;

  constructor(options: {
    modulePath: string;
    databasePath: string;
    piSessionRoot: string;
    artifactRoot: string;
    piCliPath?: string;
    piRuntimeAssetRoot?: string;
    vault: EncryptedSecretVault;
    fork: AgentHostFork;
    onRunEvent: (event: RunEvent) => void;
    onReady?: () => void | Promise<void>;
    readyTimeoutMs?: number;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    restartBaseDelayMs?: number;
    restartMaxDelayMs?: number;
  }) {
    this.#modulePath = options.modulePath;
    this.#databasePath = options.databasePath;
    this.#piSessionRoot = options.piSessionRoot;
    this.#artifactRoot = options.artifactRoot;
    this.#piCliPath = options.piCliPath;
    this.#piRuntimeAssetRoot = options.piRuntimeAssetRoot;
    this.#vault = options.vault;
    this.#fork = options.fork;
    this.#onRunEvent = options.onRunEvent;
    this.#onReady = options.onReady ?? (() => {});
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.#restartBaseDelayMs =
      options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    this.#restartMaxDelayMs =
      options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
  }

  get processId(): number | null {
    return this.#child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.#readyPromise) {
      return this.#readyPromise;
    }
    if (this.#child) {
      throw new Error(
        `Agent host ${this.#child.pid} is still running because its termination was not confirmed; restart is refused until its exit is confirmed.`,
      );
    }

    this.#stopping = false;
    this.#clearRestartTimer();
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#readyPromise = readyPromise;

    let child: UtilityProcess;
    try {
      child = this.#fork(this.#modulePath, [], {
        serviceName: "ScopeGuard Agent Host",
        env: isolatedChildEnvironment(process.env, {
          SCOPEGUARD_DB_PATH: this.#databasePath,
          SCOPEGUARD_PI_SESSION_ROOT: this.#piSessionRoot,
          SCOPEGUARD_ARTIFACT_ROOT: this.#artifactRoot,
          ...(this.#piCliPath ? { SCOPEGUARD_PI_CLI_PATH: this.#piCliPath } : {}),
          ...(this.#piRuntimeAssetRoot
            ? { SCOPEGUARD_PI_RUNTIME_ASSET_ROOT: this.#piRuntimeAssetRoot }
            : {}),
        }),
        stdio: "pipe",
      });
    } catch (error) {
      const startError = asError(error, "Agent host could not be started.");
      this.#rejectReadyState(startError);
      this.#scheduleRestart();
      return readyPromise;
    }

    this.#child = child;
    child.on("message", (message: unknown) => {
      void this.#handleMessage(child, message);
    });
    child.on("exit", (code) => {
      this.#handleExit(child, code);
    });
    child.on("error", (_type, location) => {
      console.error(`[scopeguard] Agent host fatal error at ${location}.`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        console.error(`[scopeguard-agent-host] ${message}`);
      }
    });

    this.#readyTimer = setTimeout(() => {
      if (this.#child !== child) {
        return;
      }
      const error = new Error(
        `Agent host did not become ready within ${this.#readyTimeoutMs}ms.`,
      );
      this.#rejectReadyState(error);
      try {
        child.kill();
      } catch (killError) {
        console.error(
          `[scopeguard] Unready Agent host ${child.pid} could not be terminated: ${asError(killError).message}`,
        );
      }
    }, this.#readyTimeoutMs);

    return readyPromise;
  }

  async request<T>(method: AgentHostMethod, payload?: unknown): Promise<T> {
    await this.start();
    const child = this.#child;
    if (!child) {
      throw new Error("Agent host is unavailable.");
    }

    const requestId = randomUUID();
    const request: AgentHostRequest = {
      type: "host-request",
      requestId,
      method,
      payload,
    };
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(requestId)) {
          return;
        }
        reject(
          new Error(
            `Agent host request "${method}" timed out after ${this.#requestTimeoutMs}ms.`,
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
    });

    try {
      child.postMessage(request satisfies MainToAgentHostMessage);
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(requestId);
        pending.reject(asError(error, "Agent host request could not be sent."));
      }
    }
    return response;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }
    this.#stopPromise = this.#stop().finally(() => {
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    this.#clearRestartTimer();
    this.#clearReadyTimer();

    const error = new Error("Agent host stopped.");
    this.#rejectReadyState(error);
    this.#rejectPending(error);
    const child = this.#child;
    if (!child) return;

    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        child.removeListener("exit", finish);
      };
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (this.#child === child) {
          this.#child = null;
        }
        resolve();
      };
      const fail = (stopError: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(stopError);
      };
      const forceTermination = (): void => {
        if (settled) return;
        let accepted: boolean;
        try {
          accepted = child.kill();
        } catch (killError) {
          fail(new Error(
            `Agent host ${child.pid} could not be terminated: ${asError(killError).message}`,
            { cause: killError },
          ));
          return;
        }
        if (settled) return;
        if (!accepted) {
          fail(new Error(`Agent host ${child.pid} could not be terminated.`));
          return;
        }
        timeout = setTimeout(() => {
          fail(new Error(
            `Agent host ${child.pid} did not exit after forced termination within ${this.#shutdownTimeoutMs}ms.`,
          ));
        }, this.#shutdownTimeoutMs);
      };

      child.once("exit", finish);
      timeout = setTimeout(forceTermination, this.#shutdownTimeoutMs);

      try {
        child.postMessage({
          type: "host-shutdown",
        } satisfies MainToAgentHostMessage);
      } catch {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        forceTermination();
      }
    });
  }

  async #handleMessage(
    child: UtilityProcess,
    message: unknown,
  ): Promise<void> {
    if (child !== this.#child || !isHostMessage(message)) {
      return;
    }
    if (message.type === "host-ready") {
      this.#clearReadyTimer();
      this.#resolveReady?.();
      this.#resolveReady = null;
      this.#rejectReady = null;
      this.#restartAttempt = 0;
      try {
        await this.#onReady();
      } catch (error) {
        console.error(
          `[scopeguard] Agent host ready callback failed: ${asError(error).message}`,
        );
      }
      return;
    }
    if (message.type === "host-run-event") {
      this.#onRunEvent(message.event);
      return;
    }
    if (message.type === "host-response") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.#pending.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(
          new Error(message.error?.message ?? "Agent host request failed."),
        );
      }
      return;
    }
    await this.#handleSecretRequest(child, message);
  }

  async #handleSecretRequest(
    child: UtilityProcess,
    request: AgentHostSecretRequest,
  ): Promise<void> {
    const response: AgentHostSecretResponse = {
      type: "host-secret-response",
      requestId: request.requestId,
      ok: true,
    };
    try {
      if (request.operation === "put") {
        if (typeof request.secret !== "string") {
          throw new Error("Secret value is required.");
        }
        response.reference = await this.#vault.put(
          request.reference,
          request.secret,
        );
      } else if (request.operation === "get") {
        response.secret = await this.#vault.get(request.reference);
      } else {
        await this.#vault.delete(request.reference);
      }
    } catch (error) {
      response.ok = false;
      response.error = asError(error).message;
    }
    if (child === this.#child) {
      child.postMessage(response satisfies MainToAgentHostMessage);
    }
  }

  #handleExit(child: UtilityProcess, code: number): void {
    if (child !== this.#child) {
      return;
    }
    const error = new Error(`Agent host exited with code ${code}.`);
    this.#child = null;
    this.#rejectReadyState(error);
    this.#rejectPending(error);
    this.#scheduleRestart();
  }

  #rejectReadyState(error: Error): void {
    this.#clearReadyTimer();
    this.#rejectReady?.(error);
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.#readyPromise = null;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #scheduleRestart(): void {
    if (this.#stopping || this.#restartTimer) {
      return;
    }
    const delay = boundedBackoffDelay(
      this.#restartAttempt,
      this.#restartBaseDelayMs,
      this.#restartMaxDelayMs,
    );
    this.#restartAttempt += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.start().catch((restartError: unknown) => {
        console.error(
          `[scopeguard] Agent host restart failed: ${asError(restartError).message}`,
        );
      });
    }, delay);
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }
}

export function boundedBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  return Math.min(baseDelayMs * 2 ** safeAttempt, maxDelayMs);
}

function asError(error: unknown, fallback = "Agent host operation failed."): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(error === undefined ? fallback : String(error));
}

function isHostMessage(value: unknown): value is AgentHostToMainMessage {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === "string",
  );
}
