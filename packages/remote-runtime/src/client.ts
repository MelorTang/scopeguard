import {
  parseRemoteRunPollResult,
  parseRemoteRunRecord,
  parseRemoteRuntimeHealth,
  type RemoteRunPollResult,
  type RemoteRunRecord,
  type RemoteRunSubmission,
  type RemoteRuntimeClient,
  type RemoteRuntimeHealth,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class RemoteRuntimeRequestError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(status: number | null) {
    super(remoteRuntimeErrorMessage(status));
    this.name = "RemoteRuntimeRequestError";
    this.status = status;
    this.retryable = status === null || status === 408 || status === 425 ||
      status === 429 || status >= 500;
  }
}

export class RemoteRuntimeProtocolError extends Error {
  constructor() {
    super("Remote Runtime returned an incompatible response.");
    this.name = "RemoteRuntimeProtocolError";
  }
}

export class HttpRemoteRuntimeClient implements RemoteRuntimeClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#baseUrl = normalizeRuntimeBaseUrl(options.baseUrl);
    this.#token = options.token.trim();
    if (!this.#token) {
      throw new Error("Remote Runtime credential is required.");
    }
    this.#fetch = options.fetchImpl ?? fetch;
  }

  health(signal?: AbortSignal): Promise<RemoteRuntimeHealth> {
    return this.#request(
      "GET",
      "/v1/health",
      undefined,
      parseRemoteRuntimeHealth,
      signal,
    );
  }

  async submitRun(
    input: RemoteRunSubmission,
    signal?: AbortSignal,
  ): Promise<RemoteRunRecord> {
    const run = await this.#request(
      "POST",
      "/v1/runs",
      input,
      parseRemoteRunRecord,
      signal,
    );
    if (run.id !== input.remoteRunId || run.clientRunId !== input.clientRunId) {
      throw new RemoteRuntimeProtocolError();
    }
    return run;
  }

  async getRun(
    runId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): Promise<RemoteRunPollResult> {
    const query = new URLSearchParams({ after: String(afterSequence) });
    const result = await this.#request(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}?${query}`,
      undefined,
      parseRemoteRunPollResult,
      signal,
    );
    if (result.run.id !== runId) {
      throw new RemoteRuntimeProtocolError();
    }
    return result;
  }

  async cancelRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<RemoteRunRecord> {
    const run = await this.#request(
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      parseRemoteRunRecord,
      signal,
    );
    if (run.id !== runId) {
      throw new RemoteRuntimeProtocolError();
    }
    return run;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      throw new RemoteRuntimeRequestError(null);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteRuntimeRequestError(response.status);
    }
    try {
      const payload = await readResponseJson(response, this.#token);
      return parse(payload);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      if (
        error instanceof RemoteRuntimeProtocolError ||
        error instanceof RemoteRuntimeRequestError
      ) {
        throw error;
      }
      throw new RemoteRuntimeProtocolError();
    }
  }
}

export function normalizeRuntimeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Remote Runtime URL must be valid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Remote Runtime URL cannot include credentials, query, or hash.");
  }
  const isLoopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "::1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Remote Runtime URL must use HTTPS outside this device.");
  }
  return url.toString().replace(/\/$/, "");
}

async function readResponseJson(
  response: Response,
  credential: string,
): Promise<unknown> {
  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new RemoteRuntimeRequestError(null);
  }
  const text = responseText.replaceAll(credential, "[REDACTED]");
  if (!text) {
    return {};
  }
  if (text.length > 2_000_000) {
    throw new Error("Remote Runtime response exceeded the size limit.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Remote Runtime returned invalid JSON.");
  }
}

function remoteRuntimeErrorMessage(status: number | null): string {
  if (status === null) {
    return "Unable to reach the Remote Runtime.";
  }
  if (status === 401) {
    return "Remote Runtime authentication failed (HTTP 401).";
  }
  if (status === 403) {
    return "Remote Runtime denied the request (HTTP 403).";
  }
  if (status === 404) {
    return "Remote Runtime resource was not found (HTTP 404).";
  }
  return `Remote Runtime request failed with HTTP ${status}.`;
}
