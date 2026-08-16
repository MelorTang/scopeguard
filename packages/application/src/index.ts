import { createHash, randomUUID } from "node:crypto";

import {
  NativeAgentRuntime,
  type ModelMessage,
  type NativeAgentRunObserver,
  type ProviderAdapter,
  type ProviderCredentials,
  type ToolExecutionResult,
  type ToolRegistry,
} from "@scopeguard/agent-runtime";
import {
  canTransitionRun,
  normalizeProviderBaseUrl,
  validateProviderProfileInput,
  type Agent,
  type AgentRun,
  type AgentToolPolicy,
  type ApprovalDecision,
  type Conversation,
  type ConversationMessage,
  type CreateAgentInput,
  type CreateConversationInput,
  type CreateWorkspaceInput,
  type Id,
  type MessageContentBlock,
  type ManagedExecutionProgress,
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderProtocol,
  type RunConfigSnapshot,
  type RunEvent,
  type RunRequestManifest,
  type RunStatus,
  type RunUsageRecord,
  type StartRunInput,
  type ToolApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type UpdateConversationSettingsInput,
  type Workspace,
  type WorkspaceContextRevision,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

export interface WorkspaceStore {
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  getWorkspace(workspaceId: Id): Workspace | null;
  createWorkspace(input: CreateWorkspaceInput): Workspace;

  getProviderProfile(providerProfileId: Id): ProviderProfile | null;
  saveProviderProfile(
    input: ProviderProfileInput & { id?: Id },
    apiKeyRef: string | null,
  ): ProviderProfile;
  deleteProviderProfile(providerProfileId: Id): void;

  getAgent(agentId: Id): Agent | null;
  createAgent(input: CreateAgentInput): Agent;
  getConversation(conversationId: Id): Conversation | null;
  createConversation(input: CreateConversationInput): Conversation;
  updateConversationSettings(
    input: UpdateConversationSettingsInput,
  ): Conversation;
  listConversationMessages(conversationId: Id): ConversationMessage[];
  appendMessage(
    input: Omit<ConversationMessage, "id" | "sequence" | "createdAt">,
  ): ConversationMessage;
  saveRunPartial(runId: Id, content: string): void;
  clearRunPartial(runId: Id): void;

  createRun(
    conversationId: Id,
    triggerMessageId: Id,
    contextRevisionId: Id | null,
    configSnapshot: RunConfigSnapshot,
  ): AgentRun;
  getRun(runId: Id): AgentRun | null;
  listActiveRuns(): AgentRun[];
  updateRunStatus(runId: Id, status: RunStatus, error?: string): AgentRun;
  interruptNonTerminalRuns(): number;
  appendRunEvent(event: RunEvent): void;
  recordRunRequestManifest(
    input: Omit<RunRequestManifest, "createdAt">,
  ): RunRequestManifest;
  appendRunUsageRecord(
    input: Omit<RunUsageRecord, "sequence" | "receivedAt">,
  ): RunUsageRecord;

  createToolCall(
    runId: Id,
    input: {
      providerCallId: string;
      name: string;
      description: string;
      arguments: Record<string, unknown>;
    },
  ): ToolCallRecord;
  getToolCall(toolCallId: Id): ToolCallRecord | null;
  listToolCallsForRun(runId: Id): ToolCallRecord[];
  updateToolCallStatus(
    toolCallId: Id,
    status: ToolCallStatus,
    result?: ToolExecutionResult,
  ): ToolCallRecord;
  createApproval(runId: Id, toolCallId: Id, reason: string): ToolApproval;
  resolveApproval(approvalId: Id, decision: ApprovalDecision): ToolApproval;
  expirePendingApprovalsForRun(runId: Id): number;
  expirePendingApprovalsForTerminalRuns(): number;
  cancelUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[];
  recoverUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[];

  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null;
  updateWorkspaceContext(
    workspaceId: Id,
    content: string,
    sourceConversationId?: Id | null,
    sourceRunId?: Id | null,
  ): WorkspaceContextRevision;
}

export interface SecretVault {
  put(reference: string, secret: string): Promise<string>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export type ProviderAdapterFactory = (protocol: ProviderProtocol) => ProviderAdapter;
export type RunEventPublisher = (event: RunEvent) => void;

export type SaveProviderProfileInput = ProviderProfileInput & {
  id?: Id;
  clearApiKey?: boolean;
};

export interface ScopeGuardCore {
  initialize(): { interruptedRuns: number };
  shutdown(): Promise<void>;
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  createWorkspace(input: CreateWorkspaceInput): Workspace;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  deleteProviderProfile(providerProfileId: Id): Promise<void>;
  testProviderConnection(
    input: SaveProviderProfileInput,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionResult>;
  createAgent(input: CreateAgentInput): Agent;
  createConversation(input: CreateConversationInput): Conversation;
  updateConversationSettings(
    input: UpdateConversationSettingsInput,
  ): Conversation;
  listConversationMessages(conversationId: Id): ConversationMessage[];
  startRun(input: StartRunInput): Promise<AgentRun>;
  cancelRun(runId: Id): Promise<void>;
  resolveApproval(
    approvalId: Id,
    decision: ApprovalDecision,
  ): Promise<void>;
  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null;
  updateWorkspaceContext(
    workspaceId: Id,
    content: string,
    sourceConversationId?: Id | null,
    sourceRunId?: Id | null,
  ): WorkspaceContextRevision;
}

type ActiveRun = {
  controller: AbortController;
  settled: Promise<void>;
};

type PartialOutputState = {
  text: string;
  checkpointedLength: number;
  checkpointedAt: number;
};

const HOST_SHUTDOWN_ABORT_NAME = "ScopeGuardHostShutdown";
const HOST_SHUTDOWN_MESSAGE =
  "The agent host stopped before this run completed.";
const PARTIAL_CHECKPOINT_INTERVAL_MS = 250;
const PARTIAL_CHECKPOINT_CHARACTERS = 4_096;
const NO_TOOLS: ToolRegistry = {
  definitions: () => [],
  get: () => null,
};

export class ScopeGuardApplication implements ScopeGuardCore {
  readonly #store: WorkspaceStore;
  readonly #secrets: SecretVault;
  readonly #providerFactory: ProviderAdapterFactory;
  readonly #tools: ToolRegistry;
  readonly #publish: RunEventPublisher;
  readonly #activeRuns = new Map<Id, ActiveRun>();
  readonly #approvals = new ApprovalWaiters();
  readonly #inputs = new InputWaiters();

  constructor(options: {
    store: WorkspaceStore;
    secrets: SecretVault;
    providerFactory: ProviderAdapterFactory;
    tools: ToolRegistry;
    publish?: RunEventPublisher;
  }) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#providerFactory = options.providerFactory;
    this.#tools = options.tools;
    this.#publish = options.publish ?? (() => {});
  }

  initialize(): { interruptedRuns: number } {
    const recoverableRunIds = this.#store.listActiveRuns().map((run) => run.id);
    const interruptedRuns = this.#store.interruptNonTerminalRuns();
    for (const runId of recoverableRunIds) {
      const run = this.#store.getRun(runId);
      if (!run || run.status !== "interrupted") {
        continue;
      }
      const conversation = this.#store.getConversation(run.conversationId);
      if (!conversation) {
        continue;
      }
      this.persistRecoveredToolCallResults(
        run,
        conversation,
        this.#store.recoverUnfinishedToolCallsForRun(runId),
      );
      this.emitStatus(run);
    }
    this.#store.expirePendingApprovalsForTerminalRuns();
    return { interruptedRuns };
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return this.#store.getWorkspaceSnapshot();
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Workspace name is required.");
    }
    assertMaximumLength(name, 200, "Workspace name");
    const localRootPath = input.localRootPath?.trim() || null;
    if (localRootPath) {
      assertMaximumLength(localRootPath, 4096, "Workspace local root path");
    }
    return this.#store.createWorkspace({ name, localRootPath });
  }

  async saveProviderProfile(
    rawInput: SaveProviderProfileInput,
  ): Promise<ProviderProfile> {
    const input = validateProviderProfileInput(rawInput);
    if (Object.keys(input.customHeaders ?? {}).length > 0) {
      throw new Error(
        "Custom headers are disabled until they can be stored in the SecretVault.",
      );
    }
    if (rawInput.clearApiKey && input.apiKey) {
      throw new Error("Cannot set and clear an API key in the same update.");
    }
    const id = rawInput.id ?? randomUUID();
    const existing = rawInput.id
      ? this.#store.getProviderProfile(rawInput.id)
      : null;
    const cleanInput = {
      ...input,
      id,
      apiKey: undefined,
      customHeaders: {},
    };

    if (rawInput.clearApiKey && existing?.apiKeyRef) {
      const saved = this.#store.saveProviderProfile(cleanInput, null);
      try {
        await this.#secrets.delete(existing.apiKeyRef);
      } catch (error) {
        this.#store.saveProviderProfile(
          providerToInput(existing),
          existing.apiKeyRef,
        );
        throw error;
      }
      return saved;
    }

    if (!input.apiKey) {
      return this.#store.saveProviderProfile(
        cleanInput,
        existing?.apiKeyRef ?? null,
      );
    }

    const newReference = await this.#secrets.put(
      `provider:${id}:${randomUUID()}`,
      input.apiKey,
    );
    let saved: ProviderProfile;
    try {
      saved = this.#store.saveProviderProfile(cleanInput, newReference);
    } catch (error) {
      await this.#secrets.delete(newReference);
      throw error;
    }

    if (existing?.apiKeyRef && existing.apiKeyRef !== newReference) {
      try {
        await this.#secrets.delete(existing.apiKeyRef);
      } catch (error) {
        try {
          this.#store.saveProviderProfile(
            providerToInput(existing),
            existing.apiKeyRef,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Provider was saved, but the previous credential could not be cleaned up.",
          );
        }
        await this.#secrets.delete(newReference);
        throw error;
      }
    }
    return saved;
  }

  async deleteProviderProfile(providerProfileId: Id): Promise<void> {
    const profile = this.requireProviderProfile(providerProfileId);
    this.#store.deleteProviderProfile(providerProfileId);
    if (!profile.apiKeyRef) {
      return;
    }
    try {
      await this.#secrets.delete(profile.apiKeyRef);
    } catch (error) {
      try {
        this.#store.saveProviderProfile(
          providerToInput(profile),
          profile.apiKeyRef,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Provider was deleted, but credential cleanup and rollback both failed.",
        );
      }
      throw error;
    }
  }

  async testProviderConnection(
    rawInput: SaveProviderProfileInput,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<ProviderConnectionResult> {
    const input = validateProviderProfileInput(rawInput);
    if (Object.keys(input.customHeaders ?? {}).length > 0) {
      throw new Error(
        "Custom headers are disabled until they can be stored in the SecretVault.",
      );
    }
    const existing = rawInput.id
      ? this.#store.getProviderProfile(rawInput.id)
      : null;
    const apiKey = input.apiKey
      ?? (existing?.apiKeyRef ? await this.#secrets.get(existing.apiKeyRef) : null);
    return this.#providerFactory(input.protocol).testConnection(
      {
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey,
        model: input.defaultModel,
        customHeaders: {},
      },
      signal,
    );
  }

  createAgent(input: CreateAgentInput): Agent {
    const workspace = this.requireWorkspace(input.workspaceId);
    if (!input.name.trim()) {
      throw new Error("Agent name is required.");
    }
    assertMaximumLength(input.name.trim(), 200, "Agent name");
    assertMaximumLength(input.instructions, 50_000, "Agent instructions");
    this.requireProviderProfile(input.providerProfileId);

    return this.#store.createAgent({
      ...input,
      workspaceId: workspace.id,
    });
  }

  createConversation(input: CreateConversationInput): Conversation {
    const workspace = this.requireWorkspace(input.workspaceId);
    const agent = this.requireAgent(input.agentId);
    if (agent.workspaceId !== workspace.id) {
      throw new Error("Agent and Conversation must belong to the same Workspace.");
    }
    if (input.title) {
      assertMaximumLength(input.title.trim(), 300, "Conversation title");
    }
    return this.#store.createConversation(input);
  }

  updateConversationSettings(
    input: UpdateConversationSettingsInput,
  ): Conversation {
    const conversation = this.requireConversation(input.conversationId);
    const modelOverride = input.modelOverride === undefined
      ? undefined
      : input.modelOverride?.trim() || null;
    if (modelOverride) {
      assertMaximumLength(modelOverride, 512, "Model");
    }
    if (input.executionProfile === undefined && modelOverride === undefined) {
      throw new Error("No Conversation settings were provided.");
    }
    return this.#store.updateConversationSettings({
      conversationId: conversation.id,
      modelOverride,
      executionProfile: input.executionProfile,
    });
  }

  listConversationMessages(conversationId: Id): ConversationMessage[] {
    this.requireConversation(conversationId);
    return this.#store.listConversationMessages(conversationId);
  }

  async startRun(input: StartRunInput): Promise<AgentRun> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("Message cannot be empty.");
    }
    assertMaximumLength(prompt, 100_000, "Message");
    const conversation = this.requireConversation(input.conversationId);
    const activeConversationRun = this.#store.listActiveRuns().find(
      (run) => run.conversationId === conversation.id,
    );
    if (activeConversationRun?.status === "waiting-input") {
      return this.#provideRunInput(activeConversationRun, conversation, prompt);
    }
    if (activeConversationRun) {
      throw new Error("This Conversation already has an active Run.");
    }
    const agent = this.requireAgent(conversation.agentId);
    const workspace = this.requireWorkspace(conversation.workspaceId);
    const context = this.#store.getWorkspaceContext(workspace.id);
    const provider = this.requireProviderProfile(agent.providerProfileId);

    const toolPolicy = workspace.localRootPath
      ? effectiveToolPolicy(conversation.executionProfile, agent.toolPolicy)
      : {
          readFiles: "deny" as const,
          writeFiles: "deny" as const,
          runCommands: "deny" as const,
        };

    const trigger = this.#store.appendMessage({
      conversationId: conversation.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: prompt }],
      metadata: {},
    });
    const snapshot: RunConfigSnapshot = {
      agentId: agent.id,
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: conversation.modelOverride ?? agent.modelOverride ?? provider.defaultModel,
      instructions: agent.instructions,
      executionProfile: conversation.executionProfile,
      toolPolicy,
    };
    const run = this.#store.createRun(
      conversation.id,
      trigger.id,
      context?.id ?? null,
      snapshot,
    );
    this.emitStatus(run);
    this.emitMessage(run, conversation, trigger);

    const controller = new AbortController();
    const execution = this.#executeNativeRun({
      run,
      conversation,
      workspace,
      agent,
      provider,
      context,
      controller,
    });
    const settled = execution.finally(() => {
      this.#approvals.cancelRun(run.id);
      this.#inputs.cancelRun(run.id);
      this.#store.expirePendingApprovalsForRun(run.id);
      this.finalizeCancelledToolCalls(run, conversation);
      this.#activeRuns.delete(run.id);
    });
    this.#activeRuns.set(run.id, {
      controller,
      settled,
    });
    return run;
  }

  async cancelRun(runId: Id): Promise<void> {
    const active = this.#activeRuns.get(runId);
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (!active) {
      return;
    }
    if (canTransitionRun(run.status, "cancelling")) {
      this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
    }
    active.controller.abort(new DOMException("Run cancelled by the user.", "AbortError"));
    this.#approvals.cancelRun(run.id);
    this.#inputs.cancelRun(run.id);
    await active.settled;
  }

  async resolveApproval(
    approvalId: Id,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = this.#store.resolveApproval(approvalId, decision);
    this.#approvals.resolve(approval.id, decision);
  }

  #provideRunInput(
    run: AgentRun,
    conversation: Conversation,
    answer: string,
  ): AgentRun {
    if (!this.#inputs.has(run.id)) {
      throw new Error(
        "This input request can no longer resume. Retry the interrupted conversation.",
      );
    }
    const message = this.#store.appendMessage({
      conversationId: conversation.id,
      runId: run.id,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: answer }],
      metadata: { inputResponse: true },
    });
    this.emitMessage(run, conversation, message);
    this.#inputs.resolve(run.id, answer);
    return this.requireRun(run.id);
  }

  getWorkspaceContext(workspaceId: Id): WorkspaceContextRevision | null {
    this.requireWorkspace(workspaceId);
    return this.#store.getWorkspaceContext(workspaceId);
  }

  updateWorkspaceContext(
    workspaceId: Id,
    content: string,
    sourceConversationId?: Id | null,
    sourceRunId?: Id | null,
  ): WorkspaceContextRevision {
    this.requireWorkspace(workspaceId);
    assertMaximumLength(content, 200_000, "Workspace Context");
    let sourceConversation: Conversation | null = null;
    if (sourceConversationId) {
      sourceConversation = this.requireConversation(sourceConversationId);
      if (sourceConversation.workspaceId !== workspaceId) {
        throw new Error(
          "Context source Conversation belongs to a different Workspace.",
        );
      }
    }
    if (sourceRunId) {
      const run = this.requireRun(sourceRunId);
      const runConversation = this.requireConversation(run.conversationId);
      if (runConversation.workspaceId !== workspaceId) {
        throw new Error("Context source Run belongs to a different Workspace.");
      }
      if (sourceConversation && sourceConversation.id !== runConversation.id) {
        throw new Error("Context source Run belongs to a different Conversation.");
      }
    }
    return this.#store.updateWorkspaceContext(
      workspaceId,
      content.trim(),
      sourceConversationId ?? null,
      sourceRunId ?? null,
    );
  }

  async waitForRun(runId: Id): Promise<AgentRun> {
    await this.#activeRuns.get(runId)?.settled;
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  async shutdown(): Promise<void> {
    const activeRuns = [...this.#activeRuns.entries()];
    for (const [runId, active] of activeRuns) {
      const reason = new Error(HOST_SHUTDOWN_MESSAGE);
      reason.name = HOST_SHUTDOWN_ABORT_NAME;
      active.controller.abort(reason);
      this.#approvals.cancelRun(runId);
      this.#inputs.cancelRun(runId);
    }
    await Promise.allSettled(activeRuns.map(([, active]) => active.settled));
  }

  async #executeNativeRun(input: {
    run: AgentRun;
    conversation: Conversation;
    workspace: Workspace;
    agent: Agent;
    provider: ProviderProfile;
    context: WorkspaceContextRevision | null;
    controller: AbortController;
  }): Promise<void> {
    const {
      run,
      conversation,
      workspace,
      agent,
      provider,
      context,
      controller,
    } = input;
    const sensitiveValues: string[] = [];
    const partial: PartialOutputState = {
      text: "",
      checkpointedLength: 0,
      checkpointedAt: 0,
    };
    try {
      this.emitStatus(this.#store.updateRunStatus(run.id, "preparing"));
      const apiKey = provider.apiKeyRef
        ? await this.#secrets.get(provider.apiKeyRef)
        : null;
      if (apiKey) {
        sensitiveValues.push(apiKey);
      }
      throwIfAborted(controller.signal);
      const credentials: ProviderCredentials = {
        protocol: run.configSnapshot.providerProtocol ?? provider.protocol,
        baseUrl: normalizeProviderBaseUrl(
          run.configSnapshot.providerBaseUrl ?? provider.baseUrl,
        ),
        apiKey,
        model: run.configSnapshot.model ?? provider.defaultModel,
        customHeaders: {},
      };
      const history = toModelMessages(
        this.#store.listConversationMessages(conversation.id),
        agent,
        workspace,
        context,
      );
      this.emitStatus(this.#store.updateRunStatus(run.id, "running"));

      const runtime = new NativeAgentRuntime(
        this.#providerFactory(credentials.protocol),
        workspace.localRootPath ? this.#tools : NO_TOOLS,
      );
      await runtime.run(
        {
          workspaceId: workspace.id,
          workspaceRoot: workspace.localRootPath ?? "",
          conversationId: conversation.id,
          runId: run.id,
          credentials,
          messages: history,
          executionProfile: run.configSnapshot.executionProfile,
          toolPolicy: run.configSnapshot.toolPolicy,
          onManagedExecutionEvent: (progress) => {
            this.emitManagedExecution(run, conversation, progress);
          },
          signal: controller.signal,
        },
        this.createObserver(run, conversation, controller.signal, partial),
      );
      throwIfAborted(controller.signal);
      this.emitStatus(this.#store.updateRunStatus(run.id, "completed"));
    } catch (error) {
      this.persistInterruptedText(run, conversation, partial.text);
      const current = this.#store.getRun(run.id);
      if (!current || isTerminalStatus(current.status)) {
        return;
      }
      if (isHostShutdown(controller.signal)) {
        if (canTransitionRun(current.status, "interrupted")) {
          this.emitStatus(
            this.#store.updateRunStatus(
              run.id,
              "interrupted",
              HOST_SHUTDOWN_MESSAGE,
            ),
          );
        }
        return;
      }
      if (controller.signal.aborted) {
        if (canTransitionRun(current.status, "cancelling")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
        }
        const cancelling = this.#store.getRun(run.id);
        if (cancelling && canTransitionRun(cancelling.status, "cancelled")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelled"));
        }
        return;
      }
      const message = redactExactSecrets(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      );
      if (canTransitionRun(current.status, "failed")) {
        this.emitStatus(this.#store.updateRunStatus(run.id, "failed", message));
      }
    }
  }

  createObserver(
    run: AgentRun,
    conversation: Conversation,
    signal: AbortSignal,
    partial: PartialOutputState,
  ): NativeAgentRunObserver {
    return {
      onRequestManifest: (input) => {
        const manifestContent = {
          providerProtocol: input.providerProtocol,
          model: input.model,
          messages: input.messages,
          tools: input.tools,
          maxOutputTokens: input.maxOutputTokens,
        };
        this.#store.recordRunRequestManifest({
          runId: run.id,
          stepSequence: input.stepSequence,
          ...manifestContent,
          requestHash: createHash("sha256")
            .update(canonicalJson(manifestContent))
            .digest("hex"),
        });
      },
      onTextDelta: (delta) => {
        partial.text += delta;
        this.checkpointPartial(run.id, partial);
        this.#publish({
          type: "assistant-delta",
          runId: run.id,
          conversationId: conversation.id,
          delta,
          at: new Date().toISOString(),
        });
      },
      onUsage: (usage) => {
        const unavailable = usage.status === "unavailable";
        this.#store.appendRunUsageRecord({
          runId: run.id,
          stepSequence: usage.stepSequence,
          source: "provider",
          status: usage.status,
          inputTokens: unavailable
            ? null
            : normalizeTokenCount(usage.inputTokens, "inputTokens"),
          outputTokens: unavailable
            ? null
            : normalizeTokenCount(usage.outputTokens, "outputTokens"),
        });
      },
      onAssistantTurn: async (turn) => {
        const callIds: Record<string, Id> = {};
        const blocks: MessageContentBlock[] = [];
        let inputRequest = false;
        if (turn.content) {
          blocks.push({ type: "text", text: turn.content });
        }
        for (const call of turn.toolCalls) {
          if (call.name === "request_user_input") {
            inputRequest = true;
            const question = typeof call.arguments.question === "string"
              ? call.arguments.question.trim()
              : "";
            if (question && !turn.content.includes(question)) {
              blocks.push({ type: "text", text: question });
            }
          }
          const stored = this.#store.createToolCall(run.id, call);
          callIds[call.providerCallId] = stored.id;
          blocks.push({
            type: "tool-call",
            toolCallId: stored.id,
            providerCallId: call.providerCallId,
            name: call.name,
            arguments: call.arguments,
          });
          this.emitToolCall(run, conversation, stored);
        }
        const message = this.#store.appendMessage({
          conversationId: conversation.id,
          runId: run.id,
          role: "assistant",
          status: "committed",
          content: blocks,
          metadata: {
            finishReason: turn.finishReason,
            ...(inputRequest ? { inputRequest: true } : {}),
          },
        });
        this.#store.clearRunPartial(run.id);
        resetPartialOutput(partial);
        this.emitMessage(run, conversation, message);
        return callIds;
      },
      onToolCallStatus: (toolCallId, status, result) => {
        const toolCall = this.#store.updateToolCallStatus(
          toolCallId,
          status,
          result,
        );
        this.emitToolCall(run, conversation, toolCall);
      },
      requestApproval: async ({ toolCallId, description }) => {
        throwIfAborted(signal);
        const approval = this.#store.createApproval(
          run.id,
          toolCallId,
          description,
        );
        this.emitStatus(this.#store.updateRunStatus(run.id, "waiting-approval"));
        this.emitApproval(
          run,
          conversation,
          approval,
          this.requireToolCall(toolCallId),
        );
        const decision = await this.#approvals.wait(approval, signal);
        throwIfAborted(signal);
        const current = this.#store.getRun(run.id);
        if (current?.status === "waiting-approval") {
          this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
        }
        return decision;
      },
      requestInput: async () => {
        throwIfAborted(signal);
        this.emitStatus(this.#store.updateRunStatus(run.id, "waiting-input"));
        const answer = await this.#inputs.wait(run.id, signal);
        throwIfAborted(signal);
        const current = this.#store.getRun(run.id);
        if (current?.status === "waiting-input") {
          this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
        }
        return answer;
      },
      onToolResult: ({ toolCallId, providerCallId, name, result }) => {
        const message = this.#store.appendMessage({
          conversationId: conversation.id,
          runId: run.id,
          role: "tool",
          status: "committed",
          content: [{
            type: "tool-result",
            toolCallId,
            providerCallId,
            name,
            output: result.output,
            isError: result.isError,
          }],
          metadata: {},
        });
        this.emitMessage(run, conversation, message);
      },
    };
  }

  requireWorkspace(workspaceId: Id): Workspace {
    const workspace = this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace;
  }

  requireProviderProfile(providerProfileId: Id): ProviderProfile {
    const provider = this.#store.getProviderProfile(providerProfileId);
    if (!provider) {
      throw new Error(`Provider Profile not found: ${providerProfileId}`);
    }
    return provider;
  }

  requireAgent(agentId: Id): Agent {
    const agent = this.#store.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return agent;
  }

  requireConversation(conversationId: Id): Conversation {
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  requireRun(runId: Id): AgentRun {
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  requireToolCall(toolCallId: Id): ToolCallRecord {
    const toolCall = this.#store.getToolCall(toolCallId);
    if (!toolCall) {
      throw new Error(`Tool call not found: ${toolCallId}`);
    }
    return toolCall;
  }

  finalizeCancelledToolCalls(run: AgentRun, conversation: Conversation): void {
    const toolCalls = this.#store.cancelUnfinishedToolCallsForRun(run.id);
    const resultIds = new Set(
      this.#store.listConversationMessages(conversation.id)
        .filter((message) => message.runId === run.id)
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool-result")
        .map((block) => block.toolCallId),
    );
    for (const toolCall of toolCalls) {
      if (toolCall.status !== "cancelled" || resultIds.has(toolCall.id)) {
        continue;
      }
      const message = this.#store.appendMessage({
        conversationId: conversation.id,
        runId: run.id,
        role: "tool",
        status: "interrupted",
        content: [{
          type: "tool-result",
          toolCallId: toolCall.id,
          providerCallId: toolCall.providerCallId,
          name: toolCall.name,
          output: "Tool call cancelled before completion.",
          isError: true,
        }],
        metadata: { synthetic: true },
      });
      this.emitMessage(run, conversation, message);
    }
  }

  persistRecoveredToolCallResults(
    run: AgentRun,
    conversation: Conversation,
    toolCalls: ToolCallRecord[],
  ): void {
    const resultIds = new Set(
      this.#store.listConversationMessages(conversation.id)
        .filter((message) => message.runId === run.id)
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool-result")
        .map((block) => block.toolCallId),
    );
    for (const toolCall of toolCalls) {
      if (resultIds.has(toolCall.id)) {
        continue;
      }
      const effectUnknown = toolCall.status === "effect_unknown";
      this.emitToolCall(run, conversation, toolCall);
      const message = this.#store.appendMessage({
        conversationId: conversation.id,
        runId: run.id,
        role: "tool",
        status: "interrupted",
        content: [{
          type: "tool-result",
          toolCallId: toolCall.id,
          providerCallId: toolCall.providerCallId,
          name: toolCall.name,
          output: effectUnknown
            ? "Tool execution stopped before ScopeGuard could confirm the result. The effect is unknown. Verify the external state before retrying."
            : "Tool call cancelled before execution.",
          isError: true,
        }],
        metadata: { synthetic: true, effectUnknown },
      });
      this.emitMessage(run, conversation, message);
    }
  }

  persistInterruptedText(
    run: AgentRun,
    conversation: Conversation,
    text: string,
  ): void {
    if (!text.trim()) {
      this.#store.clearRunPartial(run.id);
      return;
    }
    const message = this.#store.appendMessage({
      conversationId: conversation.id,
      runId: run.id,
      role: "assistant",
      status: "interrupted",
      content: [{ type: "text", text }],
      metadata: { partial: true },
    });
    this.#store.clearRunPartial(run.id);
    this.emitMessage(run, conversation, message);
  }

  checkpointPartial(runId: Id, partial: PartialOutputState): void {
    const now = Date.now();
    if (
      !partial.text ||
      (
        partial.checkpointedLength > 0 &&
        now - partial.checkpointedAt < PARTIAL_CHECKPOINT_INTERVAL_MS &&
        partial.text.length - partial.checkpointedLength <
          PARTIAL_CHECKPOINT_CHARACTERS
      )
    ) {
      return;
    }
    this.#store.saveRunPartial(runId, partial.text);
    partial.checkpointedLength = partial.text.length;
    partial.checkpointedAt = now;
  }

  emitStatus(run: AgentRun): void {
    const event: RunEvent = {
      type: "run-status",
      runId: run.id,
      conversationId: run.conversationId,
      status: run.status,
      at: new Date().toISOString(),
      error: run.error ?? undefined,
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitMessage(
    run: AgentRun,
    conversation: Conversation,
    message: ConversationMessage,
  ): void {
    const event: RunEvent = {
      type: "message-created",
      runId: run.id,
      conversationId: conversation.id,
      message,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitToolCall(
    run: AgentRun,
    conversation: Conversation,
    toolCall: ToolCallRecord,
  ): void {
    const event: RunEvent = {
      type: "tool-call",
      runId: run.id,
      conversationId: conversation.id,
      toolCall,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitApproval(
    run: AgentRun,
    conversation: Conversation,
    approval: ToolApproval,
    toolCall: ToolCallRecord,
  ): void {
    const event: RunEvent = {
      type: "approval-required",
      runId: run.id,
      conversationId: conversation.id,
      approval,
      toolCall,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitManagedExecution(
    run: AgentRun,
    conversation: Conversation,
    progress: ManagedExecutionProgress,
  ): void {
    const event: RunEvent = {
      type: "managed-execution",
      runId: run.id,
      conversationId: conversation.id,
      progress,
      at: progress.at,
    };
    if (!progress.chunk) {
      this.#store.appendRunEvent(event);
    }
    this.#publish(event);
  }
}

class ApprovalWaiters {
  readonly #waiters = new Map<
    Id,
    {
      runId: Id;
      resolve: (decision: ApprovalDecision) => void;
      reject: (error: unknown) => void;
      removeAbortListener: () => void;
    }
  >();

  wait(approval: ToolApproval, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiters.delete(approval.id);
        reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.set(approval.id, {
        runId: approval.runId,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      });
      if (signal.aborted) {
        abort();
      }
    });
  }

  resolve(approvalId: Id, decision: ApprovalDecision): void {
    const waiter = this.#waiters.get(approvalId);
    if (!waiter) {
      return;
    }
    this.#waiters.delete(approvalId);
    waiter.removeAbortListener();
    waiter.resolve(decision);
  }

  cancelRun(runId: Id): void {
    for (const [approvalId, waiter] of this.#waiters) {
      if (waiter.runId === runId) {
        this.#waiters.delete(approvalId);
        waiter.removeAbortListener();
        waiter.reject(new DOMException("Run cancelled.", "AbortError"));
      }
    }
  }
}

class InputWaiters {
  readonly #waiters = new Map<
    Id,
    {
      resolve: (answer: string) => void;
      reject: (error: unknown) => void;
      removeAbortListener: () => void;
    }
  >();

  wait(runId: Id, signal: AbortSignal): Promise<string> {
    if (this.#waiters.has(runId)) {
      throw new Error("This Run already has an active input request.");
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiters.delete(runId);
        reject(signal.reason ?? new DOMException("Run cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.set(runId, {
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      });
      if (signal.aborted) {
        abort();
      }
    });
  }

  has(runId: Id): boolean {
    return this.#waiters.has(runId);
  }

  resolve(runId: Id, answer: string): void {
    const waiter = this.#waiters.get(runId);
    if (!waiter) {
      throw new Error("This Run is not waiting for user input.");
    }
    this.#waiters.delete(runId);
    waiter.removeAbortListener();
    waiter.resolve(answer);
  }

  cancelRun(runId: Id): void {
    const waiter = this.#waiters.get(runId);
    if (!waiter) {
      return;
    }
    this.#waiters.delete(runId);
    waiter.removeAbortListener();
    waiter.reject(new DOMException("Run cancelled.", "AbortError"));
  }
}

function toModelMessages(
  messages: ConversationMessage[],
  agent: Agent,
  workspace: Workspace,
  context: WorkspaceContextRevision | null,
): ModelMessage[] {
  const systemSections = [
    agent.instructions.trim(),
    workspace.localRootPath
      ? `Local workspace folder: ${workspace.localRootPath}`
      : "",
    context
      ? `# Shared Workspace Context (revision ${context.version})\n${context.content}`
      : "",
    "Treat every other Conversation as isolated. Use only the shared context shown above.",
  ].filter(Boolean);
  const result: ModelMessage[] = [{
    role: "system",
    content: systemSections.join("\n\n"),
  }];
  const pendingToolCalls = new Map<
    string,
    { name: string }
  >();

  const closePendingToolCalls = () => {
    for (const [providerCallId, call] of pendingToolCalls) {
      result.push({
        role: "tool",
        toolCallId: providerCallId,
        name: call.name,
        content: "Tool call cancelled before completion.",
        isError: true,
      });
    }
    pendingToolCalls.clear();
  };

  for (const message of takeRecentMessages(messages, 300_000, 50)) {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (message.role === "assistant") {
      closePendingToolCalls();
      const toolCalls = message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => ({
          id: block.providerCallId,
          name: block.name,
          arguments: block.arguments,
        }));
      result.push({
        role: "assistant",
        content: text,
        toolCalls,
      });
      for (const call of toolCalls) {
        pendingToolCalls.set(call.id, { name: call.name });
      }
    } else if (message.role === "tool") {
      for (const block of message.content) {
        if (
          block.type === "tool-result" &&
          pendingToolCalls.has(block.providerCallId)
        ) {
          result.push({
            role: "tool",
            toolCallId: block.providerCallId,
            name: block.name,
            content: block.output,
            isError: block.isError,
          });
          pendingToolCalls.delete(block.providerCallId);
        }
      }
    } else if (message.role === "system" || message.role === "user") {
      closePendingToolCalls();
      result.push({ role: message.role, content: text });
    }
  }
  closePendingToolCalls();
  return result;
}

function takeRecentMessages(
  messages: ConversationMessage[],
  characterBudget: number,
  countLimit: number,
): ConversationMessage[] {
  const selected: ConversationMessage[] = [];
  let characters = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < countLimit;
    index -= 1
  ) {
    const message = messages[index]!;
    const size = JSON.stringify(message.content).length;
    if (selected.length > 0 && characters + size > characterBudget) {
      break;
    }
    selected.push(message);
    characters += size;
  }
  return selected.reverse();
}

function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function resetPartialOutput(partial: PartialOutputState): void {
  partial.text = "";
  partial.checkpointedLength = 0;
  partial.checkpointedAt = 0;
}

function isHostShutdown(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    reason instanceof Error &&
    reason.name === HOST_SHUTDOWN_ABORT_NAME
  );
}

function providerToInput(
  provider: ProviderProfile,
): ProviderProfileInput & { id: Id } {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    customHeaders: {},
  };
}

function redactExactSecrets(value: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      value,
    );
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested) => {
    if (
      nested &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
      );
    }
    return nested;
  });
  if (encoded === undefined) {
    throw new Error("Run request manifest is not JSON serializable.");
  }
  return encoded;
}

function normalizeTokenCount(
  value: number | undefined,
  field: string,
): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function assertMaximumLength(
  value: string,
  maximum: number,
  field: string,
): void {
  if (value.length > maximum) {
    throw new Error(`${field} must not exceed ${maximum} characters.`);
  }
}

function effectiveToolPolicy(
  profile: Agent["defaultExecutionProfile"],
  configured: AgentToolPolicy,
): AgentToolPolicy {
  const permission = (value: AgentToolPolicy["writeFiles"]) => {
    if (value === "deny") return "deny" as const;
    return profile === "request-approval" ? "ask" as const : "allow" as const;
  };
  return {
    readFiles: configured.readFiles,
    writeFiles: permission(configured.writeFiles),
    runCommands: permission(configured.runCommands),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Run cancelled.", "AbortError");
  }
}
