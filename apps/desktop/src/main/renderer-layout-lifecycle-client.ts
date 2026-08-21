import {
  parseRendererLayoutLifecycleResponse,
  type RendererLayoutDrainReceipt,
  type RendererLayoutLifecycleAction,
  type RendererLayoutLifecycleRequest,
} from "@scopeguard/ipc-contracts";

type PendingRequest = {
  action: RendererLayoutLifecycleAction;
  resolve(value?: RendererLayoutDrainReceipt): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type RendererLayoutLifecycleClientOptions = {
  rendererId: number;
  timeoutMs: number;
  send(request: RendererLayoutLifecycleRequest): void;
};

export class RendererLayoutLifecycleClient {
  readonly #options: RendererLayoutLifecycleClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #sequence = 0;
  #disposed = false;

  constructor(options: RendererLayoutLifecycleClientOptions) {
    if (!Number.isInteger(options.rendererId) || options.rendererId <= 0) {
      throw new Error("Renderer ID must be a positive integer.");
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Renderer layout lifecycle timeout must be positive.");
    }
    this.#options = options;
  }

  drain(): Promise<RendererLayoutDrainReceipt> {
    return this.#request("drain");
  }

  resume(): Promise<void> {
    return this.#request("resume");
  }

  handleResponse(senderId: number, value: unknown): boolean {
    if (senderId !== this.#options.rendererId) return false;
    const response = parseRendererLayoutLifecycleResponse(value);
    const pending = this.#pending.get(response.requestId);
    if (!pending) return false;
    if (pending.action !== response.action) {
      throw new Error("Renderer layout lifecycle response action did not match its request.");
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    if (response.ok && response.action === "drain") {
      pending.resolve(response.drainReceipt);
    } else if (response.ok) {
      pending.resolve();
    } else {
      pending.reject(new Error(response.error));
    }
    return true;
  }

  dispose(reason = "Renderer layout lifecycle client was disposed."): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #request(action: "drain"): Promise<RendererLayoutDrainReceipt>;
  #request(action: "resume"): Promise<void>;
  #request(
    action: RendererLayoutLifecycleAction,
  ): Promise<RendererLayoutDrainReceipt | void> {
    if (this.#disposed) {
      return Promise.reject(new Error("Renderer layout lifecycle client is disposed."));
    }
    this.#sequence += 1;
    const request: RendererLayoutLifecycleRequest = {
      requestId: `layout-lifecycle-${this.#sequence}`,
      action,
    };
    return new Promise<RendererLayoutDrainReceipt | void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        reject(new Error(
          `Renderer layout ${action} acknowledgement timed out after ${this.#options.timeoutMs}ms.`,
        ));
      }, this.#options.timeoutMs);
      this.#pending.set(request.requestId, { action, resolve, reject, timer });
      try {
        this.#options.send(request);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
