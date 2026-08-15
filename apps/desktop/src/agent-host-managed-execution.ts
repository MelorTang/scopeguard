import { randomUUID } from "node:crypto";

import type {
  AgentHostManagedExecutionCancel,
  AgentHostManagedExecutionRequest,
  AgentHostManagedExecutionResponse,
  AgentHostManagedExecutionEvent,
  AgentHostToMainMessage,
} from "@scopeguard/ipc-contracts";
import type {
  ManagedExecutionAdapter,
  ManagedExecutionContext,
  ManagedExecutionRequest,
  ManagedExecutionResult,
} from "@scopeguard/managed-execution";

type HostMessagePort = {
  postMessage(message: AgentHostToMainMessage): void;
};

type PendingExecution = {
  resolve: (result: ManagedExecutionResult) => void;
  reject: (error: Error) => void;
  context: ManagedExecutionContext;
  removeAbortListener: () => void;
};

export class AgentHostManagedExecutionAdapter
implements ManagedExecutionAdapter {
  readonly #port: HostMessagePort;
  readonly #pending = new Map<string, PendingExecution>();
  #shuttingDown = false;

  constructor(port: HostMessagePort) {
    this.#port = port;
  }

  execute(
    request: ManagedExecutionRequest,
    context: ManagedExecutionContext,
  ): Promise<ManagedExecutionResult> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("Managed execution adapter is shut down."));
    }
    const requestId = randomUUID();
    const abort = () => {
      this.#port.postMessage({
        type: "host-managed-execution-cancel",
        requestId,
      } satisfies AgentHostManagedExecutionCancel);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    const result = new Promise<ManagedExecutionResult>((resolve, reject) => {
      this.#pending.set(requestId, {
        resolve,
        reject,
        context,
        removeAbortListener: () => context.signal.removeEventListener("abort", abort),
      });
    });
    this.#port.postMessage({
      type: "host-managed-execution-request",
      requestId,
      request,
    } satisfies AgentHostManagedExecutionRequest);
    if (context.signal.aborted) {
      abort();
    }
    return result;
  }

  handleEvent(message: AgentHostManagedExecutionEvent): void {
    this.#pending.get(message.requestId)?.context.onEvent?.(message.event);
  }

  handleResponse(message: AgentHostManagedExecutionResponse): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    pending.removeAbortListener();
    if (message.ok && message.result) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error ?? "Managed execution failed."));
    }
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const [requestId, pending] of this.#pending) {
      this.#port.postMessage({
        type: "host-managed-execution-cancel",
        requestId,
      } satisfies AgentHostManagedExecutionCancel);
      pending.removeAbortListener();
      pending.reject(new Error("Managed execution stopped with the Agent Host."));
    }
    this.#pending.clear();
  }
}
