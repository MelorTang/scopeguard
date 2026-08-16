import type {
  Agent,
  AgentRun,
  Conversation,
  ConversationMessage,
  RunEvent,
  Workspace,
  WorkspaceContextRevision,
} from "@scopeguard/domain";
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
    workspaces: [workspace],
    providerProfiles: [provider],
    agents: [
      makeAgent("agent-research", "调研 Agent", "收集证据并形成摘要。"),
      makeAgent("agent-docs", "文档 Agent", "起草清晰的内部文档。"),
      makeAgent("agent-review", "核验 Agent", "核验结论并指出证据缺口。"),
    ],
    conversations: [
      makeConversation("conversation-research", "agent-research", "供应商对比"),
      makeConversation("conversation-docs", "agent-docs", "季度简报"),
      makeConversation("conversation-review", "agent-review", "结论核验"),
    ],
    activeRuns: [],
    recentRuns: [],
    pendingApprovals: [],
  };
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
      return { canceled: true };
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
      }), 350);
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

  function makeAgent(id: string, name: string, instructions: string): Agent {
    return {
      id,
      workspaceId: workspace.id,
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
