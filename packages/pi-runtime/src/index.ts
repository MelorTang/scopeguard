import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  FileEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  SCOPEGUARD_PI_SESSION_VERSION,
  SCOPEGUARD_PI_VERSION,
  type ConversationMessage,
  type MessageContentBlock,
  type PiSessionLocator,
  type ProviderProtocol,
  type ToolPermission,
} from "@scopeguard/domain";

import { canonicalizeToolInput, hashCanonicalInput } from "./approval-policy.js";
import {
  TRUSTED_EXTENSION_ENTRYPOINT,
  TRUSTED_EXTENSION_MANIFEST,
} from "./extension-trust-root.js";
import { PiProtocolError, PiRpcProcess } from "./rpc-process.js";

export { buildExtensionConfirmation, PiProtocolError, PiRpcProcess } from "./rpc-process.js";
export { canonicalizeToolInput, classifyToolPolicy, hashCanonicalInput } from "./approval-policy.js";

export type PiProviderConfig = {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

export type PiApprovalRequest = {
  processId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  canonicalInput: Record<string, unknown>;
  canonicalInputSha256: string;
};

export type PiRunResult = {
  locator: PiSessionLocator;
  effect: "none" | "confirmed" | "effect_unknown";
  messages: ConversationMessage[];
};

export type PiRunOptions = {
  conversationId: string;
  prompt: string;
  workspaceRoot: string | null;
  instructions: string;
  provider: PiProviderConfig;
  locator: PiSessionLocator | null;
  readPermission: ToolPermission;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onSessionReady?: (locator: PiSessionLocator) => void;
  onApproval: (request: PiApprovalRequest) => Promise<boolean>;
};

const execFileAsync = promisify(execFile);
const loadRuntimeModule = createRequire(import.meta.url);
const EXTENSION_CONFIRM_TIMEOUT_MS = 300_000;
const DEFAULT_HOST_APPROVAL_TIMEOUT_MS = 240_000;

export class PiRuntimeSupervisor {
  readonly #sessionRoot: string;
  readonly #cliPath: string;
  readonly #distRoot: string;
  readonly #piPackageDir: string;
  readonly #parseSessionEntries: (content: string) => FileEntry[];
  readonly #approvalTimeoutMs: number;
  readonly #active = new Map<string, PiRpcProcess>();

  constructor(options: {
    sessionRoot: string;
    cliPath?: string;
    assetRoot?: string;
    approvalTimeoutMs?: number;
  }) {
    this.#sessionRoot = resolve(options.sessionRoot);
    mkdirSync(this.#sessionRoot, { recursive: true, mode: 0o700 });
    this.#distRoot = options.assetRoot ? resolve(options.assetRoot) : dirname(fileURLToPath(import.meta.url));
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_HOST_APPROVAL_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#approvalTimeoutMs) ||
      this.#approvalTimeoutMs <= 0 ||
      this.#approvalTimeoutMs >= EXTENSION_CONFIRM_TIMEOUT_MS
    ) {
      throw new Error("Pi Runtime approval timeout must be a positive integer below the extension timeout.");
    }
    if (options.cliPath) {
      this.#cliPath = resolve(options.cliPath);
      this.#piPackageDir = dirname(dirname(this.#cliPath));
    } else {
      const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      this.#cliPath = join(dirname(piEntry), "cli.js");
      this.#piPackageDir = dirname(dirname(piEntry));
    }
    const sessionModule = loadRuntimeModule(
      join(this.#piPackageDir, "dist", "core", "session-manager.js"),
    ) as { parseSessionEntries?: (content: string) => FileEntry[] };
    if (typeof sessionModule.parseSessionEntries !== "function") {
      throw new Error("Pinned Pi Runtime Session parser is unavailable.");
    }
    this.#parseSessionEntries = sessionModule.parseSessionEntries;
  }

  async probe(provider: PiProviderConfig): Promise<void> {
    const conversationId = `probe-${randomUUID()}`;
    try {
      await this.run({
        conversationId,
        prompt: "Reply with PONG.",
        workspaceRoot: null,
        instructions: "Reply briefly and do not call tools.",
        provider,
        locator: null,
        readPermission: "deny",
        signal: AbortSignal.timeout(30_000),
        onApproval: async () => false,
      });
    } finally {
      await rm(this.#sessionDirectory(conversationId), { recursive: true, force: true });
    }
  }

  async run(options: PiRunOptions): Promise<PiRunResult> {
    if (this.#active.has(options.conversationId)) {
      throw new Error("This Conversation already has an active Pi process.");
    }
    const workspaceRoot = options.workspaceRoot ? realpathSync(options.workspaceRoot) : null;
    const sessionDirectory = this.#sessionDirectory(options.conversationId);
    mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    if (options.locator) this.validateLocator(options.conversationId, options.locator, workspaceRoot);
    const extensionPath = await this.#verifyReadiness();
    const profileDirectory = await mkdtemp(join(tmpdir(), "scopeguard-pi-profile-"));
    const providerName = `scopeguard-${options.conversationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
    const keyVariable = `SCOPEGUARD_PI_KEY_${randomUUID().replaceAll("-", "")}`;
    await this.#writeProfile(profileDirectory, providerName, keyVariable, options.provider);

    const processId = randomUUID();
    const args = [
      this.#cliPath,
      "--mode", "rpc",
      "--provider", providerName,
      "--model", options.provider.model,
      "--session-dir", sessionDirectory,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--extension", extensionPath,
      "--no-approve",
      "--offline",
      "--system-prompt", options.instructions || "You are a helpful assistant.",
      ...(workspaceRoot ? ["--tools", "read,bash,write,edit"] : ["--no-tools"]),
      ...(options.locator ? ["--session", options.locator.sessionFile] : []),
    ];
    const rpc = new PiRpcProcess({
      command: process.execPath,
      args,
      cwd: workspaceRoot ?? sessionDirectory,
      env: cleanEnvironment({
        PI_CODING_AGENT_DIR: profileDirectory,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_PACKAGE_DIR: this.#piPackageDir,
        SCOPEGUARD_WORKSPACE_ROOT: workspaceRoot ?? "",
        SCOPEGUARD_READ_PERMISSION: options.readPermission,
        ...(options.provider.apiKey ? { [keyVariable]: options.provider.apiKey } : {}),
      }),
      processId,
      redactions: options.provider.apiKey ? [options.provider.apiKey] : [],
    });
    this.#active.set(options.conversationId, rpc);
    const activeSideEffects = new Set<string>();
    let effectConfirmed = false;
    let effectUnknown = false;
    const abort = (): void => {
      void rpc.send({ type: "abort" }, 2_000).catch(() => rpc.kill());
    };
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      await rpc.start();
      const initialState = successData(await rpc.send({ type: "get_state" }), "get_state");
      this.#assertState(initialState, providerName, options.provider.model, options.locator);
      options.onSessionReady?.(
        this.#locatorFromState(options.conversationId, initialState, workspaceRoot, false),
      );
      successData(await rpc.send({ type: "set_auto_retry", enabled: false }), "set_auto_retry");
      const mark = rpc.mark();
      successData(await rpc.send({ type: "prompt", message: options.prompt }), "prompt");
      let cursor = mark;
      while (true) {
        const record = await rpc.waitFor(() => true, { after: cursor, description: "next Runtime event" });
        cursor += 1;
        if (record.type === "message_update") {
          const update = record.assistantMessageEvent as Record<string, unknown> | undefined;
          if (update?.type === "text_delta" && typeof update.delta === "string") {
            options.onTextDelta?.(update.delta);
          }
        } else if (record.type === "extension_ui_request") {
          const approval = parseApprovalRequest(processId, record);
          const confirmed = await approvalWithTimeout(
            options.onApproval(approval),
            this.#approvalTimeoutMs,
          );
          if (confirmed && isSideEffectingTool(approval.toolName)) {
            activeSideEffects.add(approval.toolCallId);
          }
          rpc.respondToExtension(record, confirmed);
        } else if (record.type === "tool_execution_end") {
          const id = typeof record.toolCallId === "string" ? record.toolCallId : null;
          if (id && activeSideEffects.delete(id)) {
            if (record.isError === false) effectConfirmed = true;
            else effectUnknown = true;
          }
        } else if (record.type === "agent_settled") {
          break;
        }
      }
      if (options.signal.aborted) throw options.signal.reason;
      const finalState = successData(await rpc.send({ type: "get_state" }), "get_state");
      const locator = this.#locatorFromState(options.conversationId, finalState, workspaceRoot);
      if (activeSideEffects.size > 0) effectUnknown = true;
      return {
        locator,
        effect: effectUnknown ? "effect_unknown" : effectConfirmed ? "confirmed" : "none",
        messages: this.projectMessages(locator),
      };
    } catch (error) {
      if (activeSideEffects.size > 0) {
        throw new PiEffectUnknownError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      options.signal.removeEventListener("abort", abort);
      this.#active.delete(options.conversationId);
      await rpc.close().catch(() => rpc.kill().catch(() => {}));
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#active.values()].map((process) => process.kill()));
    this.#active.clear();
  }

  validateLocator(
    conversationId: string,
    locator: PiSessionLocator,
    expectedWorkspaceRoot?: string | null,
  ): void {
    if (locator.piVersion !== SCOPEGUARD_PI_VERSION) {
      throw new Error(`Pi Session version mismatch: expected Runtime ${SCOPEGUARD_PI_VERSION}.`);
    }
    if (locator.sessionVersion !== SCOPEGUARD_PI_SESSION_VERSION) {
      throw new Error(`Unsupported Pi Session schema version: ${locator.sessionVersion}.`);
    }
    const sessionDirectory = this.#sessionDirectory(conversationId);
    const file = resolve(locator.sessionFile);
    const fromRoot = relative(sessionDirectory, file);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot === "" || !existsSync(file)) {
      throw new Error("Pi Session locator is missing or outside its Conversation directory.");
    }
    const entries = this.#parseSessionEntries(readFileSync(file, "utf8"));
    const header = entries[0];
    if (header?.type !== "session" || header.id !== locator.sessionId) {
      throw new Error("Pi Session locator does not match the Session header.");
    }
    if ((header.version ?? 1) !== locator.sessionVersion) {
      throw new Error("Pi Session header version is incompatible.");
    }
    const expectedCwd = expectedWorkspaceRoot
      ? realpathSync(expectedWorkspaceRoot)
      : realpathSync(sessionDirectory);
    if (realpathSync(header.cwd) !== expectedCwd) {
      throw new Error("Pi Session Workspace does not match the Conversation Workspace.");
    }
  }

  projectMessages(locator: PiSessionLocator): ConversationMessage[] {
    const entries = this.#parseSessionEntries(readFileSync(locator.sessionFile, "utf8"));
    return entries
      .filter((entry): entry is SessionMessageEntry => entry.type === "message")
      .flatMap((entry, index) => projectMessageEntry(entry, index));
  }

  #sessionDirectory(conversationId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(conversationId)) throw new Error("Invalid Conversation id.");
    return join(this.#sessionRoot, conversationId);
  }

  async #verifyReadiness(): Promise<string> {
    const manifestPath = join(this.#distRoot, "extension-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (JSON.stringify(manifest) !== JSON.stringify(TRUSTED_EXTENSION_MANIFEST)) {
      throw new Error("Pi Runtime rejected an untrusted extension manifest.");
    }
    for (const [file, expected] of Object.entries(TRUSTED_EXTENSION_MANIFEST.files)) {
      const actual = createHash("sha256").update(await readFile(join(this.#distRoot, file))).digest("hex");
      if (actual !== expected) throw new Error(`Pi Runtime extension hash mismatch: ${file}`);
    }
    const version = (await execFileAsync(process.execPath, [this.#cliPath, "--version"], {
      env: cleanEnvironment({
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_PACKAGE_DIR: this.#piPackageDir,
      }),
      timeout: 10_000,
    })).stdout.trim();
    if (version !== SCOPEGUARD_PI_VERSION) {
      throw new Error(`Pi Runtime version handshake failed: expected ${SCOPEGUARD_PI_VERSION}, received ${version || "empty"}.`);
    }
    return join(this.#distRoot, TRUSTED_EXTENSION_ENTRYPOINT);
  }

  async #writeProfile(
    profileDirectory: string,
    providerName: string,
    keyVariable: string,
    provider: PiProviderConfig,
  ): Promise<void> {
    const api = provider.protocol === "anthropic-compatible" ? "anthropic-messages" : "openai-completions";
    await writeFile(join(profileDirectory, "models.json"), `${JSON.stringify({
      providers: {
        [providerName]: {
          baseUrl: normalizeBaseUrl(provider.baseUrl),
          api,
          ...(provider.apiKey ? { apiKey: `$${keyVariable}`, authHeader: true } : {}),
          models: [{
            id: provider.model,
            name: provider.model,
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }, null, 2)}\n`);
    await writeFile(join(profileDirectory, "settings.json"), `${JSON.stringify({
      compaction: { enabled: true },
    }, null, 2)}\n`);
  }

  #assertState(
    state: Record<string, unknown>,
    provider: string,
    model: string,
    locator: PiSessionLocator | null,
  ): void {
    const selected = state.model as Record<string, unknown> | undefined;
    if (selected?.provider !== provider || selected.id !== model) {
      throw new Error("Pi Runtime did not select the requested Provider and Model.");
    }
    if (locator && state.sessionId !== locator.sessionId) {
      throw new Error("Pi Runtime resumed a different Session than requested.");
    }
  }

  #locatorFromState(
    conversationId: string,
    state: Record<string, unknown>,
    workspaceRoot: string | null,
    requireOpenable = true,
  ): PiSessionLocator {
    if (typeof state.sessionFile !== "string" || typeof state.sessionId !== "string") {
      throw new Error("Pi Runtime did not return a persistent Session locator.");
    }
    const locator: PiSessionLocator = {
      sessionFile: resolve(state.sessionFile),
      sessionId: state.sessionId,
      piVersion: SCOPEGUARD_PI_VERSION,
      sessionVersion: SCOPEGUARD_PI_SESSION_VERSION,
    };
    const sessionDirectory = this.#sessionDirectory(conversationId);
    const fromRoot = relative(sessionDirectory, locator.sessionFile);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot === "") {
      throw new Error("Pi Runtime returned a Session locator outside its Conversation directory.");
    }
    if (requireOpenable) this.validateLocator(conversationId, locator, workspaceRoot);
    return locator;
  }
}

export class PiEffectUnknownError extends Error {
  override name = "PiEffectUnknownError";
}

function parseApprovalRequest(processId: string, record: Record<string, unknown>): PiApprovalRequest {
  if (record.method !== "confirm" || typeof record.id !== "string" || typeof record.message !== "string") {
    throw new PiProtocolError("Unsupported extension UI request.");
  }
  const payload = JSON.parse(record.message) as Record<string, unknown>;
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.toolCallId !== "string" ||
    typeof payload.toolName !== "string" ||
    !payload.canonicalInput ||
    typeof payload.canonicalInput !== "object" ||
    Array.isArray(payload.canonicalInput) ||
    typeof payload.canonicalInputSha256 !== "string"
  ) {
    throw new PiProtocolError("Malformed ScopeGuard approval payload.");
  }
  const canonicalInput = payload.canonicalInput as Record<string, unknown>;
  const canonical = canonicalizeToolInput(canonicalInput);
  if (hashCanonicalInput(canonical) !== payload.canonicalInputSha256) {
    throw new PiProtocolError("ScopeGuard approval payload hash mismatch.");
  }
  return {
    processId,
    requestId: record.id,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    canonicalInput,
    canonicalInputSha256: payload.canonicalInputSha256,
  };
}

function successData(record: Record<string, unknown>, command: string): Record<string, unknown> {
  if (record.type !== "response" || record.command !== command || record.success !== true) {
    throw new PiProtocolError(`Pi RPC command failed: ${command}: ${String(record.error ?? "unknown")}`);
  }
  return (record.data ?? {}) as Record<string, unknown>;
}

function approvalWithTimeout(
  approval: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    approval.then(
      (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed === true);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function cleanEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    if (/^(HTTP|HTTPS|ALL)_PROXY$/i.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra, NO_PROXY: "127.0.0.1,localhost" };
}

function isSideEffectingTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "write" || toolName === "edit";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function projectMessageEntry(entry: SessionMessageEntry, index: number): ConversationMessage[] {
  const message = entry.message as unknown as Record<string, unknown>;
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return [];
  const content = projectContent(message, role);
  if (content.length === 0) return [];
  return [{
    id: entry.id,
    conversationId: "",
    runId: null,
    sequence: index + 1,
    role: role === "toolResult" ? "tool" : role,
    status: "committed",
    content,
    metadata: { runtime: "pi", timestamp: message.timestamp },
    createdAt: entry.timestamp,
  }];
}

function projectContent(message: Record<string, unknown>, role: string): MessageContentBlock[] {
  const raw = message.content;
  if (typeof raw === "string") return raw ? [{ type: "text", text: raw }] : [];
  if (!Array.isArray(raw)) return [];
  const blocks: MessageContentBlock[] = [];
  for (const part of raw as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
      blocks.push({
        type: "tool-call",
        toolCallId: part.id,
        providerCallId: part.id,
        name: part.name,
        arguments: (part.arguments ?? {}) as Record<string, unknown>,
      });
    }
  }
  if (role === "toolResult" && typeof message.toolCallId === "string") {
    return [{
      type: "tool-result",
      toolCallId: message.toolCallId,
      providerCallId: message.toolCallId,
      name: String(message.toolName ?? "tool"),
      output: blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
      isError: message.isError === true,
    }];
  }
  return blocks;
}
