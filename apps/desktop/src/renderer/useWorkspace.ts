import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Agent,
  AgentRun,
  ApprovalDecision,
  Conversation,
  ConversationMessage,
  CreateAgentInput,
  ManagedExecutionStage,
  ProviderConnectionResult,
  RunEvent,
  UpdateConversationSettingsInput,
  Workspace,
} from "@scopeguard/domain";
import type {
  DesktopWorkspaceSnapshot,
  ProviderProfileView,
  SaveProviderProfileRequest,
  WorkspaceFileSelection,
} from "@scopeguard/ipc-contracts";

import { desktopApi } from "./bridge.js";

type PersistedUiState = {
  selectedWorkspaceId: string | null;
  activeConversationId: string | null;
  openConversationIds: string[];
  paneConversationIds: string[];
  requestedSplitCount: number;
  sidebarCollapsed: boolean;
  professionalMode: boolean;
};

type ApprovalFocusRequest = {
  conversationId: string;
  approvalId: string;
  sequence: number;
};

const DEFAULT_UI_STATE: PersistedUiState = {
  selectedWorkspaceId: null,
  activeConversationId: null,
  openConversationIds: [],
  paneConversationIds: [],
  requestedSplitCount: 1,
  sidebarCollapsed: false,
  professionalMode: false,
};

export type WorkspaceController = {
  snapshot: DesktopWorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedProject: Workspace | null;
  selectedWorkspace: Workspace | null;
  activeThread: Conversation | null;
  activeAgent: Agent | null;
  visibleThreads: Conversation[];
  messagesByThread: Record<string, ConversationMessage[]>;
  streamingByThread: Record<string, string>;
  executionStageByThread: Record<string, ManagedExecutionStage>;
  requestedSplitCount: number;
  effectiveSplitCount: number;
  maxSplitCount: number;
  activePaneIndex: number;
  sidebarCollapsed: boolean;
  professionalMode: boolean;
  approvalFocus: ApprovalFocusRequest | null;
  selectProject: (workspaceId: string) => void;
  openThread: (conversationId: string) => void;
  focusApproval: (conversationId: string, approvalId: string) => void;
  selectPane: (paneIndex: number) => void;
  setRequestedSplitCount: (count: number) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setProfessionalMode: (value: boolean) => void;
  refresh: () => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  openLocalWorkspace: () => Promise<Workspace | null>;
  saveProvider: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderProfileView>;
  testProvider: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderConnectionResult>;
  createAgentConversation: (
    agentInput: Omit<CreateAgentInput, "workspaceId">,
    title: string,
  ) => Promise<Conversation>;
  createConversation: (agentId: string, title: string) => Promise<Conversation>;
  updateConversationSettings: (
    input: UpdateConversationSettingsInput,
  ) => Promise<Conversation>;
  chooseWorkspaceFiles: () => Promise<WorkspaceFileSelection[]>;
  sendMessage: (conversationId: string, prompt: string) => Promise<AgentRun>;
  cancelRun: (runId: string) => Promise<void>;
  resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  getRunForThread: (conversationId: string) => AgentRun | null;
  getLatestRunForThread: (conversationId: string) => AgentRun | null;
  retryThread: (conversationId: string) => Promise<AgentRun>;
};

export function useWorkspace(): WorkspaceController {
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ui, setUi] = useState<PersistedUiState>(readUiState);
  const [messagesByThread, setMessagesByThread] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [streamingByThread, setStreamingByThread] = useState<Record<string, string>>({});
  const [executionStageByThread, setExecutionStageByThread] = useState<
    Record<string, ManagedExecutionStage>
  >({});
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [approvalFocus, setApprovalFocus] = useState<ApprovalFocusRequest | null>(null);
  const approvalSequence = useRef(0);
  const snapshotRef = useRef(snapshot);
  const messagesRef = useRef(messagesByThread);
  snapshotRef.current = snapshot;
  messagesRef.current = messagesByThread;

  const refresh = useCallback(async () => {
    try {
      const next = await desktopApi.getWorkspaceSnapshot();
      setSnapshot(next);
      setUi((current) => normalizeUi(current, next));
      setError(null);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return desktopApi.subscribeRunEvents((event) => {
      applyRunEvent(
        event,
        setSnapshot,
        setMessagesByThread,
        setStreamingByThread,
        setExecutionStageByThread,
      );
    });
  }, [refresh]);

  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    localStorage.setItem("scopeguard.ui.v3", JSON.stringify(ui));
  }, [ui]);

  const selectedWorkspace = useMemo(() =>
    snapshot?.workspaces.find((item) => item.id === ui.selectedWorkspaceId)
      ?? snapshot?.workspaces[0]
      ?? null,
  [snapshot, ui.selectedWorkspaceId]);
  const activeThread = useMemo(() =>
    snapshot?.conversations.find((item) => item.id === ui.activeConversationId)
      ?? null,
  [snapshot, ui.activeConversationId]);
  const activeAgent = useMemo(() =>
    snapshot?.agents.find((item) => item.id === activeThread?.agentId) ?? null,
  [activeThread?.agentId, snapshot?.agents]);

  const openThreads = useMemo(() => ui.openConversationIds.flatMap((id) => {
    const conversation = snapshot?.conversations.find((item) => item.id === id);
    return conversation ? [conversation] : [];
  }), [snapshot?.conversations, ui.openConversationIds]);
  const responsiveMaximum = maxPaneCount(windowWidth, ui.sidebarCollapsed);
  const maxSplitCount = Math.min(responsiveMaximum, Math.max(1, openThreads.length));
  const effectiveSplitCount = Math.min(ui.requestedSplitCount, maxSplitCount);
  const paneIds = normalizePaneIds(
    ui.paneConversationIds,
    ui.openConversationIds,
    effectiveSplitCount,
  );
  const visibleThreads = paneIds.flatMap((id) => {
    const conversation = snapshot?.conversations.find((item) => item.id === id);
    return conversation ? [conversation] : [];
  });
  const activePaneIndex = Math.max(
    0,
    paneIds.indexOf(ui.activeConversationId ?? ""),
  );

  useEffect(() => {
    for (const conversation of openThreads) {
      if (messagesByThread[conversation.id]) continue;
      void desktopApi.listConversationMessages(conversation.id)
        .then((messages) => setMessagesByThread((current) => ({
          ...current,
          [conversation.id]: mergeMessages(current[conversation.id] ?? [], messages),
        })))
        .catch((cause: unknown) => setError(messageFromError(cause)));
    }
  }, [messagesByThread, openThreads]);

  const selectProject = useCallback((workspaceId: string) => {
    setUi((current) => selectWorkspace(current, snapshotRef.current, workspaceId));
  }, []);

  const activateConversation = useCallback((conversationId: string, workspaceId: string) => {
    setUi((current) => {
      const openConversationIds = current.openConversationIds.includes(conversationId)
        ? current.openConversationIds
        : [...current.openConversationIds, conversationId];
      const paneConversationIds = assignToPane(
        normalizePaneIds(
          current.paneConversationIds,
          openConversationIds,
          current.requestedSplitCount,
        ),
        conversationId,
        Math.min(
          Math.max(0, current.paneConversationIds.indexOf(current.activeConversationId ?? "")),
          current.requestedSplitCount - 1,
        ),
      );
      return {
        ...current,
        selectedWorkspaceId: workspaceId,
        activeConversationId: conversationId,
        openConversationIds,
        paneConversationIds,
      };
    });
  }, []);

  const openThread = useCallback((conversationId: string) => {
    const conversation = snapshotRef.current?.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return;
    activateConversation(conversationId, conversation.workspaceId);
  }, [activateConversation]);

  const focusApproval = useCallback((conversationId: string, approvalId: string) => {
    openThread(conversationId);
    approvalSequence.current += 1;
    setApprovalFocus({ conversationId, approvalId, sequence: approvalSequence.current });
  }, [openThread]);

  const selectPane = useCallback((paneIndex: number) => {
    setUi((current) => {
      const panes = normalizePaneIds(
        current.paneConversationIds,
        current.openConversationIds,
        current.requestedSplitCount,
      );
      const conversationId = panes[paneIndex];
      return conversationId
        ? { ...current, activeConversationId: conversationId }
        : current;
    });
  }, []);

  const setRequestedSplitCount = useCallback((count: number) => {
    setUi((current) => {
      const requestedSplitCount = Math.max(1, Math.min(4, count));
      return {
        ...current,
        requestedSplitCount,
        paneConversationIds: normalizePaneIds(
          current.paneConversationIds,
          current.openConversationIds,
          requestedSplitCount,
        ),
      };
    });
  }, []);

  const setSidebarCollapsed = useCallback((value: boolean) => {
    setUi((current) => ({ ...current, sidebarCollapsed: value }));
  }, []);
  const setProfessionalMode = useCallback((value: boolean) => {
    setUi((current) => ({ ...current, professionalMode: value }));
  }, []);

  const createWorkspace = useCallback(async (name: string) => {
    const workspace = await desktopApi.createWorkspace({ name });
    await refresh();
    setUi((current) => selectWorkspace(current, snapshotRef.current, workspace.id));
    return workspace;
  }, [refresh]);

  const openLocalWorkspace = useCallback(async () => {
    const selection = await desktopApi.chooseWorkspaceDirectory();
    if (selection.canceled || !selection.localRootPath) return null;
    const name = selection.localRootPath.split(/[\\/]/).filter(Boolean).at(-1)
      ?? "Local workspace";
    const workspace = await desktopApi.createWorkspace({
      name,
      localRootPath: selection.localRootPath,
    });
    await refresh();
    setUi((current) => ({ ...current, selectedWorkspaceId: workspace.id }));
    return workspace;
  }, [refresh]);

  const saveProvider = useCallback(async (input: SaveProviderProfileRequest) => {
    const provider = await desktopApi.saveProviderProfile(input);
    await refresh();
    return provider;
  }, [refresh]);

  const testProvider = useCallback((input: SaveProviderProfileRequest) =>
    desktopApi.testProviderConnection(input), []);

  const createAgentConversation = useCallback(async (
    input: Omit<CreateAgentInput, "workspaceId">,
    title: string,
  ) => {
    const workspaceId = selectedWorkspace?.id;
    if (!workspaceId) throw new Error("请先选择工作区。");
    const agent = await desktopApi.createAgent({ ...input, workspaceId });
    const conversation = await desktopApi.createConversation({
      workspaceId,
      agentId: agent.id,
      title,
    });
    await refresh();
    activateConversation(conversation.id, conversation.workspaceId);
    return conversation;
  }, [activateConversation, refresh, selectedWorkspace?.id]);

  const createConversation = useCallback(async (agentId: string, title: string) => {
    const workspaceId = selectedWorkspace?.id;
    if (!workspaceId) throw new Error("请先选择工作区。");
    const conversation = await desktopApi.createConversation({ workspaceId, agentId, title });
    await refresh();
    activateConversation(conversation.id, conversation.workspaceId);
    return conversation;
  }, [activateConversation, refresh, selectedWorkspace?.id]);

  const updateConversationSettings = useCallback(async (
    input: UpdateConversationSettingsInput,
  ) => {
    const conversation = await desktopApi.updateConversationSettings(input);
    setSnapshot((current) => current ? {
      ...current,
      conversations: current.conversations.map((item) =>
        item.id === conversation.id ? conversation : item
      ),
    } : current);
    return conversation;
  }, []);

  const chooseWorkspaceFiles = useCallback(async () => {
    if (!selectedWorkspace) throw new Error("请先选择工作区。");
    return (await desktopApi.chooseWorkspaceFiles(selectedWorkspace.id)).files;
  }, [selectedWorkspace]);

  const sendMessage = useCallback(async (conversationId: string, prompt: string) => {
    const run = await desktopApi.startRun({ conversationId, prompt });
    setSnapshot((current) => current ? {
      ...current,
      activeRuns: [
        ...current.activeRuns.filter((item) => item.id !== run.id),
        run,
      ],
    } : current);
    return run;
  }, []);

  const cancelRun = useCallback(async (runId: string) => {
    await desktopApi.cancelRun(runId);
    await refresh();
  }, [refresh]);

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: ApprovalDecision,
  ) => {
    await desktopApi.resolveApproval(approvalId, decision);
    await refresh();
  }, [refresh]);

  const getRunForThread = useCallback((conversationId: string) =>
    snapshot?.activeRuns.find((run) => run.conversationId === conversationId) ?? null,
  [snapshot?.activeRuns]);
  const getLatestRunForThread = useCallback((conversationId: string) =>
    snapshot?.recentRuns.find((run) => run.conversationId === conversationId) ?? null,
  [snapshot?.recentRuns]);
  const retryThread = useCallback(async (conversationId: string) => {
    const prompt = [...(messagesRef.current[conversationId] ?? [])]
      .reverse()
      .find((message) => message.role === "user")?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!prompt) throw new Error("没有可重试的用户消息。");
    return sendMessage(conversationId, prompt);
  }, [sendMessage]);

  return {
    snapshot,
    loading,
    error,
    selectedProject: selectedWorkspace,
    selectedWorkspace,
    activeThread,
    activeAgent,
    visibleThreads,
    messagesByThread,
    streamingByThread,
    executionStageByThread,
    requestedSplitCount: ui.requestedSplitCount,
    effectiveSplitCount,
    maxSplitCount,
    activePaneIndex,
    sidebarCollapsed: ui.sidebarCollapsed,
    professionalMode: ui.professionalMode,
    approvalFocus,
    selectProject,
    openThread,
    focusApproval,
    selectPane,
    setRequestedSplitCount,
    setSidebarCollapsed,
    setProfessionalMode,
    refresh,
    createWorkspace,
    openLocalWorkspace,
    saveProvider,
    testProvider,
    createAgentConversation,
    createConversation,
    updateConversationSettings,
    chooseWorkspaceFiles,
    sendMessage,
    cancelRun,
    resolveApproval,
    getRunForThread,
    getLatestRunForThread,
    retryThread,
  };
}

function applyRunEvent(
  event: RunEvent,
  setSnapshot: React.Dispatch<React.SetStateAction<DesktopWorkspaceSnapshot | null>>,
  setMessages: React.Dispatch<React.SetStateAction<Record<string, ConversationMessage[]>>>,
  setStreaming: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  setExecutionStage: React.Dispatch<React.SetStateAction<Record<string, ManagedExecutionStage>>>,
): void {
  if (event.type === "assistant-delta") {
    setStreaming((current) => ({
      ...current,
      [event.conversationId]: (current[event.conversationId] ?? "") + event.delta,
    }));
    return;
  }
  if (event.type === "message-created") {
    setMessages((current) => ({
      ...current,
      [event.conversationId]: mergeMessages(
        current[event.conversationId] ?? [],
        [event.message],
      ),
    }));
    if (event.message.role === "assistant") {
      setStreaming((current) => ({ ...current, [event.conversationId]: "" }));
    }
    return;
  }
  if (event.type === "managed-execution") {
    setExecutionStage((current) => ({
      ...current,
      [event.conversationId]: event.progress.stage,
    }));
    return;
  }
  if (event.type === "approval-required") {
    setSnapshot((current) => current ? {
      ...current,
      pendingApprovals: [
        ...current.pendingApprovals.filter(
          (item) => item.approval.id !== event.approval.id,
        ),
        { approval: event.approval, toolCall: event.toolCall },
      ],
    } : current);
    return;
  }
  if (event.type !== "run-status") return;
  setSnapshot((current) => {
    if (!current) return current;
    const existing = [...current.activeRuns, ...current.recentRuns]
      .find((run) => run.id === event.runId);
    if (!existing) return current;
    const terminal = ["completed", "failed", "cancelled", "interrupted"]
      .includes(event.status);
    const updated: AgentRun = {
      ...existing,
      status: event.status,
      error: event.error ?? existing.error,
      completedAt: terminal ? event.at : existing.completedAt,
    };
    return {
      ...current,
      activeRuns: terminal
        ? current.activeRuns.filter((run) => run.id !== event.runId)
        : current.activeRuns.map((run) => run.id === event.runId ? updated : run),
      recentRuns: terminal
        ? [updated, ...current.recentRuns.filter((run) => run.id !== event.runId)]
        : current.recentRuns,
      pendingApprovals: terminal
        ? current.pendingApprovals.filter((item) => item.approval.runId !== event.runId)
        : current.pendingApprovals,
    };
  });
  if (["completed", "failed", "cancelled", "interrupted"].includes(event.status)) {
    setStreaming((current) => ({ ...current, [event.conversationId]: "" }));
  }
}

function normalizeUi(
  current: PersistedUiState,
  snapshot: DesktopWorkspaceSnapshot,
): PersistedUiState {
  const workspaceId = snapshot.workspaces.some(
    (item) => item.id === current.selectedWorkspaceId,
  ) ? current.selectedWorkspaceId : snapshot.workspaces[0]?.id ?? null;
  const conversations = snapshot.conversations.filter(
    (item) => item.workspaceId === workspaceId,
  );
  const validIds = new Set(conversations.map((item) => item.id));
  const openConversationIds = current.openConversationIds.filter((id) => validIds.has(id));
  if (openConversationIds.length === 0 && conversations[0]) {
    openConversationIds.push(conversations[0].id);
  }
  const activeConversationId = openConversationIds.includes(
    current.activeConversationId ?? "",
  ) ? current.activeConversationId : openConversationIds[0] ?? null;
  return {
    ...current,
    selectedWorkspaceId: workspaceId,
    activeConversationId,
    openConversationIds,
    paneConversationIds: normalizePaneIds(
      current.paneConversationIds,
      openConversationIds,
      current.requestedSplitCount,
    ),
  };
}

function selectWorkspace(
  current: PersistedUiState,
  snapshot: DesktopWorkspaceSnapshot | null,
  workspaceId: string,
): PersistedUiState {
  const conversations = snapshot?.conversations.filter(
    (item) => item.workspaceId === workspaceId,
  ) ?? [];
  const openConversationIds = conversations[0] ? [conversations[0].id] : [];
  return {
    ...current,
    selectedWorkspaceId: workspaceId,
    activeConversationId: openConversationIds[0] ?? null,
    openConversationIds,
    paneConversationIds: openConversationIds,
  };
}

function normalizePaneIds(
  paneIds: string[],
  openIds: string[],
  count: number,
): string[] {
  const target = Math.min(Math.max(1, count), Math.max(1, openIds.length));
  const unique = paneIds.filter(
    (id, index) => openIds.includes(id) && paneIds.indexOf(id) === index,
  );
  for (const id of openIds) {
    if (unique.length >= target) break;
    if (!unique.includes(id)) unique.push(id);
  }
  return unique.slice(0, target);
}

function assignToPane(panes: string[], conversationId: string, index: number): string[] {
  const next = panes.filter((id) => id !== conversationId);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, conversationId);
  return next;
}

function mergeMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function maxPaneCount(width: number, sidebarCollapsed: boolean): number {
  const available = width - (sidebarCollapsed ? 72 : 264);
  if (available >= 1680) return 4;
  if (available >= 1180) return 3;
  if (available >= 760) return 2;
  return 1;
}

function readUiState(): PersistedUiState {
  try {
    const parsed = JSON.parse(localStorage.getItem("scopeguard.ui.v3") ?? "null") as
      Partial<PersistedUiState> | null;
    if (!parsed) return DEFAULT_UI_STATE;
    return {
      ...DEFAULT_UI_STATE,
      ...parsed,
      openConversationIds: Array.isArray(parsed.openConversationIds)
        ? parsed.openConversationIds.filter((id): id is string => typeof id === "string")
        : [],
      paneConversationIds: Array.isArray(parsed.paneConversationIds)
        ? parsed.paneConversationIds.filter((id): id is string => typeof id === "string")
        : [],
      requestedSplitCount: Math.max(1, Math.min(4, parsed.requestedSplitCount ?? 1)),
    };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
