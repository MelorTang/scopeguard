import type {
  AgentProfile,
  AgentRun,
  AgentThread,
  ContextRevision,
  Project,
  ProviderProfile,
  RunEvent,
  ThreadMessage,
  ToolApproval,
  ToolCallRecord,
  WorkspaceSnapshot,
} from "@scopeguard/domain";
import type {
  ScopeGuardDesktopApi,
  SaveProviderProfileRequest,
} from "@scopeguard/ipc-contracts";

export const desktopApi: ScopeGuardDesktopApi =
  window.scopeguardDesktop ?? createMockDesktopApi();

export const isDesktopRuntime = Boolean(window.scopeguardDesktop);

function createMockDesktopApi(): ScopeGuardDesktopApi {
  const now = new Date().toISOString();
  const provider: ProviderProfile = {
    id: "provider-demo",
    name: "Company relay",
    protocol: "openai-compatible",
    baseUrl: "https://relay.example.com/v1",
    defaultModel: "general-model",
    apiKeyRef: "provider:demo",
    customHeaders: {},
    createdAt: now,
    updatedAt: now,
  };
  const project: Project = {
    id: "project-demo",
    name: "Operations workspace",
    rootPath: "/Users/demo/Operations",
    currentContextRevisionId: "context-demo",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  const agents: AgentProfile[] = [
    makeAgent("agent-research", "Research", "Collect evidence and summarize it."),
    makeAgent("agent-docs", "Documents", "Draft clear internal documents."),
    makeAgent("agent-dev", "Developer", "Implement scoped changes and verify them."),
  ];
  const threads: AgentThread[] = [
    makeThread("thread-research", agents[0]!.id, "Vendor comparison"),
    makeThread("thread-docs", agents[1]!.id, "Quarterly brief"),
    makeThread("thread-dev", agents[2]!.id, "Desktop integration"),
  ];
  const messages = new Map<string, ThreadMessage[]>([
    [
      "thread-research",
      [
        makeMessage(
          "message-r1",
          "thread-research",
          1,
          "user",
          "Compare the three shortlisted vendors and focus on implementation risk.",
        ),
        makeMessage(
          "message-r2",
          "thread-research",
          2,
          "assistant",
          "I compared deployment effort, data handling, and operating cost. The second vendor has the lowest migration risk, while the first has the strongest audit controls.",
        ),
      ],
    ],
    [
      "thread-docs",
      [
        makeMessage(
          "message-d1",
          "thread-docs",
          1,
          "user",
          "Turn the current project decisions into a concise internal brief.",
        ),
        makeMessage(
          "message-d2",
          "thread-docs",
          2,
          "assistant",
          "The brief is organized around the decision, constraints, implementation sequence, and open risks.",
        ),
      ],
    ],
    [
      "thread-dev",
      [
        makeMessage(
          "message-v1",
          "thread-dev",
          1,
          "assistant",
          "The desktop runtime is ready for the next integration step.",
        ),
      ],
    ],
  ]);
  let snapshot: WorkspaceSnapshot = {
    projects: [project],
    providerProfiles: [provider],
    agentProfiles: agents,
    threads,
    activeRuns: [],
    recentRuns: [],
    pendingApprovals: [],
  };
  const contexts = new Map<string, ContextRevision | null>([
    [
      project.id,
      {
        id: "context-demo",
        projectId: project.id,
        version: 3,
        parentId: "context-demo-2",
        content:
          "Use the company relay for general models. Keep every Agent Thread isolated. Publish only reviewed decisions to shared context.",
        sourceThreadId: "thread-docs",
        sourceRunId: null,
        createdAt: now,
      },
    ],
  ]);
  const listeners = new Set<(event: RunEvent) => void>();
  const runControls = new Map<string, MockRunControl>();

  return {
    async getWorkspaceSnapshot() {
      return clone(snapshot);
    },
    async chooseProjectDirectory() {
      return {
        canceled: false,
        rootPath: `/Users/demo/Project-${snapshot.projects.length + 1}`,
      };
    },
    async addProject(input) {
      const timestamp = new Date().toISOString();
      const added: Project = {
        id: crypto.randomUUID(),
        name: input.name || input.rootPath.split(/[\\/]/).at(-1) || "Project",
        rootPath: input.rootPath,
        currentContextRevisionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        projects: [added, ...snapshot.projects],
      };
      contexts.set(added.id, null);
      return clone(added);
    },
    async saveProviderProfile(input) {
      const saved = saveMockProvider(input, snapshot.providerProfiles);
      snapshot = {
        ...snapshot,
        providerProfiles: [
          saved,
          ...snapshot.providerProfiles.filter((item) => item.id !== saved.id),
        ],
      };
      return clone(saved);
    },
    async deleteProviderProfile(providerProfileId) {
      snapshot = {
        ...snapshot,
        providerProfiles: snapshot.providerProfiles.filter(
          (item) => item.id !== providerProfileId,
        ),
      };
    },
    async testProviderConnection(input) {
      await delay(450);
      if (!input.baseUrl.startsWith("http")) {
        throw new Error("Provider Base URL must use HTTP or HTTPS.");
      }
      return {
        ok: true,
        latencyMs: 184,
        model: input.defaultModel,
        message: "Connection succeeded.",
      };
    },
    async createAgentProfile(input) {
      const timestamp = new Date().toISOString();
      const created: AgentProfile = {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        name: input.name,
        runtimeKind: input.runtimeKind ?? "native",
        instructions: input.instructions,
        providerProfileId: input.providerProfileId ?? null,
        modelOverride: input.modelOverride ?? null,
        toolPolicy: {
          readFiles: input.toolPolicy?.readFiles ?? "allow",
          writeFiles: input.toolPolicy?.writeFiles ?? "ask",
          runCommands: input.toolPolicy?.runCommands ?? "ask",
        },
        cliConfig: input.cliConfig ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        agentProfiles: [...snapshot.agentProfiles, created],
      };
      return clone(created);
    },
    async createThread(input) {
      const created = makeThread(
        crypto.randomUUID(),
        input.agentProfileId,
        input.title || "New conversation",
        input.projectId,
      );
      snapshot = {
        ...snapshot,
        threads: [created, ...snapshot.threads],
      };
      messages.set(created.id, []);
      return clone(created);
    },
    async listThreadMessages(threadId) {
      return clone(messages.get(threadId) ?? []);
    },
    async startRun(input) {
      const timestamp = new Date().toISOString();
      const thread = snapshot.threads.find((item) => item.id === input.threadId);
      if (!thread) {
        throw new Error("Thread not found.");
      }
      const userMessage = makeMessage(
        crypto.randomUUID(),
        input.threadId,
        (messages.get(input.threadId)?.length ?? 0) + 1,
        "user",
        input.prompt,
      );
      messages.set(input.threadId, [
        ...(messages.get(input.threadId) ?? []),
        userMessage,
      ]);
      const run: AgentRun = {
        id: crypto.randomUUID(),
        threadId: input.threadId,
        triggerMessageId: userMessage.id,
        contextRevisionId: contexts.get(thread.projectId)?.id ?? null,
        configSnapshot: makeRunConfigSnapshot(thread),
        status: "queued",
        startedAt: null,
        completedAt: null,
        error: null,
        createdAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        activeRuns: [...snapshot.activeRuns, run],
      };
      emit({
        type: "message-created",
        runId: run.id,
        threadId: run.threadId,
        message: userMessage,
        at: timestamp,
      });
      runControls.set(run.id, createRunControl());
      void simulateRun(run, input.prompt);
      return clone(run);
    },
    async cancelRun(runId) {
      const run = snapshot.activeRuns.find((item) => item.id === runId);
      if (!run) {
        return;
      }
      cancelRunControl(runId);
      snapshot = {
        ...snapshot,
        activeRuns: snapshot.activeRuns.filter((item) => item.id !== runId),
        recentRuns: [
          {
            ...run,
            status: "cancelled",
            completedAt: new Date().toISOString(),
          },
          ...snapshot.recentRuns.filter((item) => item.id !== runId),
        ],
        pendingApprovals: snapshot.pendingApprovals.filter(
          (item) => item.approval.runId !== runId,
        ),
      };
      emit({
        type: "run-status",
        runId,
        threadId: run.threadId,
        status: "cancelled",
        at: new Date().toISOString(),
      });
      runControls.delete(runId);
    },
    async resolveApproval(approvalId, decision) {
      const pending = snapshot.pendingApprovals.find(
        (item) => item.approval.id === approvalId,
      );
      if (!pending) {
        throw new Error("Pending approval not found.");
      }
      snapshot = {
        ...snapshot,
        pendingApprovals: snapshot.pendingApprovals.filter(
          (item) => item.approval.id !== approvalId,
        ),
      };
      const run = getActiveRun(pending.approval.runId);
      if (!run || !isRunActive(run.id)) {
        return;
      }
      const timestamp = new Date().toISOString();
      const denied = decision === "denied";
      const toolCall: ToolCallRecord = {
        ...pending.toolCall,
        status: denied ? "denied" : "succeeded",
        output: denied ? null : "scopeguard-command-approved\n",
        error: denied ? "Command execution denied by user." : null,
        completedAt: timestamp,
      };
      emit({
        type: "tool-call",
        runId: run.id,
        threadId: run.threadId,
        toolCall,
        at: timestamp,
      });
      const toolResult = makeToolResultMessage(
        run,
        toolCall,
        denied
          ? "Command execution denied by user."
          : "scopeguard-command-approved\n",
        denied,
      );
      appendMessage(toolResult);
      emit({
        type: "message-created",
        runId: run.id,
        threadId: run.threadId,
        message: toolResult,
        at: timestamp,
      });
      updateActiveRunStatus(run.id, "running");
      emitRunStatus(run.id, "running");
      void finishRunWithAssistant(
        run.id,
        denied
          ? "The command was denied, so I did not execute it. The Run continued without changing the project."
          : "The approved command completed successfully with output: scopeguard-command-approved",
      );
    },
    async getProjectContext(projectId) {
      return clone(contexts.get(projectId) ?? null);
    },
    async updateProjectContext(request) {
      const timestamp = new Date().toISOString();
      const currentContext = contexts.get(request.projectId) ?? null;
      const updatedContext: ContextRevision = {
        id: crypto.randomUUID(),
        projectId: request.projectId,
        version: (currentContext?.version ?? 0) + 1,
        parentId: currentContext?.id ?? null,
        content: request.content,
        sourceThreadId: request.sourceThreadId ?? null,
        sourceRunId: request.sourceRunId ?? null,
        createdAt: timestamp,
      };
      contexts.set(request.projectId, updatedContext);
      snapshot = {
        ...snapshot,
        projects: snapshot.projects.map((item) =>
          item.id === request.projectId
            ? { ...item, currentContextRevisionId: updatedContext.id }
            : item,
        ),
      };
      return clone(updatedContext);
    },
    subscribeRunEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function emit(event: RunEvent): void {
    for (const listener of listeners) {
      listener(clone(event));
    }
  }

  async function simulateRun(run: AgentRun, prompt: string): Promise<void> {
    if (!(await delayRun(run.id, 120))) {
      return;
    }
    updateActiveRunStatus(run.id, "running");
    emitRunStatus(run.id, "running");
    if (prompt.includes("/approve-command")) {
      await simulateApprovalRequest(run);
      return;
    }
    const response =
      `I reviewed "${prompt}". The work is isolated to this Thread and uses the current project context revision.`;
    await finishRunWithAssistant(run.id, response);
  }

  async function simulateApprovalRequest(run: AgentRun): Promise<void> {
    if (!(await delayRun(run.id, 180))) {
      return;
    }
    const timestamp = new Date().toISOString();
    const providerCallId = `mock-call-${crypto.randomUUID()}`;
    const toolCall: ToolCallRecord = {
      id: crypto.randomUUID(),
      runId: run.id,
      sequence: 1,
      providerCallId,
      name: "run_command",
      description: "Run a deterministic Web preview command",
      arguments: {
        command: "printf 'scopeguard-command-approved'",
      },
      status: "awaiting-approval",
      output: null,
      error: null,
      createdAt: timestamp,
      completedAt: null,
    };
    const assistant = makeToolCallMessage(run, toolCall);
    appendMessage(assistant);
    emit({
      type: "message-created",
      runId: run.id,
      threadId: run.threadId,
      message: assistant,
      at: timestamp,
    });
    emit({
      type: "tool-call",
      runId: run.id,
      threadId: run.threadId,
      toolCall,
      at: timestamp,
    });
    updateActiveRunStatus(run.id, "waiting-approval");
    emitRunStatus(run.id, "waiting-approval");
    const approval: ToolApproval = {
      id: crypto.randomUUID(),
      toolCallId: toolCall.id,
      runId: run.id,
      status: "pending",
      reason: "This command requires explicit approval in the Web preview.",
      createdAt: timestamp,
      resolvedAt: null,
    };
    snapshot = {
      ...snapshot,
      pendingApprovals: [
        ...snapshot.pendingApprovals,
        { approval, toolCall },
      ],
    };
    emit({
      type: "approval-required",
      runId: run.id,
      threadId: run.threadId,
      approval,
      toolCall,
      at: timestamp,
    });
  }

  async function finishRunWithAssistant(
    runId: string,
    response: string,
  ): Promise<void> {
    const run = getActiveRun(runId);
    if (!run || !isRunActive(runId)) {
      return;
    }
    for (const part of response.match(/.{1,12}/g) ?? []) {
      if (!(await delayRun(run.id, 45))) {
        return;
      }
      emit({
        type: "assistant-delta",
        runId: run.id,
        threadId: run.threadId,
        delta: part,
        at: new Date().toISOString(),
      });
    }
    const assistant = makeMessage(
      crypto.randomUUID(),
      run.threadId,
      (messages.get(run.threadId)?.length ?? 0) + 1,
      "assistant",
      response,
      run.id,
    );
    appendMessage(assistant);
    const activeRun = getActiveRun(run.id);
    if (!activeRun || !isRunActive(run.id)) {
      return;
    }
    snapshot = {
      ...snapshot,
      activeRuns: snapshot.activeRuns.filter((item) => item.id !== run.id),
      recentRuns: [
        {
          ...activeRun,
          status: "completed",
          completedAt: new Date().toISOString(),
        },
        ...snapshot.recentRuns.filter((item) => item.id !== run.id),
      ],
    };
    emit({
      type: "message-created",
      runId: run.id,
      threadId: run.threadId,
      message: assistant,
      at: new Date().toISOString(),
    });
    emit({
      type: "run-status",
      runId: run.id,
      threadId: run.threadId,
      status: "completed",
      at: new Date().toISOString(),
    });
    cancelRunControl(run.id);
    runControls.delete(run.id);
  }

  function makeRunConfigSnapshot(thread: AgentThread): AgentRun["configSnapshot"] {
    const agent = snapshot.agentProfiles.find(
      (item) => item.id === thread.agentProfileId,
    );
    if (!agent) {
      throw new Error("Agent Profile not found.");
    }
    const runProvider =
      agent.runtimeKind === "native"
        ? snapshot.providerProfiles.find(
            (item) => item.id === agent.providerProfileId,
          ) ?? null
        : null;
    return {
      agentProfileId: agent.id,
      runtimeKind: agent.runtimeKind,
      providerProfileId:
        agent.runtimeKind === "native" ? agent.providerProfileId : null,
      providerProtocol: runProvider?.protocol ?? null,
      providerBaseUrl: runProvider?.baseUrl ?? null,
      model:
        agent.runtimeKind === "native"
          ? agent.modelOverride ?? runProvider?.defaultModel ?? null
          : null,
      instructions: agent.instructions,
      toolPolicy: clone(agent.toolPolicy),
      cliConfig: agent.runtimeKind === "local-cli" ? clone(agent.cliConfig) : null,
    };
  }

  function makeToolCallMessage(
    run: AgentRun,
    toolCall: ToolCallRecord,
  ): ThreadMessage {
    return {
      id: crypto.randomUUID(),
      threadId: run.threadId,
      runId: run.id,
      sequence: nextMessageSequence(run.threadId),
      role: "assistant",
      status: "committed",
      content: [
        {
          type: "tool-call",
          toolCallId: toolCall.id,
          providerCallId: toolCall.providerCallId,
          name: toolCall.name,
          arguments: clone(toolCall.arguments),
        },
      ],
      metadata: {},
      createdAt: new Date().toISOString(),
    };
  }

  function makeToolResultMessage(
    run: AgentRun,
    toolCall: ToolCallRecord,
    output: string,
    isError: boolean,
  ): ThreadMessage {
    return {
      id: crypto.randomUUID(),
      threadId: run.threadId,
      runId: run.id,
      sequence: nextMessageSequence(run.threadId),
      role: "tool",
      status: "committed",
      content: [
        {
          type: "tool-result",
          toolCallId: toolCall.id,
          providerCallId: toolCall.providerCallId,
          name: toolCall.name,
          output,
          isError,
        },
      ],
      metadata: {},
      createdAt: new Date().toISOString(),
    };
  }

  function appendMessage(message: ThreadMessage): void {
    messages.set(message.threadId, [
      ...(messages.get(message.threadId) ?? []),
      message,
    ]);
  }

  function nextMessageSequence(threadId: string): number {
    return (messages.get(threadId)?.length ?? 0) + 1;
  }

  function getActiveRun(runId: string): AgentRun | undefined {
    return snapshot.activeRuns.find((item) => item.id === runId);
  }

  function isRunActive(runId: string): boolean {
    return (
      runControls.get(runId)?.cancelled === false &&
      snapshot.activeRuns.some((item) => item.id === runId)
    );
  }

  function updateActiveRunStatus(
    runId: string,
    status: AgentRun["status"],
  ): void {
    const timestamp = new Date().toISOString();
    snapshot = {
      ...snapshot,
      activeRuns: snapshot.activeRuns.map((item) =>
        item.id === runId
          ? {
              ...item,
              status,
              startedAt:
                status === "running" && item.startedAt === null
                  ? timestamp
                  : item.startedAt,
            }
          : item,
      ),
    };
  }

  function emitRunStatus(
    runId: string,
    status: AgentRun["status"],
  ): void {
    const run = getActiveRun(runId);
    if (!run || !isRunActive(runId)) {
      return;
    }
    emit({
      type: "run-status",
      runId,
      threadId: run.threadId,
      status,
      at: new Date().toISOString(),
    });
  }

  function createRunControl(): MockRunControl {
    return {
      cancelled: false,
      delays: new Set(),
    };
  }

  function delayRun(runId: string, milliseconds: number): Promise<boolean> {
    const control = runControls.get(runId);
    if (!control || control.cancelled) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const pending: PendingRunDelay = {
        timer: 0,
        resolve,
      };
      pending.timer = window.setTimeout(() => {
        control.delays.delete(pending);
        resolve(isRunActive(runId));
      }, milliseconds);
      control.delays.add(pending);
    });
  }

  function cancelRunControl(runId: string): void {
    const control = runControls.get(runId);
    if (!control || control.cancelled) {
      return;
    }
    control.cancelled = true;
    for (const pending of control.delays) {
      window.clearTimeout(pending.timer);
      pending.resolve(false);
    }
    control.delays.clear();
  }

  function makeAgent(id: string, name: string, instructions: string): AgentProfile {
    return {
      id,
      projectId: project.id,
      name,
      runtimeKind: "native",
      instructions,
      providerProfileId: provider.id,
      modelOverride: null,
      toolPolicy: {
        readFiles: "allow",
        writeFiles: "ask",
        runCommands: "ask",
      },
      cliConfig: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function makeThread(
    id: string,
    agentProfileId: string,
    title: string,
    projectId = project.id,
  ): AgentThread {
    return {
      id,
      projectId,
      agentProfileId,
      title,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }
}

function makeMessage(
  id: string,
  threadId: string,
  sequence: number,
  role: ThreadMessage["role"],
  text: string,
  runId: string | null = null,
): ThreadMessage {
  return {
    id,
    threadId,
    runId,
    sequence,
    role,
    status: "committed",
    content: [{ type: "text", text }],
    metadata: {},
    createdAt: new Date().toISOString(),
  };
}

function saveMockProvider(
  input: SaveProviderProfileRequest,
  profiles: ProviderProfile[],
): ProviderProfile {
  const timestamp = new Date().toISOString();
  const existing = input.id
    ? profiles.find((item) => item.id === input.id)
    : null;
  return {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    defaultModel: input.defaultModel,
    apiKeyRef: input.clearApiKey
      ? null
      : input.apiKey
        ? existing?.apiKeyRef ?? `provider:${crypto.randomUUID()}`
        : existing?.apiKeyRef ?? null,
    customHeaders: {},
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type PendingRunDelay = {
  timer: number;
  resolve: (active: boolean) => void;
};

type MockRunControl = {
  cancelled: boolean;
  delays: Set<PendingRunDelay>;
};
