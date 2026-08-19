import { randomUUID } from "node:crypto";

import {
  PiEffectUnknownError,
  PiRuntimeSupervisor,
  type PiApprovalRequest,
} from "@scopeguard/pi-runtime";
import {
  canTransitionRun,
  normalizeProviderBaseUrl,
  validateProviderProfileInput,
  type Agent,
  type AgentRun,
  type ApprovalDecision,
  type Conversation,
  type ConversationMessage,
  type CreateAgentInput,
  type CreateConversationInput,
  type CreateWorkspaceInput,
  type Id,
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderProfileInput,
  type RunConfigSnapshot,
  type RunEvent,
  type RunStatus,
  type StartRunInput,
  type ToolApproval,
  type ToolCallRecord,
  type ToolPermission,
  type UpdateConversationSettingsInput,
  type Workspace,
  type WorkspaceContextRevision,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

export interface WorkspaceStore {
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  listConversations(workspaceId?: Id): Conversation[];
  getWorkspace(id: Id): Workspace | null;
  createWorkspace(input: CreateWorkspaceInput): Workspace;
  getProviderProfile(id: Id): ProviderProfile | null;
  saveProviderProfile(input: ProviderProfileInput & { id?: Id }, apiKeyRef: string | null): ProviderProfile;
  deleteProviderProfile(id: Id): void;
  getAgent(id: Id): Agent | null;
  createAgent(input: CreateAgentInput): Agent;
  getConversation(id: Id): Conversation | null;
  createConversation(input: CreateConversationInput): Conversation;
  updateConversationSettings(input: UpdateConversationSettingsInput): Conversation;
  setConversationSession(id: Id, locator: Conversation["piSession"] extends infer T ? Exclude<T, null> : never): Conversation;
  createRun(conversationId: Id, config: RunConfigSnapshot): AgentRun;
  getRun(id: Id): AgentRun | null;
  listActiveRuns(): AgentRun[];
  updateRunStatus(id: Id, status: RunStatus, error?: string, effect?: AgentRun["effect"]): AgentRun;
  interruptNonTerminalRuns(): number;
  createApproval(runId: Id, request: Omit<ToolApproval, "id" | "runId" | "status" | "createdAt" | "resolvedAt">): ToolApproval;
  resolveApproval(id: Id, decision: ApprovalDecision): ToolApproval;
  expireApproval(id: Id): ToolApproval;
  expirePendingApprovalsForRun(runId: Id): number;
  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null;
  updateWorkspaceContext(workspaceId: Id, content: string, sourceConversationId?: Id | null, sourceRunId?: Id | null): WorkspaceContextRevision;
}

export interface SecretVault {
  put(reference: string, secret: string): Promise<string>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export type SaveProviderProfileInput = ProviderProfileInput & { id?: Id; clearApiKey?: boolean };
export type RunEventPublisher = (event: RunEvent) => void;

export interface ScopeGuardCore {
  initialize(): { interruptedRuns: number };
  shutdown(): Promise<void>;
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  createWorkspace(input: CreateWorkspaceInput): Workspace;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  deleteProviderProfile(id: Id): Promise<void>;
  testProviderConnection(input: SaveProviderProfileInput, signal?: AbortSignal): Promise<ProviderConnectionResult>;
  createAgent(input: CreateAgentInput): Agent;
  createConversation(input: CreateConversationInput): Conversation;
  updateConversationSettings(input: UpdateConversationSettingsInput): Conversation;
  listConversationMessages(conversationId: Id): ConversationMessage[];
  startRun(input: StartRunInput): Promise<AgentRun>;
  cancelRun(runId: Id): Promise<void>;
  resolveApproval(approvalId: Id, decision: ApprovalDecision): Promise<void>;
  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null;
  updateWorkspaceContext(workspaceId: Id, content: string, sourceConversationId?: Id | null, sourceRunId?: Id | null): WorkspaceContextRevision;
}

type ActiveRun = { controller: AbortController; settled: Promise<void> };

export class ScopeGuardApplication implements ScopeGuardCore {
  readonly #store: WorkspaceStore;
  readonly #secrets: SecretVault;
  readonly #runtime: PiRuntimeSupervisor;
  readonly #publish: RunEventPublisher;
  readonly #approvalTimeoutMs: number;
  readonly #active = new Map<Id, ActiveRun>();
  readonly #approvals = new ApprovalWaiters();

  constructor(options: {
    store: WorkspaceStore;
    secrets: SecretVault;
    runtime: PiRuntimeSupervisor;
    publish?: RunEventPublisher;
    approvalTimeoutMs?: number;
  }) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#runtime = options.runtime;
    this.#publish = options.publish ?? (() => {});
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 180_000;
    if (!Number.isSafeInteger(this.#approvalTimeoutMs) || this.#approvalTimeoutMs <= 0) {
      throw new Error("Approval timeout must be a positive integer.");
    }
  }

  initialize(): { interruptedRuns: number } {
    const interruptedRuns = this.#store.interruptNonTerminalRuns();
    for (const conversation of this.#store.listConversations()) {
      if (!conversation.piSession) continue;
      const workspace = this.requireWorkspace(conversation.workspaceId);
      this.#runtime.validateLocator(conversation.id, conversation.piSession, workspace.localRootPath);
    }
    return { interruptedRuns };
  }

  async shutdown(): Promise<void> {
    for (const [runId, active] of this.#active) {
      active.controller.abort(new Error("ScopeGuard Desktop is shutting down."));
      this.#approvals.cancelRun(runId);
    }
    await Promise.allSettled([...this.#active.values()].map((active) => active.settled));
    await this.#runtime.shutdown();
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return this.#store.getWorkspaceSnapshot();
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const name = input.name.trim();
    if (!name) throw new Error("Workspace name is required.");
    assertLength(name, 200, "Workspace name");
    return this.#store.createWorkspace({ name, localRootPath: input.localRootPath?.trim() || null });
  }

  async saveProviderProfile(raw: SaveProviderProfileInput): Promise<ProviderProfile> {
    const input = validateProviderProfileInput(raw);
    if (Object.keys(input.customHeaders ?? {}).length > 0) {
      throw new Error("Custom Provider headers are not supported by the managed Pi Runtime.");
    }
    if (raw.clearApiKey && input.apiKey) throw new Error("Cannot set and clear an API key together.");
    const id = raw.id ?? randomUUID();
    const existing = raw.id ? this.#store.getProviderProfile(raw.id) : null;
    if (raw.clearApiKey) {
      const saved = this.#store.saveProviderProfile({ ...input, id, apiKey: undefined, customHeaders: {} }, null);
      if (existing?.apiKeyRef) await this.#secrets.delete(existing.apiKeyRef);
      return saved;
    }
    if (!input.apiKey) {
      return this.#store.saveProviderProfile(
        { ...input, id, apiKey: undefined, customHeaders: {} },
        existing?.apiKeyRef ?? null,
      );
    }
    const reference = await this.#secrets.put(`provider:${id}:${randomUUID()}`, input.apiKey);
    try {
      const saved = this.#store.saveProviderProfile(
        { ...input, id, apiKey: undefined, customHeaders: {} },
        reference,
      );
      if (existing?.apiKeyRef && existing.apiKeyRef !== reference) await this.#secrets.delete(existing.apiKeyRef);
      return saved;
    } catch (error) {
      await this.#secrets.delete(reference).catch(() => {});
      throw error;
    }
  }

  async deleteProviderProfile(id: Id): Promise<void> {
    const provider = this.requireProvider(id);
    this.#store.deleteProviderProfile(id);
    if (provider.apiKeyRef) await this.#secrets.delete(provider.apiKeyRef);
  }

  async testProviderConnection(raw: SaveProviderProfileInput): Promise<ProviderConnectionResult> {
    const input = validateProviderProfileInput(raw);
    const existing = raw.id ? this.#store.getProviderProfile(raw.id) : null;
    const apiKey = input.apiKey ?? (existing?.apiKeyRef ? await this.#secrets.get(existing.apiKeyRef) : null);
    const started = Date.now();
    try {
      await this.#runtime.probe({
        protocol: input.protocol,
        baseUrl: normalizeProviderBaseUrl(input.baseUrl),
        apiKey,
        model: input.defaultModel,
      });
      return { ok: true, latencyMs: Date.now() - started, model: input.defaultModel, message: "Pi Runtime provider probe succeeded." };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, model: input.defaultModel, message: errorMessage(error) };
    }
  }

  createAgent(input: CreateAgentInput): Agent {
    this.requireWorkspace(input.workspaceId);
    this.requireProvider(input.providerProfileId);
    if (!input.name.trim()) throw new Error("Agent name is required.");
    assertLength(input.instructions, 50_000, "Agent instructions");
    return this.#store.createAgent(input);
  }

  createConversation(input: CreateConversationInput): Conversation {
    const workspace = this.requireWorkspace(input.workspaceId);
    const agent = this.requireAgent(input.agentId);
    if (agent.workspaceId !== workspace.id) throw new Error("Agent and Conversation must share a Workspace.");
    return this.#store.createConversation(input);
  }

  updateConversationSettings(input: UpdateConversationSettingsInput): Conversation {
    this.requireConversation(input.conversationId);
    if (input.modelOverride === undefined && input.executionProfile === undefined) throw new Error("No Conversation settings supplied.");
    return this.#store.updateConversationSettings(input);
  }

  listConversationMessages(conversationId: Id): ConversationMessage[] {
    const conversation = this.requireConversation(conversationId);
    if (!conversation.piSession) return [];
    const workspace = this.requireWorkspace(conversation.workspaceId);
    this.#runtime.validateLocator(conversation.id, conversation.piSession, workspace.localRootPath);
    return this.#runtime.projectMessages(conversation.piSession).map((message) => ({
      ...message,
      conversationId,
    }));
  }

  async startRun(input: StartRunInput): Promise<AgentRun> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Message cannot be empty.");
    assertLength(prompt, 100_000, "Message");
    const conversation = this.requireConversation(input.conversationId);
    if (this.#store.listActiveRuns().some((run) => run.conversationId === conversation.id)) {
      throw new Error("This Conversation already has an active Run.");
    }
    const workspace = this.requireWorkspace(conversation.workspaceId);
    const agent = this.requireAgent(conversation.agentId);
    const provider = this.requireProvider(agent.providerProfileId);
    const config: RunConfigSnapshot = {
      agentId: agent.id,
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: conversation.modelOverride ?? agent.modelOverride ?? provider.defaultModel,
      instructions: agent.instructions,
      executionProfile: conversation.executionProfile,
      toolPolicy: agent.toolPolicy,
    };
    const run = this.#store.createRun(conversation.id, config);
    const pendingSequence = conversation.piSession
      ? this.listConversationMessages(conversation.id).length + 1
      : 1;
    this.emitStatus(run);
    this.#publish({
      type: "message-created",
      runId: run.id,
      conversationId: conversation.id,
      message: {
        id: `${run.id}:user`, conversationId: conversation.id, runId: run.id,
        sequence: pendingSequence, role: "user", status: "committed",
        content: [{ type: "text", text: prompt }], metadata: { runtime: "pi", pending: true },
        createdAt: new Date().toISOString(),
      },
      at: new Date().toISOString(),
    });
    const controller = new AbortController();
    const execution = this.#execute({ run, conversation, workspace, agent, provider, prompt, controller });
    const settled = execution.finally(() => {
      this.#approvals.cancelRun(run.id);
      this.#store.expirePendingApprovalsForRun(run.id);
      this.#active.delete(run.id);
    });
    this.#active.set(run.id, { controller, settled });
    return run;
  }

  async cancelRun(runId: Id): Promise<void> {
    const run = this.requireRun(runId);
    const active = this.#active.get(runId);
    if (!active) return;
    if (canTransitionRun(run.status, "cancelling")) this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
    active.controller.abort(new DOMException("Run cancelled by user.", "AbortError"));
    this.#approvals.cancelRun(runId);
    await active.settled;
  }

  async resolveApproval(id: Id, decision: ApprovalDecision): Promise<void> {
    const approval = this.#store.resolveApproval(id, decision);
    this.#approvals.resolve(approval.id, decision === "approved-once");
  }

  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null {
    this.requireWorkspace(workspaceId);
    return this.#store.getWorkspaceContext(workspaceId);
  }

  updateWorkspaceContext(workspaceId: Id, content: string, sourceConversationId?: Id | null, sourceRunId?: Id | null): WorkspaceContextRevision {
    this.requireWorkspace(workspaceId);
    assertLength(content, 200_000, "Workspace context");
    return this.#store.updateWorkspaceContext(workspaceId, content.trim(), sourceConversationId, sourceRunId);
  }

  async waitForRun(runId: Id): Promise<AgentRun> {
    await this.#active.get(runId)?.settled;
    return this.requireRun(runId);
  }

  async #execute(input: {
    run: AgentRun;
    conversation: Conversation;
    workspace: Workspace;
    agent: Agent;
    provider: ProviderProfile;
    prompt: string;
    controller: AbortController;
  }): Promise<void> {
    const { run, conversation, workspace, agent, provider, prompt, controller } = input;
    let apiKey: string | null = null;
    try {
      apiKey = provider.apiKeyRef ? await this.#secrets.get(provider.apiKeyRef) : null;
      this.emitStatus(this.#store.updateRunStatus(run.id, "preparing"));
      this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
      const result = await this.#runtime.run({
        conversationId: conversation.id,
        prompt,
        workspaceRoot: workspace.localRootPath,
        instructions: agent.instructions,
        provider: {
          protocol: provider.protocol,
          baseUrl: normalizeProviderBaseUrl(provider.baseUrl),
          apiKey,
          model: run.configSnapshot.model,
        },
        locator: conversation.piSession,
        readPermission: conversation.executionProfile === "full-access"
          ? "allow"
          : agent.toolPolicy.readFiles,
        signal: controller.signal,
        onSessionReady: (locator) => {
          this.#store.setConversationSession(conversation.id, locator);
        },
        onTextDelta: (delta) => this.#publish({
          type: "assistant-delta", runId: run.id, conversationId: conversation.id,
          delta, at: new Date().toISOString(),
        }),
        onApproval: (request) => this.#requestApproval(
          run,
          conversation,
          agent,
          request,
          controller.signal,
        ),
      });
      this.#store.setConversationSession(conversation.id, result.locator);
      const assistant = [...result.messages].reverse().find((message) => message.role === "assistant");
      if (assistant) this.#publish({
        type: "message-created", runId: run.id, conversationId: conversation.id,
        message: { ...assistant, conversationId: conversation.id, runId: run.id },
        at: new Date().toISOString(),
      });
      this.emitStatus(this.#store.updateRunStatus(run.id, "completed", undefined, result.effect));
    } catch (error) {
      const current = this.#store.getRun(run.id);
      if (!current || terminal(current.status)) return;
      const effect = error instanceof PiEffectUnknownError ? "effect_unknown" : current.effect;
      if (controller.signal.aborted) {
        if (canTransitionRun(current.status, "cancelling")) this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling", undefined, effect));
        const cancelling = this.#store.getRun(run.id)!;
        if (canTransitionRun(cancelling.status, "cancelled")) this.emitStatus(this.#store.updateRunStatus(run.id, "cancelled", undefined, effect));
      } else if (canTransitionRun(current.status, "failed")) {
        this.emitStatus(this.#store.updateRunStatus(run.id, "failed", redact(errorMessage(error), apiKey), effect));
      }
    }
  }

  async #requestApproval(
    run: AgentRun,
    conversation: Conversation,
    agent: Agent,
    request: PiApprovalRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const toolCallId = `${request.processId}:${request.toolCallId}`;
    const approval = this.#store.createApproval(run.id, {
      toolCallId,
      reason: `${request.toolName} requires explicit approval.`,
      processId: request.processId,
      requestId: request.requestId,
      piToolCallId: request.toolCallId,
      toolName: request.toolName,
      canonicalInput: request.canonicalInput,
      canonicalInputSha256: request.canonicalInputSha256,
    });
    const toolCall: ToolCallRecord = {
      id: toolCallId, runId: run.id, sequence: 0, providerCallId: request.toolCallId,
      name: request.toolName, description: approval.reason, arguments: request.canonicalInput,
      status: "awaiting-approval", output: null, error: null,
      createdAt: approval.createdAt, completedAt: null,
    };
    const permission = permissionForTool(agent, request.toolName);
    const executionProfile = conversation.executionProfile;
    if (executionProfile !== "request-approval" || permission === "deny") {
      const approved = permission !== "deny" && (
        executionProfile === "auto-approve" || executionProfile === "full-access"
      );
      this.#store.resolveApproval(
        approval.id,
        approved ? "approved-once" : "denied",
      );
      if (approved && isSideEffectingTool(request.toolName)) {
        this.emitStatus(this.#store.updateRunStatus(
          run.id,
          this.requireRun(run.id).status,
          undefined,
          "effect_unknown",
        ));
      }
      return approved;
    }
    this.emitStatus(this.#store.updateRunStatus(run.id, "waiting-approval"));
    this.#publish({
      type: "approval-required", runId: run.id, conversationId: conversation.id,
      approval, toolCall, at: new Date().toISOString(),
    });
    const outcome = await this.#approvals.wait(
      approval,
      signal,
      this.#approvalTimeoutMs,
    );
    if (outcome === "expired") this.#store.expireApproval(approval.id);
    const approved = outcome === "approved";
    const current = this.#store.getRun(run.id);
    if (current?.status === "waiting-approval") {
      this.emitStatus(this.#store.updateRunStatus(
        run.id,
        "running",
        undefined,
        approved && isSideEffectingTool(request.toolName)
          ? "effect_unknown"
          : current.effect,
      ));
    }
    return approved;
  }

  requireWorkspace(id: Id): Workspace {
    const value = this.#store.getWorkspace(id); if (!value) throw new Error(`Workspace not found: ${id}`); return value;
  }
  requireProvider(id: Id): ProviderProfile {
    const value = this.#store.getProviderProfile(id); if (!value) throw new Error(`Provider Profile not found: ${id}`); return value;
  }
  requireAgent(id: Id): Agent {
    const value = this.#store.getAgent(id); if (!value) throw new Error(`Agent not found: ${id}`); return value;
  }
  requireConversation(id: Id): Conversation {
    const value = this.#store.getConversation(id); if (!value) throw new Error(`Conversation not found: ${id}`); return value;
  }
  requireRun(id: Id): AgentRun {
    const value = this.#store.getRun(id); if (!value) throw new Error(`Run not found: ${id}`); return value;
  }

  emitStatus(run: AgentRun): void {
    this.#publish({
      type: "run-status", runId: run.id, conversationId: run.conversationId,
      status: run.status, error: run.error ?? undefined, at: new Date().toISOString(),
    });
  }
}

class ApprovalWaiters {
  readonly #values = new Map<Id, {
    runId: Id;
    resolve: (value: "approved" | "denied" | "expired") => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }>();

  wait(
    approval: ToolApproval,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<"approved" | "denied" | "expired"> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        this.#values.delete(approval.id);
        cleanup();
        reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        if (!this.#values.delete(approval.id)) return;
        cleanup();
        resolve("expired");
      }, timeoutMs);
      this.#values.set(approval.id, {
        runId: approval.runId, resolve, reject,
        cleanup,
      });
      if (signal.aborted) abort();
    });
  }

  resolve(id: Id, value: boolean): void {
    const waiter = this.#values.get(id); if (!waiter) return;
    this.#values.delete(id); waiter.cleanup(); waiter.resolve(value ? "approved" : "denied");
  }

  cancelRun(runId: Id): void {
    for (const [id, waiter] of this.#values) {
      if (waiter.runId !== runId) continue;
      this.#values.delete(id); waiter.cleanup(); waiter.reject(new DOMException("Run cancelled.", "AbortError"));
    }
  }
}

function terminal(status: RunStatus): boolean { return ["completed", "failed", "cancelled", "interrupted"].includes(status); }
function permissionForTool(agent: Agent, toolName: string): ToolPermission {
  const permission = toolName === "read"
    ? agent.toolPolicy.readFiles
    : toolName === "write" || toolName === "edit"
      ? agent.toolPolicy.writeFiles
      : toolName === "bash"
        ? agent.toolPolicy.runCommands
        : "deny";
  if (permission === "allow" || permission === "ask" || permission === "deny") {
    return permission;
  }
  return "deny";
}
function isSideEffectingTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "write" || toolName === "edit";
}
function assertLength(value: string, maximum: number, label: string): void { if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redact(value: string, secret: string | null): string { return secret ? value.split(secret).join("[REDACTED]") : value; }
