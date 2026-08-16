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
  type AgentProfile,
  type AgentRun,
  type AgentThread,
  type AgentToolPolicy,
  type ApprovalDecision,
  type ContextRevision,
  type CreateAgentProfileInput,
  type CreateProjectInput,
  type CreateThreadInput,
  type CreateWorkspaceInput,
  type Id,
  type MessageContentBlock,
  type ManagedExecutionProgress,
  type Project,
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
  type ThreadMessage,
  type ToolApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type UpdateThreadSettingsInput,
  type Workspace,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

export interface WorkspaceStore {
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  getWorkspace(workspaceId: Id): Workspace | null;
  createWorkspace(input: CreateWorkspaceInput): Workspace;
  getProject(projectId: Id): Project | null;
  addProject(input: CreateProjectInput): Project;

  getProviderProfile(providerProfileId: Id): ProviderProfile | null;
  saveProviderProfile(
    input: ProviderProfileInput & { id?: Id },
    apiKeyRef: string | null,
  ): ProviderProfile;
  deleteProviderProfile(providerProfileId: Id): void;

  getAgentProfile(agentProfileId: Id): AgentProfile | null;
  createAgentProfile(
    input: CreateAgentProfileInput,
    options?: { mirrorLegacyControlPlane?: boolean },
  ): AgentProfile;
  getThread(threadId: Id): AgentThread | null;
  createThread(
    input: CreateThreadInput,
    options?: { mirrorLegacyControlPlane?: boolean },
  ): AgentThread;
  updateThreadSettings(input: UpdateThreadSettingsInput): AgentThread;
  listThreadMessages(threadId: Id): ThreadMessage[];
  appendMessage(
    input: Omit<ThreadMessage, "id" | "sequence" | "createdAt">,
  ): ThreadMessage;
  saveRunPartial(runId: Id, content: string): void;
  clearRunPartial(runId: Id): void;

  createRun(
    threadId: Id,
    triggerMessageId: Id,
    contextRevisionId: Id | null,
    configSnapshot: RunConfigSnapshot,
  ): AgentRun;
  getRun(runId: Id): AgentRun | null;
  listActiveRuns(): AgentRun[];
  updateRunStatus(runId: Id, status: RunStatus, error?: string): AgentRun;
  interruptNonTerminalRuns(options?: { includeRemote?: boolean }): number;
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

  getProjectContext(projectId: Id): ContextRevision | null;
  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId?: Id | null,
    sourceRunId?: Id | null,
  ): ContextRevision;
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
  addProject(input: CreateProjectInput): Project;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  deleteProviderProfile(providerProfileId: Id): Promise<void>;
  testProviderConnection(
    input: SaveProviderProfileInput,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionResult>;
  createAgentProfile(input: CreateAgentProfileInput): AgentProfile;
  createThread(input: CreateThreadInput): AgentThread;
  updateThreadSettings(input: UpdateThreadSettingsInput): AgentThread;
  listThreadMessages(threadId: Id): ThreadMessage[];
  startRun(input: StartRunInput): Promise<AgentRun>;
  cancelRun(runId: Id): Promise<void>;
  resolveApproval(
    approvalId: Id,
    decision: ApprovalDecision,
  ): Promise<void>;
  getProjectContext(projectId: Id): ContextRevision | null;
  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId?: Id | null,
    sourceRunId?: Id | null,
  ): ContextRevision;
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
    const interruptedRuns = this.#store.interruptNonTerminalRuns({
      includeRemote: true,
    });
    for (const runId of recoverableRunIds) {
      const run = this.#store.getRun(runId);
      if (!run || run.status !== "interrupted") {
        continue;
      }
      const thread = this.#store.getThread(run.threadId);
      if (!thread) {
        continue;
      }
      this.persistRecoveredToolCallResults(
        run,
        thread,
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

  addProject(input: CreateProjectInput): Project {
    const rootPath = input.rootPath.trim();
    if (!rootPath) {
      throw new Error("Project root path is required.");
    }
    assertMaximumLength(rootPath, 4096, "Project root path");
    if (input.name) {
      assertMaximumLength(input.name.trim(), 200, "Project name");
    }
    return this.#store.addProject({
      ...input,
      rootPath,
    });
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

  createAgentProfile(input: CreateAgentProfileInput): AgentProfile {
    const project = this.requireProject(input.projectId);
    const runtimeKind = input.runtimeKind ?? "native";
    if (!input.name.trim()) {
      throw new Error("Agent name is required.");
    }
    assertMaximumLength(input.name.trim(), 200, "Agent name");
    assertMaximumLength(input.instructions, 50_000, "Agent instructions");
    if (runtimeKind !== "native") {
      throw new Error("Only native Agent Profiles are supported.");
    }
    if (!input.providerProfileId) {
      throw new Error("A native Agent Profile requires a provider.");
    }
    this.requireProviderProfile(input.providerProfileId);

    return this.#store.createAgentProfile({
      ...input,
      projectId: project.id,
      runtimeKind: "native",
      runtimeNodeId: "local-runtime",
      cliConfig: null,
    }, { mirrorLegacyControlPlane: false });
  }

  createThread(input: CreateThreadInput): AgentThread {
    const project = this.requireProject(input.projectId);
    const profile = this.requireAgentProfile(input.agentProfileId);
    if (profile.projectId !== project.id) {
      throw new Error("Agent Profile and Thread must belong to the same Project.");
    }
    if (input.title) {
      assertMaximumLength(input.title.trim(), 300, "Thread title");
    }
    return this.#store.createThread(input, {
      mirrorLegacyControlPlane: false,
    });
  }

  updateThreadSettings(input: UpdateThreadSettingsInput): AgentThread {
    const thread = this.requireThread(input.threadId);
    const modelOverride = input.modelOverride === undefined
      ? undefined
      : input.modelOverride?.trim() || null;
    if (modelOverride) {
      assertMaximumLength(modelOverride, 512, "Model");
    }
    if (input.executionProfile === undefined && modelOverride === undefined) {
      throw new Error("No Conversation settings were provided.");
    }
    return this.#store.updateThreadSettings({
      threadId: thread.id,
      modelOverride,
      executionProfile: input.executionProfile,
    });
  }

  listThreadMessages(threadId: Id): ThreadMessage[] {
    this.requireThread(threadId);
    return this.#store.listThreadMessages(threadId);
  }

  async startRun(input: StartRunInput): Promise<AgentRun> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("Message cannot be empty.");
    }
    assertMaximumLength(prompt, 100_000, "Message");
    const thread = this.requireThread(input.threadId);
    const activeThreadRun = this.#store.listActiveRuns().find(
      (run) => run.threadId === thread.id,
    );
    if (activeThreadRun?.status === "waiting-input") {
      return this.#provideRunInput(activeThreadRun, thread, prompt);
    }
    if (activeThreadRun) {
      throw new Error("This Thread already has an active Run.");
    }
    const profile = this.requireAgentProfile(thread.agentProfileId);
    const project = this.requireProject(thread.projectId);
    const workspace = this.requireWorkspace(thread.projectId);
    const context = this.#store.getProjectContext(project.id);
    const provider = profile.providerProfileId
      ? this.requireProviderProfile(profile.providerProfileId)
      : null;
    if (profile.runtimeKind !== "native") {
      throw new Error("This legacy Agent Profile is no longer supported.");
    }
    if (!provider) {
      throw new Error("Native Agent Profile has no provider.");
    }

    const toolPolicy = workspace.localRootPath
      ? effectiveToolPolicy(thread.executionProfile, profile.toolPolicy)
      : {
          readFiles: "deny" as const,
          writeFiles: "deny" as const,
          runCommands: "deny" as const,
        };

    const trigger = this.#store.appendMessage({
      threadId: thread.id,
      runId: null,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: prompt }],
      metadata: {},
    });
    const snapshot: RunConfigSnapshot = {
      agentProfileId: profile.id,
      runtimeKind: "native",
      providerProfileId: provider.id,
      providerProtocol: provider.protocol,
      providerBaseUrl: provider.baseUrl,
      model: thread.modelOverride ?? provider.defaultModel,
      instructions: profile.instructions,
      executionProfile: thread.executionProfile,
      toolPolicy,
      cliConfig: null,
    };
    const run = this.#store.createRun(
      thread.id,
      trigger.id,
      context?.id ?? null,
      snapshot,
    );
    this.emitStatus(run);
    this.emitMessage(run, thread, trigger);

    const controller = new AbortController();
    const execution = this.#executeNativeRun({
      run,
      thread,
      project,
      workspace,
      profile,
      provider,
      context,
      controller,
    });
    const settled = execution.finally(() => {
      this.#approvals.cancelRun(run.id);
      this.#inputs.cancelRun(run.id);
      this.#store.expirePendingApprovalsForRun(run.id);
      this.finalizeCancelledToolCalls(run, thread);
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
    thread: AgentThread,
    answer: string,
  ): AgentRun {
    if (!this.#inputs.has(run.id)) {
      throw new Error(
        "This input request can no longer resume. Retry the interrupted conversation.",
      );
    }
    const message = this.#store.appendMessage({
      threadId: thread.id,
      runId: run.id,
      role: "user",
      status: "committed",
      content: [{ type: "text", text: answer }],
      metadata: { inputResponse: true },
    });
    this.emitMessage(run, thread, message);
    this.#inputs.resolve(run.id, answer);
    return this.requireRun(run.id);
  }

  getProjectContext(projectId: Id): ContextRevision | null {
    this.requireProject(projectId);
    return this.#store.getProjectContext(projectId);
  }

  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId?: Id | null,
    sourceRunId?: Id | null,
  ): ContextRevision {
    this.requireProject(projectId);
    assertMaximumLength(content, 200_000, "Project Context");
    let sourceThread: AgentThread | null = null;
    if (sourceThreadId) {
      sourceThread = this.requireThread(sourceThreadId);
      if (sourceThread.projectId !== projectId) {
        throw new Error("Context source Thread belongs to a different Project.");
      }
    }
    if (sourceRunId) {
      const run = this.requireRun(sourceRunId);
      const runThread = this.requireThread(run.threadId);
      if (runThread.projectId !== projectId) {
        throw new Error("Context source Run belongs to a different Project.");
      }
      if (sourceThread && sourceThread.id !== runThread.id) {
        throw new Error("Context source Run belongs to a different Thread.");
      }
    }
    return this.#store.updateProjectContext(
      projectId,
      content.trim(),
      sourceThreadId ?? null,
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
    thread: AgentThread;
    project: Project;
    workspace: Workspace;
    profile: AgentProfile;
    provider: ProviderProfile;
    context: ContextRevision | null;
    controller: AbortController;
  }): Promise<void> {
    const {
      run,
      thread,
      project,
      workspace,
      profile,
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
        this.#store.listThreadMessages(thread.id),
        profile,
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
          projectId: project.id,
          projectRoot: workspace.localRootPath ?? "",
          threadId: thread.id,
          runId: run.id,
          credentials,
          messages: history,
          executionProfile: run.configSnapshot.executionProfile,
          toolPolicy: run.configSnapshot.toolPolicy,
          onManagedExecutionEvent: (progress) => {
            this.emitManagedExecution(run, thread, progress);
          },
          signal: controller.signal,
        },
        this.createObserver(run, thread, controller.signal, partial),
      );
      throwIfAborted(controller.signal);
      this.emitStatus(this.#store.updateRunStatus(run.id, "completed"));
    } catch (error) {
      this.persistInterruptedText(run, thread, partial.text);
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
    thread: AgentThread,
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
          threadId: thread.id,
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
          this.emitToolCall(run, thread, stored);
        }
        const message = this.#store.appendMessage({
          threadId: thread.id,
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
        this.emitMessage(run, thread, message);
        return callIds;
      },
      onToolCallStatus: (toolCallId, status, result) => {
        const toolCall = this.#store.updateToolCallStatus(
          toolCallId,
          status,
          result,
        );
        this.emitToolCall(run, thread, toolCall);
      },
      requestApproval: async ({ toolCallId, description }) => {
        throwIfAborted(signal);
        const approval = this.#store.createApproval(
          run.id,
          toolCallId,
          description,
        );
        this.emitStatus(this.#store.updateRunStatus(run.id, "waiting-approval"));
        this.emitApproval(run, thread, approval, this.requireToolCall(toolCallId));
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
          threadId: thread.id,
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
        this.emitMessage(run, thread, message);
      },
    };
  }

  requireProject(projectId: Id): Project {
    const project = this.#store.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
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

  requireAgentProfile(agentProfileId: Id): AgentProfile {
    const profile = this.#store.getAgentProfile(agentProfileId);
    if (!profile) {
      throw new Error(`Agent Profile not found: ${agentProfileId}`);
    }
    return profile;
  }

  requireThread(threadId: Id): AgentThread {
    const thread = this.#store.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
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

  finalizeCancelledToolCalls(run: AgentRun, thread: AgentThread): void {
    const toolCalls = this.#store.cancelUnfinishedToolCallsForRun(run.id);
    const resultIds = new Set(
      this.#store.listThreadMessages(thread.id)
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
        threadId: thread.id,
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
      this.emitMessage(run, thread, message);
    }
  }

  persistRecoveredToolCallResults(
    run: AgentRun,
    thread: AgentThread,
    toolCalls: ToolCallRecord[],
  ): void {
    const resultIds = new Set(
      this.#store.listThreadMessages(thread.id)
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
      this.emitToolCall(run, thread, toolCall);
      const message = this.#store.appendMessage({
        threadId: thread.id,
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
      this.emitMessage(run, thread, message);
    }
  }

  persistInterruptedText(
    run: AgentRun,
    thread: AgentThread,
    text: string,
  ): void {
    if (!text.trim()) {
      this.#store.clearRunPartial(run.id);
      return;
    }
    const message = this.#store.appendMessage({
      threadId: thread.id,
      runId: run.id,
      role: "assistant",
      status: "interrupted",
      content: [{ type: "text", text }],
      metadata: { partial: true },
    });
    this.#store.clearRunPartial(run.id);
    this.emitMessage(run, thread, message);
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
      threadId: run.threadId,
      status: run.status,
      at: new Date().toISOString(),
      error: run.error ?? undefined,
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitMessage(run: AgentRun, thread: AgentThread, message: ThreadMessage): void {
    const event: RunEvent = {
      type: "message-created",
      runId: run.id,
      threadId: thread.id,
      message,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitToolCall(run: AgentRun, thread: AgentThread, toolCall: ToolCallRecord): void {
    const event: RunEvent = {
      type: "tool-call",
      runId: run.id,
      threadId: thread.id,
      toolCall,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitApproval(
    run: AgentRun,
    thread: AgentThread,
    approval: ToolApproval,
    toolCall: ToolCallRecord,
  ): void {
    const event: RunEvent = {
      type: "approval-required",
      runId: run.id,
      threadId: thread.id,
      approval,
      toolCall,
      at: new Date().toISOString(),
    };
    this.#store.appendRunEvent(event);
    this.#publish(event);
  }

  emitManagedExecution(
    run: AgentRun,
    thread: AgentThread,
    progress: ManagedExecutionProgress,
  ): void {
    const event: RunEvent = {
      type: "managed-execution",
      runId: run.id,
      threadId: thread.id,
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
  messages: ThreadMessage[],
  profile: AgentProfile,
  workspace: Workspace,
  context: ContextRevision | null,
): ModelMessage[] {
  const systemSections = [
    profile.instructions.trim(),
    workspace.localRootPath
      ? `Local workspace folder: ${workspace.localRootPath}`
      : "",
    context
      ? `# Shared Workspace Context (revision ${context.version})\n${context.content}`
      : "",
    "Treat every other Thread as isolated. Use only the shared context shown above.",
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
  messages: ThreadMessage[],
  characterBudget: number,
  countLimit: number,
): ThreadMessage[] {
  const selected: ThreadMessage[] = [];
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
  profile: AgentProfile["executionProfile"],
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
