import type {
  AgentDefinition,
  AgentHandoff,
  AgentInstance,
  AgentProfile,
  AgentRun,
  AgentThread,
  Artifact,
  ContextRevision,
  InboxItem,
  Project,
  RuntimeNode,
  RunEvent,
  TaskAssignment,
  ThreadMessage,
  ToolApproval,
  ToolCallRecord,
  Workspace,
  WorkspaceSchedule,
  WorkspaceTask,
} from "@scopeguard/domain";
import type {
  DesktopWorkspaceSnapshot,
  ProviderProfileView,
  ScopeGuardDesktopApi,
  SaveProviderProfileRequest,
} from "@scopeguard/ipc-contracts";

export const desktopApi: ScopeGuardDesktopApi =
  window.scopeguardDesktop ?? createMockDesktopApi();

export const isDesktopRuntime = Boolean(window.scopeguardDesktop);

function createMockDesktopApi(): ScopeGuardDesktopApi {
  const now = new Date().toISOString();
  const provider: ProviderProfileView = {
    id: "provider-demo",
    name: "公司中转服务",
    protocol: "openai-compatible",
    baseUrl: "https://relay.example.com/v1",
    defaultModel: "general-model",
    hasApiKey: true,
    customHeaders: {},
    createdAt: now,
    updatedAt: now,
  };
  const project: Project = {
    id: "project-demo",
    name: "运营工作区",
    rootPath: "/Users/demo/Operations",
    currentContextRevisionId: "context-demo",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  const agents: AgentProfile[] = [
    makeAgent("agent-research", "调研", "收集证据并形成摘要。"),
    makeAgent("agent-docs", "文档", "起草清晰的内部文档。"),
    makeAgent("agent-dev", "开发", "实施限定范围的改动并完成验证。"),
  ];
  const threads: AgentThread[] = [
    makeThread("thread-research", agents[0]!.id, "供应商对比"),
    makeThread("thread-docs", agents[1]!.id, "季度简报"),
    makeThread("thread-dev", agents[2]!.id, "桌面端集成"),
  ];
  const workspace: Workspace = {
    id: project.id,
    name: project.name,
    localRootPath: project.rootPath,
    currentContextRevisionId: project.currentContextRevisionId,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  const localRuntime: RuntimeNode = {
    id: "local-runtime",
    name: "本机",
    kind: "local",
    baseUrl: null,
    hasCredential: false,
    status: "online",
    capabilities: {
      nativeAgents: true,
      cliAgents: true,
      fileTools: true,
      commandTools: true,
      persistentRuns: false,
    },
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const agentDefinitions: AgentDefinition[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.instructions,
    instructions: agent.instructions,
    providerProfileId: agent.providerProfileId,
    modelOverride: agent.modelOverride,
    toolPolicy: agent.toolPolicy,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }));
  const agentInstances: AgentInstance[] = agents.map((agent) => ({
    id: `instance-${agent.id}`,
    workspaceId: project.id,
    agentDefinitionId: agent.id,
    runtimeNodeId: localRuntime.id,
    nameOverride: null,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  }));
  const tasks: WorkspaceTask[] = threads.map((thread, index) => ({
    id: thread.id,
    workspaceId: project.id,
    title: thread.title,
    description: "",
    status: index === 0 ? "running" : "ready",
    priority: index === 0 ? "high" : "normal",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    completedAt: null,
  }));
  const assignments: TaskAssignment[] = threads.map((thread, index) => ({
    id: `assignment-${thread.id}`,
    taskId: thread.id,
    agentInstanceId: agentInstances[index]!.id,
    threadId: thread.id,
    role: index === 0 ? "调研" : index === 1 ? "写作" : "实施",
    position: index,
    status: index === 0 ? "running" : "pending",
    createdAt: now,
    updatedAt: now,
  }));
  const messages = new Map<string, ThreadMessage[]>([
    [
      "thread-research",
      [
        makeMessage(
          "message-r1",
          "thread-research",
          1,
          "user",
          "对比三个入围供应商，重点分析实施风险。",
        ),
        makeMessage(
          "message-r2",
          "thread-research",
          2,
          "assistant",
          "我对比了部署工作量、数据处理方式和运营成本。第二家供应商的迁移风险最低，第一家的审计控制最完善。",
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
          "把当前工作区决策整理成一份简洁的内部简报。",
        ),
        makeMessage(
          "message-d2",
          "thread-docs",
          2,
          "assistant",
          "简报已按决策、约束、实施顺序和待解决风险进行组织。",
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
          "桌面端运行环境已准备好，可以继续下一步集成。",
        ),
      ],
    ],
  ]);
  let snapshot: DesktopWorkspaceSnapshot = {
    workspaces: [workspace],
    runtimeNodes: [localRuntime],
    agentDefinitions,
    agentInstances,
    tasks,
    assignments,
    artifacts: [],
    handoffs: [],
    schedules: [],
    inboxItems: [],
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
        workspaceId: project.id,
        projectId: project.id,
        version: 3,
        parentId: "context-demo-2",
        scope: "workspace",
        taskId: null,
        title: "已确认的工作区约束",
        content:
          "通用模型统一使用公司中转服务。每条 Agent 对话保持独立，只有经过确认的决策才能发布到共享上下文。",
        sourceThreadId: "thread-docs",
        sourceRunId: null,
        sourceAgentInstanceId: null,
        sourceArtifactId: null,
        publishedBy: "user",
        createdAt: now,
      },
    ],
  ]);
  const listeners = new Set<(event: RunEvent) => void>();
  const runControls = new Map<string, MockRunControl>();
  const inputToolCalls = new Map<string, ToolCallRecord>();

  return {
    async getWorkspaceSnapshot() {
      return clone(snapshot);
    },
    async createWorkspace(input) {
      const timestamp = new Date().toISOString();
      const created: Workspace = {
        id: crypto.randomUUID(),
        name: input.name,
        localRootPath: input.localRootPath ?? null,
        currentContextRevisionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      const compatibilityProject: Project = {
        id: created.id,
        name: created.name,
        rootPath: created.localRootPath ?? `scopeguard://workspace/${created.id}`,
        currentContextRevisionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        workspaces: [created, ...snapshot.workspaces],
        projects: [compatibilityProject, ...snapshot.projects],
      };
      contexts.set(created.id, null);
      return clone(created);
    },
    async saveRuntimeNode(input) {
      const timestamp = new Date().toISOString();
      const existing = input.id
        ? snapshot.runtimeNodes.find((item) => item.id === input.id)
        : null;
      const saved: RuntimeNode = {
        id: existing?.id ?? input.id ?? crypto.randomUUID(),
        name: input.name,
        kind: input.kind,
        baseUrl: input.kind === "remote" ? input.baseUrl ?? null : null,
        hasCredential: input.clearCredential
          ? false
          : Boolean(input.credential) || existing?.hasCredential === true,
        status: input.kind === "local" ? "online" : "unknown",
        capabilities: input.kind === "local"
          ? localRuntime.capabilities
          : {
              nativeAgents: true,
              cliAgents: false,
              fileTools: false,
              commandTools: false,
              persistentRuns: true,
            },
        lastSeenAt: existing?.lastSeenAt ?? null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        runtimeNodes: [
          saved,
          ...snapshot.runtimeNodes.filter((item) => item.id !== saved.id),
        ],
      };
      return clone(saved);
    },
    async testRuntimeConnection(runtimeNodeId) {
      await delay(350);
      const runtime = snapshot.runtimeNodes.find((item) => item.id === runtimeNodeId);
      if (!runtime || runtime.kind !== "remote" || !runtime.baseUrl) {
        throw new Error("找不到可测试的远端 Runtime。");
      }
      if (!runtime.hasCredential) {
        throw new Error("请先保存 Runtime 凭证。");
      }
      const capabilities = {
        nativeAgents: true as const,
        cliAgents: false as const,
        fileTools: false as const,
        commandTools: false as const,
        persistentRuns: true as const,
      };
      const updated: RuntimeNode = {
        ...runtime,
        status: "online",
        capabilities,
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      snapshot = {
        ...snapshot,
        runtimeNodes: snapshot.runtimeNodes.map((item) =>
          item.id === updated.id ? updated : item
        ),
      };
      return {
        ok: true,
        latencyMs: 126,
        status: "online",
        capabilities,
        message: "Remote Runtime connection succeeded.",
      };
    },
    async createAgentDefinition(input) {
      const timestamp = new Date().toISOString();
      const created: AgentDefinition = {
        id: crypto.randomUUID(),
        name: input.name,
        description: input.description ?? "",
        instructions: input.instructions,
        providerProfileId: input.providerProfileId ?? null,
        modelOverride: input.modelOverride ?? null,
        toolPolicy: {
          readFiles: input.toolPolicy?.readFiles ?? "allow",
          writeFiles: input.toolPolicy?.writeFiles ?? "ask",
          runCommands: input.toolPolicy?.runCommands ?? "ask",
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        agentDefinitions: [...snapshot.agentDefinitions, created],
      };
      return clone(created);
    },
    async createAgentInstance(input) {
      const timestamp = new Date().toISOString();
      const created: AgentInstance = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        agentDefinitionId: input.agentDefinitionId,
        runtimeNodeId: input.runtimeNodeId,
        nameOverride: input.nameOverride ?? null,
        status: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        agentInstances: [...snapshot.agentInstances, created],
      };
      return clone(created);
    },
    async updateAgentInstanceRuntime(input) {
      const current = snapshot.agentInstances.find(
        (item) => item.id === input.agentInstanceId,
      );
      if (!current) {
        throw new Error("找不到 Agent 实例。");
      }
      const updated: AgentInstance = {
        ...current,
        runtimeNodeId: input.runtimeNodeId,
        status: "idle",
        updatedAt: new Date().toISOString(),
      };
      snapshot = {
        ...snapshot,
        agentInstances: snapshot.agentInstances.map((item) =>
          item.id === updated.id ? updated : item
        ),
      };
      return clone(updated);
    },
    async createTask(input) {
      const timestamp = new Date().toISOString();
      const created: WorkspaceTask = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        title: input.title,
        description: input.description ?? "",
        status: "draft",
        priority: input.priority ?? "normal",
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      };
      snapshot = { ...snapshot, tasks: [created, ...snapshot.tasks] };
      return clone(created);
    },
    async updateTaskStatus(request) {
      const task = snapshot.tasks.find((item) => item.id === request.taskId);
      if (!task) {
        throw new Error("找不到对应任务。");
      }
      const timestamp = new Date().toISOString();
      const updated: WorkspaceTask = {
        ...task,
        status: request.status,
        updatedAt: timestamp,
        completedAt: request.status === "completed" ? timestamp : task.completedAt,
      };
      snapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map((item) => item.id === updated.id ? updated : item),
      };
      return clone(updated);
    },
    async assignAgentToTask(input) {
      const timestamp = new Date().toISOString();
      const created: TaskAssignment = {
        id: crypto.randomUUID(),
        taskId: input.taskId,
        agentInstanceId: input.agentInstanceId,
        threadId: input.threadId ?? null,
        role: input.role ?? "",
        position: input.position ?? 0,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = { ...snapshot, assignments: [...snapshot.assignments, created] };
      return clone(created);
    },
    async createArtifact(input) {
      const created: Artifact = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        assignmentId: input.assignmentId ?? null,
        runId: input.runId ?? null,
        agentInstanceId: input.agentInstanceId,
        kind: input.kind,
        title: input.title,
        mimeType: input.mimeType,
        content: input.content ?? null,
        filePath: input.filePath ?? null,
        version: snapshot.artifacts.filter(
          (item) => item.taskId === input.taskId && item.title === input.title,
        ).length + 1,
        createdAt: new Date().toISOString(),
      };
      snapshot = { ...snapshot, artifacts: [created, ...snapshot.artifacts] };
      return clone(created);
    },
    async getWorkspaceContext(workspaceId) {
      return clone(contexts.get(workspaceId) ?? null);
    },
    async publishWorkspaceContext(input) {
      const timestamp = new Date().toISOString();
      const currentContext = contexts.get(input.workspaceId) ?? null;
      const updated: ContextRevision = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        projectId: input.workspaceId,
        version: (currentContext?.version ?? 0) + 1,
        parentId: currentContext?.id ?? null,
        scope: input.scope ?? "workspace",
        taskId: input.taskId ?? null,
        title: input.title,
        content: input.content,
        sourceThreadId: input.sourceThreadId ?? null,
        sourceRunId: input.sourceRunId ?? null,
        sourceAgentInstanceId: input.sourceAgentInstanceId ?? null,
        sourceArtifactId: input.sourceArtifactId ?? null,
        publishedBy: input.publishedBy,
        createdAt: timestamp,
      };
      contexts.set(input.workspaceId, updated);
      snapshot = {
        ...snapshot,
        workspaces: snapshot.workspaces.map((item) =>
          item.id === input.workspaceId
            ? { ...item, currentContextRevisionId: updated.id, updatedAt: timestamp }
            : item,
        ),
      };
      return clone(updated);
    },
    async createHandoff(input) {
      const created: AgentHandoff = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        fromAgentInstanceId: input.fromAgentInstanceId,
        toAgentInstanceId: input.toAgentInstanceId,
        sourceRunId: input.sourceRunId ?? null,
        contextRevisionId: input.contextRevisionId,
        summary: input.summary,
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      snapshot = { ...snapshot, handoffs: [created, ...snapshot.handoffs] };
      return clone(created);
    },
    async createSchedule(input) {
      const timestamp = new Date().toISOString();
      const created: WorkspaceSchedule = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        agentInstanceId: input.agentInstanceId,
        title: input.title,
        prompt: input.prompt,
        cronExpression: input.cronExpression,
        timeZone: input.timeZone,
        enabled: input.enabled ?? true,
        nextRunAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = { ...snapshot, schedules: [...snapshot.schedules, created] };
      return clone(created);
    },
    async resolveInboxItem(inboxItemId) {
      const item = snapshot.inboxItems.find((candidate) => candidate.id === inboxItemId);
      if (!item) {
        throw new Error("找不到待处理事项。");
      }
      if (
        item.kind === "input-required" &&
        snapshot.activeRuns.some(
          (run) => run.id === item.runId && run.status === "waiting-input",
        )
      ) {
        throw new Error("请先在 Agent 对话中回答，再处理这条待办。");
      }
      const updated: InboxItem = {
        ...item,
        status: "resolved",
        resolvedAt: new Date().toISOString(),
      };
      snapshot = {
        ...snapshot,
        inboxItems: snapshot.inboxItems.map((candidate) =>
          candidate.id === inboxItemId ? updated : candidate,
        ),
      };
      return clone(updated);
    },
    async chooseProjectDirectory() {
      return {
        canceled: false,
        rootPath: `/Users/demo/Workspace-${snapshot.projects.length + 1}`,
      };
    },
    async addProject(input) {
      const timestamp = new Date().toISOString();
      const added: Project = {
        id: crypto.randomUUID(),
        name: input.name || input.rootPath.split(/[\\/]/).at(-1) || "工作区",
        rootPath: input.rootPath,
        currentContextRevisionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        projects: [added, ...snapshot.projects],
        workspaces: [
          {
            id: added.id,
            name: added.name,
            localRootPath: added.rootPath,
            currentContextRevisionId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastOpenedAt: timestamp,
          },
          ...snapshot.workspaces,
        ],
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
        throw new Error("模型服务地址必须使用 HTTP 或 HTTPS。");
      }
      return {
        ok: true,
        latencyMs: 184,
        model: input.defaultModel,
        message: "连接成功。",
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
        executionProfile: input.executionProfile ?? (
          input.runtimeKind === "local-cli" ? "full-access" : "request-approval"
        ),
        toolPolicy: {
          readFiles: input.toolPolicy?.readFiles ?? "allow",
          writeFiles: input.toolPolicy?.writeFiles ?? "ask",
          runCommands: input.toolPolicy?.runCommands ?? "ask",
        },
        cliConfig: input.cliConfig ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const definition: AgentDefinition = {
        id: created.id,
        name: created.name,
        description: created.instructions,
        instructions: created.instructions,
        providerProfileId: created.providerProfileId,
        modelOverride: created.modelOverride,
        toolPolicy: created.toolPolicy,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const instance: AgentInstance = {
        id: crypto.randomUUID(),
        workspaceId: created.projectId,
        agentDefinitionId: definition.id,
        runtimeNodeId: input.runtimeNodeId ?? localRuntime.id,
        nameOverride: null,
        status: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = {
        ...snapshot,
        agentProfiles: [...snapshot.agentProfiles, created],
        agentDefinitions: [...snapshot.agentDefinitions, definition],
        agentInstances: [...snapshot.agentInstances, instance],
      };
      return clone(created);
    },
    async createThread(input) {
      const created = makeThread(
        crypto.randomUUID(),
        input.agentProfileId,
        input.title || "新对话",
        input.projectId,
      );
      const task: WorkspaceTask = {
        id: created.id,
        workspaceId: created.projectId,
        title: created.title,
        description: "",
        status: "ready",
        priority: "normal",
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        completedAt: null,
      };
      const instance = snapshot.agentInstances.find(
        (item) =>
          item.workspaceId === input.projectId &&
          item.agentDefinitionId === input.agentProfileId,
      );
      const assignment: TaskAssignment | null = instance
        ? {
            id: crypto.randomUUID(),
            taskId: task.id,
            agentInstanceId: instance.id,
            threadId: created.id,
            role: "",
            position: 0,
            status: "pending",
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          }
        : null;
      snapshot = {
        ...snapshot,
        threads: [created, ...snapshot.threads],
        tasks: [task, ...snapshot.tasks],
        assignments: assignment
          ? [assignment, ...snapshot.assignments]
          : snapshot.assignments,
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
        throw new Error("找不到对应的对话。");
      }
      const waitingRun = snapshot.activeRuns.find(
        (item) => item.threadId === input.threadId && item.status === "waiting-input",
      );
      if (waitingRun) {
        const userMessage = makeMessage(
          crypto.randomUUID(),
          input.threadId,
          nextMessageSequence(input.threadId),
          "user",
          input.prompt,
          waitingRun.id,
        );
        appendMessage(userMessage);
        const toolCall = inputToolCalls.get(waitingRun.id);
        const toolResult = toolCall
          ? makeToolResultMessage(waitingRun, toolCall, input.prompt, false)
          : null;
        if (toolResult) {
          appendMessage(toolResult);
        }
        snapshot = {
          ...snapshot,
          activeRuns: snapshot.activeRuns.map((item) =>
            item.id === waitingRun.id ? { ...item, status: "running" } : item,
          ),
          inboxItems: snapshot.inboxItems.map((item) =>
            item.runId === waitingRun.id && item.kind === "input-required"
              ? { ...item, status: "resolved", resolvedAt: timestamp }
              : item,
          ),
          tasks: snapshot.tasks.map((task) =>
            task.id === input.threadId
              ? { ...task, status: "running", updatedAt: timestamp }
              : task,
          ),
          assignments: snapshot.assignments.map((assignment) =>
            assignment.threadId === input.threadId
              ? { ...assignment, status: "running", updatedAt: timestamp }
              : assignment,
          ),
        };
        emit({
          type: "message-created",
          runId: waitingRun.id,
          threadId: waitingRun.threadId,
          message: userMessage,
          at: timestamp,
        });
        if (toolResult) {
          emit({
            type: "message-created",
            runId: waitingRun.id,
            threadId: waitingRun.threadId,
            message: toolResult,
            at: timestamp,
          });
        }
        emitRunStatus(waitingRun.id, "running");
        inputToolCalls.delete(waitingRun.id);
        void finishRunWithAssistant(
          waitingRun.id,
          `已收到补充信息“${input.prompt}”，并据此继续完成任务。`,
        );
        return clone({ ...waitingRun, status: "running" });
      }
      const terminalRunIds = new Set(
        snapshot.recentRuns
          .filter((run) => run.threadId === input.threadId)
          .map((run) => run.id),
      );
      snapshot = {
        ...snapshot,
        inboxItems: snapshot.inboxItems.map((item) =>
          item.kind === "input-required" &&
            item.runId &&
            terminalRunIds.has(item.runId) &&
            item.status !== "resolved"
            ? { ...item, status: "resolved", resolvedAt: timestamp }
            : item,
        ),
      };
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
      const assignment = snapshot.assignments.find(
        (item) => item.threadId === input.threadId,
      );
      snapshot = {
        ...snapshot,
        activeRuns: [...snapshot.activeRuns, run],
        tasks: snapshot.tasks.map((task) =>
          task.id === input.threadId
            ? { ...task, status: "running", updatedAt: timestamp }
            : task,
        ),
        assignments: snapshot.assignments.map((assignment) =>
          assignment.threadId === input.threadId
            ? { ...assignment, status: "running", updatedAt: timestamp }
            : assignment,
        ),
        handoffs: snapshot.handoffs.map((handoff) =>
          handoff.status === "pending" &&
            handoff.toAgentInstanceId === assignment?.agentInstanceId &&
            handoff.contextRevisionId === run.contextRevisionId
            ? { ...handoff, status: "accepted", resolvedAt: timestamp }
            : handoff,
        ),
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
        tasks: snapshot.tasks.map((task) =>
          task.id === run.threadId
            ? { ...task, status: "cancelled", updatedAt: new Date().toISOString() }
            : task,
        ),
        assignments: snapshot.assignments.map((assignment) =>
          assignment.threadId === run.threadId
            ? { ...assignment, status: "cancelled", updatedAt: new Date().toISOString() }
            : assignment,
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
      inputToolCalls.delete(runId);
    },
    async resolveApproval(approvalId, decision) {
      const pending = snapshot.pendingApprovals.find(
        (item) => item.approval.id === approvalId,
      );
      if (!pending) {
        throw new Error("找不到待审批事项。");
      }
      snapshot = {
        ...snapshot,
        pendingApprovals: snapshot.pendingApprovals.filter(
          (item) => item.approval.id !== approvalId,
        ),
        inboxItems: snapshot.inboxItems.map((item) =>
          item.approvalId === approvalId
            ? { ...item, status: "resolved", resolvedAt: new Date().toISOString() }
            : item,
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
        error: denied ? "用户拒绝执行命令。" : null,
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
          ? "用户拒绝执行命令。"
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
          ? "命令未获批准，因此没有执行。本次运行已继续，工作区内容没有发生变化。"
          : "已批准的命令执行成功，输出为：scopeguard-command-approved",
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
        workspaceId: request.projectId,
        projectId: request.projectId,
        version: (currentContext?.version ?? 0) + 1,
        parentId: currentContext?.id ?? null,
        scope: "workspace",
        taskId: null,
        title: `工作区上下文 v${(currentContext?.version ?? 0) + 1}`,
        content: request.content,
        sourceThreadId: request.sourceThreadId ?? null,
        sourceRunId: request.sourceRunId ?? null,
        sourceAgentInstanceId: null,
        sourceArtifactId: null,
        publishedBy: "user",
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
        workspaces: snapshot.workspaces.map((item) =>
          item.id === request.projectId
            ? {
                ...item,
                currentContextRevisionId: updatedContext.id,
                updatedAt: timestamp,
              }
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
    if (prompt.includes("/ask-input")) {
      await simulateInputRequest(run);
      return;
    }
    const response =
      `我已处理“${prompt}”。本次工作仅限当前对话，并使用当前工作区上下文版本。`;
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
      description: "运行一条可复现的网页预览命令",
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
      reason: "网页预览中的命令需要你明确批准后才能执行。",
      createdAt: timestamp,
      resolvedAt: null,
    };
    const assignment = snapshot.assignments.find(
      (item) => item.threadId === run.threadId,
    );
    const task = assignment
      ? snapshot.tasks.find((item) => item.id === assignment.taskId)
      : null;
    const inboxItem: InboxItem | null = assignment && task
      ? {
          id: crypto.randomUUID(),
          workspaceId: task.workspaceId,
          kind: "approval",
          status: "unread",
          title: "等待工具审批",
          summary: approval.reason,
          taskId: task.id,
          assignmentId: assignment.id,
          runId: run.id,
          approvalId: approval.id,
          agentInstanceId: assignment.agentInstanceId,
          createdAt: timestamp,
          resolvedAt: null,
        }
      : null;
    snapshot = {
      ...snapshot,
      pendingApprovals: [
        ...snapshot.pendingApprovals,
        { approval, toolCall },
      ],
      inboxItems: inboxItem
        ? [inboxItem, ...snapshot.inboxItems]
        : snapshot.inboxItems,
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

  async function simulateInputRequest(run: AgentRun): Promise<void> {
    if (!(await delayRun(run.id, 180))) {
      return;
    }
    const timestamp = new Date().toISOString();
    const toolCall: ToolCallRecord = {
      id: crypto.randomUUID(),
      runId: run.id,
      sequence: 1,
      providerCallId: `mock-input-${crypto.randomUUID()}`,
      name: "request_user_input",
      description: "询问报告所需的时间范围",
      arguments: { question: "这份报告应覆盖哪个时间范围？" },
      status: "running",
      output: null,
      error: null,
      createdAt: timestamp,
      completedAt: null,
    };
    const assistant = makeToolCallMessage(run, toolCall);
    appendMessage(assistant);
    inputToolCalls.set(run.id, toolCall);
    const assignment = snapshot.assignments.find(
      (item) => item.threadId === run.threadId,
    );
    const task = assignment
      ? snapshot.tasks.find((item) => item.id === assignment.taskId)
      : null;
    const inboxItem: InboxItem | null = assignment && task
      ? {
          id: crypto.randomUUID(),
          workspaceId: task.workspaceId,
          kind: "input-required",
          status: "unread",
          title: "Agent 需要补充信息",
          summary: "这份报告应覆盖哪个时间范围？",
          taskId: task.id,
          assignmentId: assignment.id,
          runId: run.id,
          approvalId: null,
          agentInstanceId: assignment.agentInstanceId,
          createdAt: timestamp,
          resolvedAt: null,
        }
      : null;
    updateActiveRunStatus(run.id, "waiting-input");
    snapshot = {
      ...snapshot,
      tasks: snapshot.tasks.map((item) =>
        item.id === task?.id
          ? { ...item, status: "waiting-input", updatedAt: timestamp }
          : item,
      ),
      assignments: snapshot.assignments.map((item) =>
        item.id === assignment?.id
          ? { ...item, status: "waiting-input", updatedAt: timestamp }
          : item,
      ),
      inboxItems: inboxItem ? [inboxItem, ...snapshot.inboxItems] : snapshot.inboxItems,
    };
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
    emitRunStatus(run.id, "waiting-input");
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
    const timestamp = new Date().toISOString();
    const assignment = snapshot.assignments.find(
      (item) => item.threadId === run.threadId,
    );
    const task = assignment
      ? snapshot.tasks.find((item) => item.id === assignment.taskId)
      : null;
    const artifact: Artifact | null = assignment && task
      ? {
          id: crypto.randomUUID(),
          workspaceId: task.workspaceId,
          taskId: task.id,
          assignmentId: assignment.id,
          runId: run.id,
          agentInstanceId: assignment.agentInstanceId,
          kind: "report",
          title: task.title,
          mimeType: "text/markdown",
          content: response,
          filePath: null,
          version: snapshot.artifacts.filter(
            (item) => item.taskId === task.id && item.title === task.title,
          ).length + 1,
          createdAt: timestamp,
        }
      : null;
    const inboxItem: InboxItem | null = assignment && task
      ? {
          id: crypto.randomUUID(),
          workspaceId: task.workspaceId,
          kind: "task-completed",
          status: "unread",
          title: "任务已完成",
          summary: task.title,
          taskId: task.id,
          assignmentId: assignment.id,
          runId: run.id,
          approvalId: null,
          agentInstanceId: assignment.agentInstanceId,
          createdAt: timestamp,
          resolvedAt: null,
        }
      : null;
    snapshot = {
      ...snapshot,
      activeRuns: snapshot.activeRuns.filter((item) => item.id !== run.id),
      recentRuns: [
        {
          ...activeRun,
          status: "completed",
          completedAt: timestamp,
        },
        ...snapshot.recentRuns.filter((item) => item.id !== run.id),
      ],
      tasks: snapshot.tasks.map((item) =>
        item.id === task?.id
          ? { ...item, status: "completed", completedAt: timestamp, updatedAt: timestamp }
          : item,
      ),
      assignments: snapshot.assignments.map((item) =>
        item.id === assignment?.id
          ? { ...item, status: "completed", updatedAt: timestamp }
          : item,
      ),
      artifacts: artifact ? [artifact, ...snapshot.artifacts] : snapshot.artifacts,
      inboxItems: inboxItem ? [inboxItem, ...snapshot.inboxItems] : snapshot.inboxItems,
    };
    emit({
      type: "message-created",
      runId: run.id,
      threadId: run.threadId,
      message: assistant,
      at: timestamp,
    });
    emit({
      type: "run-status",
      runId: run.id,
      threadId: run.threadId,
      status: "completed",
      at: timestamp,
    });
    cancelRunControl(run.id);
    runControls.delete(run.id);
    inputToolCalls.delete(run.id);
  }

  function makeRunConfigSnapshot(thread: AgentThread): AgentRun["configSnapshot"] {
    const agent = snapshot.agentProfiles.find(
      (item) => item.id === thread.agentProfileId,
    );
    if (!agent) {
      throw new Error("找不到 Agent 配置。");
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
      executionProfile: agent.executionProfile,
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
      executionProfile: "request-approval",
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
  profiles: ProviderProfileView[],
): ProviderProfileView {
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
    hasApiKey: input.clearApiKey
      ? false
      : Boolean(input.apiKey?.trim()) || existing?.hasApiKey === true,
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
