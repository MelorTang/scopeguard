import type {
  ProviderAdapter,
  ProviderCredentials,
  ProviderStreamEvent,
  ProviderTurnRequest,
} from "@scopeguard/agent-runtime";

export type KeylessReplayStep = {
  events: ProviderStreamEvent[];
  waitForAbort?: boolean;
};

/** Replaces only the Provider network boundary while preserving the real app composition. */
export class KeylessReplayProvider implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;
  readonly requests: ProviderTurnRequest[] = [];
  readonly #steps: KeylessReplayStep[];

  constructor(steps: KeylessReplayStep[]) {
    this.#steps = steps;
  }

  async testConnection(credentials: ProviderCredentials) {
    return {
      ok: true,
      latencyMs: 0,
      model: credentials.model,
      message: "keyless replay",
    };
  }

  async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const stepSequence = this.requests.length + 1;
    const step = this.#steps[stepSequence - 1];
    if (!step) {
      throw new Error(`Missing keyless replay step ${stepSequence}.`);
    }
    this.requests.push(request);
    for (const event of step.events) {
      yield event;
    }
    if (step.waitForAbort) {
      await waitForAbort(request.signal);
    }
  }
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  await new Promise<void>((_resolve, reject) => {
    const abort = () => reject(
      signal.reason ?? new DOMException("Replay cancelled.", "AbortError"),
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  throw new Error("Unreachable replay abort state.");
}
