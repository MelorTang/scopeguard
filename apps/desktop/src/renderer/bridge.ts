import type {
  Agent,
  AgentRun,
  Conversation,
  ConversationMessage,
  Dispatch,
  RunEvent,
  Workspace,
  WorkspaceContextRevision,
} from "@scopeguard/domain";
import { parseWorkspaceLayout } from "@scopeguard/domain";
import type {
  DesktopWorkspaceSnapshot,
  ProviderProfileView,
  ScopeGuardDesktopApi,
} from "@scopeguard/ipc-contracts";

export const desktopApi: ScopeGuardDesktopApi =
  window.scopeguardDesktop ?? createMockDesktopApi();

export const isDesktopRuntime = Boolean(window.scopeguardDesktop);

function createMockDesktopApi(): ScopeGuardDesktopApi {
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: "workspace-demo",
    name: "ScopeGuard 产品工作区",
    localRootPath: "/Users/demo/ScopeGuard",
    currentContextRevisionId: null,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  const workspaceB: Workspace = {
    ...workspace,
    id: "workspace-b",
    name: "独立工作区 B",
    localRootPath: "/Users/demo/WorkspaceB",
  };
  const provider: ProviderProfileView = {
    id: "provider-demo",
    name: "公司模型服务",
    protocol: "openai-compatible",
    baseUrl: "https://relay.example.com/v1",
    defaultModel: "general-model",
    hasApiKey: true,
    customHeaders: {},
    createdAt: now,
    updatedAt: now,
  };
  let snapshot: DesktopWorkspaceSnapshot = {
    workspaces: [workspace, workspaceB],
    providerProfiles: [provider],
    agents: [
      makeAgent("agent-research", "调研 Agent", "收集证据并形成摘要。"),
      makeAgent("agent-docs", "文档 Agent", "起草清晰的内部文档。"),
      makeAgent("agent-review", "核验 Agent", "核验结论并指出证据缺口。"),
      makeAgent("agent-ops", "执行 Agent", "执行明确任务并反馈结果。"),
      makeAgent("agent-archive", "归档 Agent", "整理交付资料并归档。"),
      makeAgent("agent-b-primary", "B 主 Agent", "只处理 B 工作区。", workspaceB.id),
      makeAgent("agent-b-review", "B 核验 Agent", "只核验 B 工作区。", workspaceB.id),
    ],
    conversations: [
      makeConversation("conversation-research", "agent-research", "供应商对比"),
      makeConversation("conversation-docs", "agent-docs", "季度简报"),
      makeConversation("conversation-review", "agent-review", "结论核验"),
      makeConversation("conversation-ops", "agent-ops", "交付执行"),
      makeConversation("conversation-archive", "agent-archive", "数据归档"),
      makeConversation("conversation-b-primary", "agent-b-primary", "B 对话", workspaceB.id),
      makeConversation("conversation-b-review", "agent-b-review", "B 核验", workspaceB.id),
    ],
    activeRuns: [],
    recentRuns: [],
    pendingApprovals: [],
    layouts: [{
      workspaceId: workspace.id,
      openConversationIds: [
        "conversation-research",
        "conversation-docs",
        "conversation-review",
        "conversation-ops",
      ],
      paneConversationIds: [
        "conversation-research",
        "conversation-docs",
        "conversation-review",
        "conversation-ops",
      ],
      paneWidths: [400, 400, 400, 400],
      activeConversationId: "conversation-research",
      requestedPaneCount: 4,
    }, {
      workspaceId: workspaceB.id,
      openConversationIds: ["conversation-b-primary", "conversation-b-review"],
      paneConversationIds: ["conversation-b-primary", "conversation-b-review"],
      paneWidths: [400, 400],
      activeConversationId: "conversation-b-primary",
      requestedPaneCount: 2,
    }],
    dispatches: [],
  };
  const persistedLayouts = snapshot.layouts.map((layout) =>
    readPersistedMockLayout(
      layout.workspaceId,
      new Set(snapshot.conversations
        .filter(({ workspaceId }) => workspaceId === layout.workspaceId)
        .map(({ id }) => id)),
    ) ?? layout
  );
  snapshot = { ...snapshot, layouts: persistedLayouts };
  const messages = new Map<string, ConversationMessage[]>([
    ["conversation-research", [
      makeMessage("conversation-research", "user", "整理三家供应商的差异。", 1),
      makeMessage(
        "conversation-research",
        "assistant",
        "已按能力、成本和交付风险整理出第一轮对比。",
        2,
      ),
    ]],
    ["conversation-docs", [
      makeMessage("conversation-docs", "user", "起草本季度内部简报。", 1),
    ]],
    ["conversation-review", []],
    ["conversation-ops", []],
    ["conversation-archive", []],
    ["conversation-b-primary", []],
    ["conversation-b-review", []],
  ]);
  const contexts = new Map<string, WorkspaceContextRevision>();
  const listeners = new Set<(event: RunEvent) => void>();

  const emit = (event: RunEvent) => {
    for (const listener of listeners) listener(clone(event));
  };
  const publishSnapshot = () => clone(snapshot);

  return {
    async getWorkspaceSnapshot() {
      return publishSnapshot();
    },
    async createWorkspace(input) {
      const timestamp = new Date().toISOString();
      const created: Workspace = {
        id: createId("workspace"),
        name: input.name.trim(),
        localRootPath: input.localRootPath?.trim() || null,
        currentContextRevisionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      snapshot = { ...snapshot, workspaces: [created, ...snapshot.workspaces] };
      return clone(created);
    },
    async chooseWorkspaceDirectory() {
      return {
        canceled: false,
        localRootPath: "/Users/demo/OpenedLocalB",
      };
    },
    async chooseWorkspaceFiles() {
      return { canceled: true, files: [] };
    },
    async saveProviderProfile(input) {
      const timestamp = new Date().toISOString();
      const current = input.id
        ? snapshot.providerProfiles.find((item) => item.id === input.id)
        : null;
      const saved: ProviderProfileView = {
        id: input.id ?? createId("provider"),
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        defaultModel: input.defaultModel,
        hasApiKey: input.clearApiKey ? false : Boolean(input.apiKey) || Boolean(current?.hasApiKey),
        customHeaders: {},
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
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
      return { ok: true, latencyMs: 42, model: input.defaultModel, message: "连接成功" };
    },
    async createAgent(input) {
      const timestamp = new Date().toISOString();
      const agent: Agent = {
        id: createId("agent"),
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        instructions: input.instructions,
        providerProfileId: input.providerProfileId,
        modelOverride: input.modelOverride?.trim() || null,
        defaultExecutionProfile: input.executionProfile ?? "request-approval",
        toolPolicy: {
          readFiles: input.toolPolicy?.readFiles ?? "allow",
          writeFiles: input.toolPolicy?.writeFiles ?? "ask",
          runCommands: input.toolPolicy?.runCommands ?? "ask",
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = { ...snapshot, agents: [...snapshot.agents, agent] };
      return clone(agent);
    },
    async createConversation(input) {
      const agent = snapshot.agents.find((item) => item.id === input.agentId);
      if (!agent) throw new Error("Agent not found.");
      const conversation = makeConversation(
        createId("conversation"),
        agent.id,
        input.title?.trim() || "新对话",
        input.workspaceId,
        agent.defaultExecutionProfile,
      );
      snapshot = {
        ...snapshot,
        conversations: [conversation, ...snapshot.conversations],
      };
      messages.set(conversation.id, []);
      return clone(conversation);
    },
    async updateConversationSettings(input) {
      const conversation = snapshot.conversations.find(
        (item) => item.id === input.conversationId,
      );
      if (!conversation) throw new Error("Conversation not found.");
      const updated: Conversation = {
        ...conversation,
        modelOverride: input.modelOverride === undefined
          ? conversation.modelOverride
          : input.modelOverride,
        executionProfile: input.executionProfile ?? conversation.executionProfile,
        updatedAt: new Date().toISOString(),
      };
      snapshot = {
        ...snapshot,
        conversations: snapshot.conversations.map((item) =>
          item.id === updated.id ? updated : item
        ),
      };
      return clone(updated);
    },
    async getWorkspaceLayout(workspaceId) {
      return clone(snapshot.layouts.find((layout) => layout.workspaceId === workspaceId) ?? null);
    },
    async stageWorkspaceLayout(layout) {
      sessionStorage.setItem(
        `scopeguard.mock.workspace-layout:${layout.workspaceId}`,
        JSON.stringify(layout),
      );
      snapshot = {
        ...snapshot,
        layouts: [layout, ...snapshot.layouts.filter((item) => item.workspaceId !== layout.workspaceId)],
      };
      return { accepted: true };
    },
    async flushWorkspaceLayouts() {
      // The browser preview persists staged layouts synchronously above to model Main ownership.
    },
    async saveWorkspaceLayout(layout) {
      sessionStorage.setItem(
        `scopeguard.mock.workspace-layout:${layout.workspaceId}`,
        JSON.stringify(layout),
      );
      snapshot = {
        ...snapshot,
        layouts: [layout, ...snapshot.layouts.filter((item) => item.workspaceId !== layout.workspaceId)],
      };
      return clone(layout);
    },
    subscribeRendererLayoutLifecycleRequests() {
      return () => undefined;
    },
    async listConversationMessages(conversationId) {
      return clone(messages.get(conversationId) ?? []);
    },
    async startRun(input) {
      const conversation = snapshot.conversations.find(
        (item) => item.id === input.conversationId,
      );
      const agent = snapshot.agents.find((item) => item.id === conversation?.agentId);
      if (!conversation || !agent) throw new Error("Conversation not found.");
      const timestamp = new Date().toISOString();
      const userMessage = makeMessage(
        conversation.id,
        "user",
        input.prompt,
        (messages.get(conversation.id)?.length ?? 0) + 1,
      );
      messages.set(conversation.id, [...(messages.get(conversation.id) ?? []), userMessage]);
      const run: AgentRun = {
        id: createId("run"),
        conversationId: conversation.id,
        triggerMessageId: userMessage.id,
        contextRevisionId: null,
        configSnapshot: {
          agentId: agent.id,
          providerProfileId: agent.providerProfileId,
          providerProtocol: provider.protocol,
          providerBaseUrl: provider.baseUrl,
          model: conversation.modelOverride ?? agent.modelOverride ?? provider.defaultModel,
          instructions: agent.instructions,
          executionProfile: conversation.executionProfile,
          toolPolicy: agent.toolPolicy,
        },
        status: "running",
        startedAt: timestamp,
        completedAt: null,
        error: null,
        effect: "none",
        createdAt: timestamp,
      };
      snapshot = { ...snapshot, activeRuns: [...snapshot.activeRuns, run] };
      emit({
        type: "message-created",
        runId: run.id,
        conversationId: conversation.id,
        message: userMessage,
        at: timestamp,
      });
      emit({
        type: "run-status",
        runId: run.id,
        conversationId: conversation.id,
        status: "running",
        at: timestamp,
      });
      window.setTimeout(() => completeMockRun(run, conversation, messages, emit, (next) => {
        snapshot = next(snapshot);
      }), input.prompt.includes("慢速") ? 3_000 : 350);
      return clone(run);
    },
    async cancelRun(runId) {
      const run = snapshot.activeRuns.find((item) => item.id === runId);
      if (!run) return;
      const completedAt = new Date().toISOString();
      const cancelled: AgentRun = { ...run, status: "cancelled", completedAt };
      snapshot = {
        ...snapshot,
        activeRuns: snapshot.activeRuns.filter((item) => item.id !== runId),
        recentRuns: [cancelled, ...snapshot.recentRuns],
      };
      emit({
        type: "run-status",
        runId,
        conversationId: run.conversationId,
        status: "cancelled",
        at: completedAt,
      });
    },
    async resolveApproval() {},
    async createDispatch(input) {
      const timestamp = new Date().toISOString();
      const dispatch: Dispatch = {
        id: createId("dispatch"),
        workspaceId: input.workspaceId,
        sourceConversationId: input.sourceConversationId,
        targetConversationId: input.targetConversationId,
        prompt: input.prompt.trim(),
        status: "pending",
        sourceRunId: input.sourceRunId ?? null,
        targetRunId: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot = { ...snapshot, dispatches: [...snapshot.dispatches, dispatch] };
      return clone(dispatch);
    },
    async listDispatches(workspaceId) {
      return clone(snapshot.dispatches.filter((item) => item.workspaceId === workspaceId));
    },
    async executeDispatch(dispatchId) {
      const dispatch = snapshot.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch) throw new Error("Dispatch not found.");
      const targetBusy = snapshot.activeRuns.some(
        (run) => run.conversationId === dispatch.targetConversationId,
      );
      if (targetBusy) {
        const failed: Dispatch = {
          ...dispatch,
          status: "failed",
          error: "Target Conversation already has an active Run.",
          updatedAt: new Date().toISOString(),
        };
        snapshot = {
          ...snapshot,
          dispatches: snapshot.dispatches.map((item) => item.id === failed.id ? failed : item),
        };
        return clone(failed);
      }
      const run = await this.startRun({
        conversationId: dispatch.targetConversationId,
        prompt: dispatch.prompt,
      });
      const running: Dispatch = {
        ...dispatch,
        status: "running",
        targetRunId: run.id,
        updatedAt: new Date().toISOString(),
      };
      snapshot = {
        ...snapshot,
        dispatches: snapshot.dispatches.map((item) => item.id === running.id ? running : item),
      };
      return clone(running);
    },
    async generateHandoffPrompt(input) {
      const source = snapshot.conversations.find((item) => item.id === input.sourceConversationId);
      const target = snapshot.conversations.find((item) => item.id === input.targetConversationId);
      const sourceAgent = snapshot.agents.find((item) => item.id === source?.agentId);
      const targetAgent = snapshot.agents.find((item) => item.id === target?.agentId);
      if (!source || !target || !sourceAgent || !targetAgent) throw new Error("Conversation not found.");
      return {
        sourceConversationId: source.id,
        targetConversationId: target.id,
        text: [
          "# Handoff Prompt",
          "",
          `来源 Agent：${sourceAgent.name}`,
          `来源 Conversation：${source.title}`,
          `目标 Agent：${targetAgent.name}`,
          `目标 Conversation：${target.title}`,
          "",
          "## 工作请求",
          input.workRequest.trim(),
          "",
          "请仅依据本 Prompt 和目标 Conversation 已有上下文执行；未附带来源 Conversation 的完整历史。",
        ].join("\n"),
      };
    },
    async copyHandoffPrompt(text) {
      await navigator.clipboard.writeText(text);
    },
    async getWorkspaceContext(workspaceId) {
      return clone(contexts.get(workspaceId) ?? null);
    },
    async updateWorkspaceContext(request) {
      const current = contexts.get(request.workspaceId);
      const timestamp = new Date().toISOString();
      const revision: WorkspaceContextRevision = {
        id: createId("context"),
        workspaceId: request.workspaceId,
        version: (current?.version ?? 0) + 1,
        parentId: current?.id ?? null,
        title: `Workspace context v${(current?.version ?? 0) + 1}`,
        content: request.content,
        sourceConversationId: request.sourceConversationId ?? null,
        sourceRunId: request.sourceRunId ?? null,
        publishedBy: request.sourceRunId ? "agent" : "user",
        createdAt: timestamp,
      };
      contexts.set(request.workspaceId, revision);
      snapshot = {
        ...snapshot,
        workspaces: snapshot.workspaces.map((item) =>
          item.id === request.workspaceId
            ? { ...item, currentContextRevisionId: revision.id, updatedAt: timestamp }
            : item
        ),
      };
      return clone(revision);
    },
    subscribeRunEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function makeAgent(
    id: string,
    name: string,
    instructions: string,
    workspaceId = workspace.id,
  ): Agent {
    return {
      id,
      workspaceId,
      name,
      instructions,
      providerProfileId: provider.id,
      modelOverride: null,
      defaultExecutionProfile: "request-approval",
      toolPolicy: { readFiles: "allow", writeFiles: "ask", runCommands: "ask" },
      createdAt: now,
      updatedAt: now,
    };
  }
}

function readPersistedMockLayout(
  workspaceId: string,
  conversationIds: ReadonlySet<string>,
) {
  const key = `scopeguard.mock.workspace-layout:${workspaceId}`;
  const value = sessionStorage.getItem(key);
  if (!value) return null;
  try {
    return parseWorkspaceLayout(JSON.parse(value), conversationIds);
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
}

function makeConversation(
  id: string,
  agentId: string,
  title: string,
  workspaceId = "workspace-demo",
  executionProfile: Conversation["executionProfile"] = "request-approval",
): Conversation {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId,
    agentId,
    title,
    status: "active",
    modelOverride: null,
    executionProfile,
    piSession: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMessage(
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  sequence: number,
): ConversationMessage {
  return {
    id: createId("message"),
    conversationId,
    runId: null,
    sequence,
    role,
    status: "committed",
    content: [{ type: "text", text }],
    metadata: {},
    createdAt: new Date().toISOString(),
  };
}

function completeMockRun(
  run: AgentRun,
  conversation: Conversation,
  messages: Map<string, ConversationMessage[]>,
  emit: (event: RunEvent) => void,
  updateSnapshot: (
    update: (snapshot: DesktopWorkspaceSnapshot) => DesktopWorkspaceSnapshot,
  ) => void,
): void {
  const at = new Date().toISOString();
  const message = {
    ...makeMessage(
      conversation.id,
      "assistant",
      "已完成这一步。这里是 Web 预览中的模拟回复；桌面端会由真实 Agent 返回结果。",
      (messages.get(conversation.id)?.length ?? 0) + 1,
    ),
    runId: run.id,
  };
  messages.set(conversation.id, [...(messages.get(conversation.id) ?? []), message]);
  const completed: AgentRun = { ...run, status: "completed", completedAt: at };
  updateSnapshot((snapshot) => ({
    ...snapshot,
    activeRuns: snapshot.activeRuns.filter((item) => item.id !== run.id),
    recentRuns: [completed, ...snapshot.recentRuns],
    dispatches: snapshot.dispatches.map((dispatch) =>
      dispatch.targetRunId === run.id && dispatch.status === "running"
        ? { ...dispatch, status: "completed", error: null, updatedAt: at }
        : dispatch
    ),
  }));
  emit({
    type: "message-created",
    runId: run.id,
    conversationId: conversation.id,
    message,
    at,
  });
  emit({
    type: "run-status",
    runId: run.id,
    conversationId: conversation.id,
    status: "completed",
    at,
  });
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
