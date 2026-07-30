import { randomUUID } from "node:crypto";

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
  type ApprovalDecision,
  type CliAgentConfig,
  type ContextRevision,
  type CreateAgentProfileInput,
  type CreateProjectInput,
  type CreateThreadInput,
  type Id,
  type MessageContentBlock,
  type Project,
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderProtocol,
  type RunConfigSnapshot,
  type RunEvent,
  type RunStatus,
  type StartRunInput,
  type ThreadMessage,
  type ToolApproval,
  type ToolCallRecord,
  type ToolCallStatus,
  type WorkspaceSnapshot,
} from "@scopeguard/domain";

export interface WorkspaceStore {
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  listProjects(): Project[];
  getProject(projectId: Id): Project | null;
  addProject(input: CreateProjectInput): Project;

  listProviderProfiles(): ProviderProfile[];
  getProviderProfile(providerProfileId: Id): ProviderProfile | null;
  saveProviderProfile(
    input: ProviderProfileInput & { id?: Id },
    apiKeyRef: string | null,
  ): ProviderProfile;
  deleteProviderProfile(providerProfileId: Id): void;

  listAgentProfiles(projectId?: Id): AgentProfile[];
  getAgentProfile(agentProfileId: Id): AgentProfile | null;
  createAgentProfile(input: CreateAgentProfileInput): AgentProfile;

  listThreads(projectId?: Id): AgentThread[];
  getThread(threadId: Id): AgentThread | null;
  createThread(input: CreateThreadInput): AgentThread;
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
  interruptNonTerminalRuns(): number;
  appendRunEvent(event: RunEvent): void;

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
  getApproval(approvalId: Id): ToolApproval | null;
  listPendingApprovals(): ToolApproval[];
  resolveApproval(approvalId: Id, decision: ApprovalDecision): ToolApproval;
  expirePendingApprovalsForRun(runId: Id): number;
  expirePendingApprovalsForTerminalRuns(): number;
  cancelUnfinishedToolCallsForRun(runId: Id): ToolCallRecord[];
  cancelUnfinishedToolCallsForTerminalRuns(): number;

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

export type CliAgentOutput = {
  stream: "stdout" | "stderr";
  chunk: string;
};

export interface CliAgentRunner {
  run(input: {
    config: CliAgentConfig;
    prompt: string;
    projectRoot: string;
    signal: AbortSignal;
    onOutput: (output: CliAgentOutput) => void;
  }): Promise<{ stdout: string; stderr: string }>;
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

export class ScopeGuardApplication {
  readonly #store: WorkspaceStore;
  readonly #secrets: SecretVault;
  readonly #providerFactory: ProviderAdapterFactory;
  readonly #tools: ToolRegistry;
  readonly #cliRunner: CliAgentRunner | null;
  readonly #publish: RunEventPublisher;
  readonly #activeRuns = new Map<Id, ActiveRun>();
  readonly #approvals = new ApprovalWaiters();

  constructor(options: {
    store: WorkspaceStore;
    secrets: SecretVault;
    providerFactory: ProviderAdapterFactory;
    tools: ToolRegistry;
    cliRunner?: CliAgentRunner;
    publish?: RunEventPublisher;
  }) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#providerFactory = options.providerFactory;
    this.#tools = options.tools;
    this.#cliRunner = options.cliRunner ?? null;
    this.#publish = options.publish ?? (() => {});
  }

  initialize(): { interruptedRuns: number } {
    const interruptedRuns = this.#store.interruptNonTerminalRuns();
    this.#store.expirePendingApprovalsForTerminalRuns();
    this.#store.cancelUnfinishedToolCallsForTerminalRuns();
    return {
      interruptedRuns,
    };
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    return this.#store.getWorkspaceSnapshot();
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
    if (runtimeKind === "native") {
      if (!input.providerProfileId) {
        throw new Error("A native Agent Profile requires a provider.");
      }
      this.requireProviderProfile(input.providerProfileId);
    } else if (!input.cliConfig?.command.trim()) {
      throw new Error("A local CLI Agent Profile requires a command.");
    } else if (
      input.cliConfig.cwd !== null ||
      Object.keys(input.cliConfig.env).length > 0
    ) {
      throw new Error(
        "Custom CLI working directories and environment variables are disabled in this build.",
      );
    } else {
      assertMaximumLength(input.cliConfig.command, 4096, "CLI command");
      if (input.cliConfig.args.length > 128) {
        throw new Error("CLI configuration must not contain more than 128 arguments.");
      }
      for (const argument of input.cliConfig.args) {
        assertMaximumLength(argument, 32_768, "CLI argument");
      }
    }

    return this.#store.createAgentProfile({
      ...input,
      projectId: project.id,
      runtimeKind,
    });
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
    return this.#store.createThread(input);
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
    if (this.#store.listActiveRuns().some((run) => run.threadId === thread.id)) {
      throw new Error("This Thread already has an active Run.");
    }
    const profile = this.requireAgentProfile(thread.agentProfileId);
    const project = this.requireProject(thread.projectId);
    const context = this.#store.getProjectContext(project.id);
    const provider = profile.runtimeKind === "native"
      ? profile.providerProfileId
        ? this.requireProviderProfile(profile.providerProfileId)
        : null
      : null;
    if (profile.runtimeKind === "native" && !provider) {
      throw new Error("Native Agent Profile has no provider.");
    }
    if (
      profile.runtimeKind === "local-cli" &&
      (!this.#cliRunner || !profile.cliConfig)
    ) {
      throw new Error("Local CLI Runs are not available in this build.");
    }

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
      runtimeKind: profile.runtimeKind,
      providerProfileId: provider?.id ?? null,
      providerProtocol: provider?.protocol ?? null,
      providerBaseUrl: provider?.baseUrl ?? null,
      model: provider
        ? profile.modelOverride ?? provider.defaultModel
        : null,
      instructions: profile.instructions,
      toolPolicy: profile.toolPolicy,
      cliConfig: profile.cliConfig,
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
    const execution = profile.runtimeKind === "native"
      ? this.#executeNativeRun({
          run,
          thread,
          project,
          profile,
          provider: provider!,
          context,
          controller,
        })
      : this.#executeCliRun({
          run,
          thread,
          project,
          profile,
          context,
          controller,
        });
    const settled = execution.finally(() => {
      this.#approvals.cancelRun(run.id);
      this.#store.expirePendingApprovalsForRun(run.id);
      this.finalizeCancelledToolCalls(run, thread);
      this.#activeRuns.delete(run.id);
    });
    this.#activeRuns.set(run.id, { controller, settled });
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
    await active.settled;
  }

  async resolveApproval(
    approvalId: Id,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = this.#store.resolveApproval(approvalId, decision);
    this.#approvals.resolve(approval.id, decision);
  }

  getProjectContext(projectId: Id): ContextRevision | null {
    this.requireProject(projectId);
    return this.#store.getProjectContext(projectId);
  }

  updateProjectContext(
    projectId: Id,
    content: string,
    sourceThreadId?: Id,
    sourceRunId?: Id,
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
    }
    await Promise.allSettled(activeRuns.map(([, active]) => active.settled));
  }

  async #executeNativeRun(input: {
    run: AgentRun;
    thread: AgentThread;
    project: Project;
    profile: AgentProfile;
    provider: ProviderProfile;
    context: ContextRevision | null;
    controller: AbortController;
  }): Promise<void> {
    const { run, thread, project, profile, provider, context, controller } = input;
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
        protocol: provider.protocol,
        baseUrl: normalizeProviderBaseUrl(provider.baseUrl),
        apiKey,
        model: profile.modelOverride ?? provider.defaultModel,
        customHeaders: {},
      };
      const history = toModelMessages(
        this.#store.listThreadMessages(thread.id),
        profile,
        project,
        context,
      );
      this.emitStatus(this.#store.updateRunStatus(run.id, "running"));

      const runtime = new NativeAgentRuntime(
        this.#providerFactory(provider.protocol),
        this.#tools,
      );
      await runtime.run(
        {
          projectId: project.id,
          projectRoot: project.rootPath,
          threadId: thread.id,
          runId: run.id,
          credentials,
          messages: history,
          toolPolicy: profile.toolPolicy,
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

  async #executeCliRun(input: {
    run: AgentRun;
    thread: AgentThread;
    project: Project;
    profile: AgentProfile;
    context: ContextRevision | null;
    controller: AbortController;
  }): Promise<void> {
    const { run, thread, project, profile, context, controller } = input;
    const cliRunner = this.#cliRunner;
    const cliConfig = profile.cliConfig;
    if (!cliRunner || !cliConfig) {
      throw new Error("Local CLI Runs are not available in this build.");
    }

    const partial: PartialOutputState = {
      text: "",
      checkpointedLength: 0,
      checkpointedAt: 0,
    };
    try {
      this.emitStatus(this.#store.updateRunStatus(run.id, "preparing"));
      const prompt = buildCliPrompt(
        this.#store.listThreadMessages(thread.id),
        profile,
        project,
        context,
      );
      this.emitStatus(this.#store.updateRunStatus(run.id, "running"));
      const result = await cliRunner.run({
        config: {
          ...cliConfig,
          cwd: null,
          env: {},
        },
        prompt,
        projectRoot: project.rootPath,
        signal: controller.signal,
        onOutput: (output) => {
          if (output.stream !== "stdout") {
            return;
          }
          partial.text += output.chunk;
          this.checkpointPartial(run.id, partial);
          this.#publish({
            type: "assistant-delta",
            runId: run.id,
            threadId: thread.id,
            delta: output.chunk,
            at: new Date().toISOString(),
          });
        },
      });
      throwIfAborted(controller.signal);
      const text = result.stdout.trim()
        || "CLI Agent completed without text output.";
      const message = this.#store.appendMessage({
        threadId: thread.id,
        runId: run.id,
        role: "assistant",
        status: "committed",
        content: [{ type: "text", text }],
        metadata: { runtime: "local-cli" },
      });
      this.#store.clearRunPartial(run.id);
      resetPartialOutput(partial);
      this.emitMessage(run, thread, message);
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
      if (controller.signal.aborted || isCliAbort(error)) {
        if (canTransitionRun(current.status, "cancelling")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelling"));
        }
        const cancelling = this.#store.getRun(run.id);
        if (cancelling && canTransitionRun(cancelling.status, "cancelled")) {
          this.emitStatus(this.#store.updateRunStatus(run.id, "cancelled"));
        }
        return;
      }
      const message = cliRunErrorMessage(error);
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
      onUsage: () => {},
      onAssistantTurn: async (turn) => {
        const callIds: Record<string, Id> = {};
        const blocks: MessageContentBlock[] = [];
        if (turn.content) {
          blocks.push({ type: "text", text: turn.content });
        }
        for (const call of turn.toolCalls) {
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
          metadata: { finishReason: turn.finishReason },
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

function toModelMessages(
  messages: ThreadMessage[],
  profile: AgentProfile,
  project: Project,
  context: ContextRevision | null,
): ModelMessage[] {
  const systemSections = [
    profile.instructions.trim(),
    `Project root: ${project.rootPath}`,
    context
      ? `# Shared Project Context (revision ${context.version})\n${context.content}`
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

function buildCliPrompt(
  messages: ThreadMessage[],
  profile: AgentProfile,
  project: Project,
  context: ContextRevision | null,
): string {
  const transcript = messages.slice(-20).flatMap((message) => {
    const content = message.content.flatMap((block) => {
      if (block.type === "text") {
        return [block.text];
      }
      if (block.type === "tool-result") {
        return [`${block.name}: ${block.output}`];
      }
      return [];
    }).join("\n");
    if (!content.trim()) {
      return [];
    }
    const label = message.role === "assistant"
      ? "Agent"
      : message.role === "user"
        ? "User"
        : "Tool";
    return [`${label}: ${content}`];
  }).join("\n\n");
  const header = [
    profile.instructions.trim().slice(0, 30_000),
    `Project root: ${project.rootPath}`,
    context
      ? `# Shared Project Context (revision ${context.version})\n${
          context.content.slice(0, 40_000)
        }`
      : "",
  ].filter(Boolean);
  const headerText = header.join("\n\n");
  const transcriptBudget = Math.max(0, 100_000 - headerText.length - 18);
  const boundedTranscript = transcript.length > transcriptBudget
    ? transcript.slice(transcript.length - transcriptBudget)
    : transcript;
  return `${headerText}\n\n# Conversation\n${boundedTranscript}`;
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

function isCliAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CLI_AGENT_ABORTED"
  );
}

function isHostShutdown(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    reason instanceof Error &&
    reason.name === HOST_SHUTDOWN_ABORT_NAME
  );
}

function cliRunErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "CLI_AGENT_PROCESS_FAILED"
  ) {
    const exitCode = "exitCode" in error && typeof error.exitCode === "number"
      ? error.exitCode
      : null;
    return exitCode === null
      ? "Local CLI Agent process failed."
      : `Local CLI Agent exited with code ${exitCode}.`;
  }
  return error instanceof Error ? error.message : String(error);
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

function assertMaximumLength(
  value: string,
  maximum: number,
  field: string,
): void {
  if (value.length > maximum) {
    throw new Error(`${field} must not exceed ${maximum} characters.`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Run cancelled.", "AbortError");
  }
}
