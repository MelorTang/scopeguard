import type {
  ModelMessage,
  ProviderCredentials,
  ProviderFinishReason,
} from "@scopeguard/agent-runtime";

export type FetchImplementation = typeof fetch;

export class ProviderRequestError extends Error {
  readonly status: number | null;
  readonly retryAfter: string | null;

  constructor(message: string, options?: { status?: number; retryAfter?: string | null }) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = options?.status ?? null;
    this.retryAfter = options?.retryAfter ?? null;
  }
}

export function appendEndpoint(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = endpoint.replace(/^\/+/, "");
  if (base.endsWith(`/${suffix}`)) {
    return base;
  }
  return `${base}/${suffix}`;
}

export function buildHeaders(
  credentials: ProviderCredentials,
  protocolHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(credentials.customHeaders)) {
    if (isProtectedHeader(name)) {
      continue;
    }
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(protocolHeaders)) {
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream, application/json");
  return headers;
}

export async function assertSuccessfulResponse(
  response: Response,
  credentials: ProviderCredentials,
): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => "");
  const detail = extractProviderErrorMessage(body, credentials);
  const prefix = response.status === 401 || response.status === 403
    ? "Provider authentication failed."
    : response.status === 404
      ? "Provider endpoint or model was not found."
      : response.status === 429
        ? "Provider rate limit reached."
        : `Provider request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(detail ? `${prefix} ${detail}` : prefix, {
    status: response.status,
    retryAfter: redactCredentialText(
      response.headers.get("retry-after") ?? "",
      credentials,
    ) || null,
  });
}

export function providerPayloadError(
  payload: unknown,
  credentials: ProviderCredentials,
  fallbackMessage: string,
): ProviderRequestError {
  const detail = extractErrorMessage(payload);
  return new ProviderRequestError(
    redactCredentialText(detail || fallbackMessage, credentials),
  );
}

export function redactCredentialText(
  value: string,
  credentials: ProviderCredentials,
): string {
  let sanitized = value;
  const credentialValues = [
    credentials.apiKey,
    ...Object.values(credentials.customHeaders),
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .sort((left, right) => right.length - left.length);

  for (const credential of credentialValues) {
    sanitized = sanitized.split(credential).join("[REDACTED]");
  }

  return sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

export function redactCredentialValues(
  value: unknown,
  credentials: ProviderCredentials,
): unknown {
  if (typeof value === "string") {
    return redactCredentialText(value, credentials);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialValues(entry, credentials));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactCredentialText(key, credentials),
        redactCredentialValues(entry, credentials),
      ]),
    );
  }
  return value;
}

export function mapFinishReason(value: unknown): ProviderFinishReason {
  switch (value) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_calls":
    case "tool_use":
      return "tool-calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content-filter";
    default:
      return "unknown";
  }
}

export function modelMessageText(message: ModelMessage): string {
  return message.content;
}

export function parseToolArguments(value: string, toolName: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new ProviderRequestError(
      `Provider returned invalid JSON arguments for tool ${toolName}.`,
    );
  }
  throw new ProviderRequestError(
    `Provider returned non-object arguments for tool ${toolName}.`,
  );
}

function isProtectedHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "x-api-key" ||
    normalized === "content-type" ||
    normalized === "anthropic-version"
  );
}

function extractProviderErrorMessage(
  body: string,
  credentials: ProviderCredentials,
): string {
  if (!body) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return redactCredentialText(extractErrorMessage(parsed), credentials);
  } catch {
    return "";
  }
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return typeof payload === "string" ? payload : "";
  }

  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  if (typeof nested === "string") {
    return nested;
  }
  return typeof record.message === "string" ? record.message : "";
}
