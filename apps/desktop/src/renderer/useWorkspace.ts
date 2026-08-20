import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  activateConversationInLayout,
  closeConversationInLayout,
  createWorkspaceLayout,
  parseWorkspaceLayout,
  resizeWorkspacePanePair,
  setWorkspacePaneCount,
} from "@scopeguard/domain";
import type {
  Agent,
  AgentRun,
  ApprovalDecision,
  Conversation,
  ConversationMessage,
  Dispatch,
  HandoffPrompt,
  CreateAgentInput,
  ProviderConnectionResult,
  RunEvent,
  UpdateConversationSettingsInput,
  Workspace,
  WorkspaceLayout,
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
  paneWidths: number[];
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
  paneWidths: [],
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
  requestedSplitCount: number;
  effectiveSplitCount: number;
  maxSplitCount: number;
  paneWidths: number[];
  activePaneIndex: number;
  sidebarCollapsed: boolean;
  professionalMode: boolean;
  approvalFocus: ApprovalFocusRequest | null;
  selectProject: (workspaceId: string) => void;
  openThread: (conversationId: string) => void;
  focusApproval: (conversationId: string, approvalId: string) => void;
  selectPane: (paneIndex: number) => void;
  setRequestedSplitCount: (count: number) => void;
  resizePane: (dividerIndex: number, deltaPixels: number) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setProfessionalMode: (value: boolean) => void;
  refresh: () => Promise<DesktopWorkspaceSnapshot | null>;
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
  closePane: (conversationId: string) => void;
  generateHandoffPrompt: (
    sourceConversationId: string,
    targetConversationId: string,
    workRequest: string,
  ) => Promise<HandoffPrompt>;
  copyHandoffPrompt: (text: string) => Promise<void>;
  dispatchPrompt: (
    sourceConversationId: string,
    targetConversationId: string,
    prompt: string,
  ) => Promise<Dispatch>;
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
  const [approvalFocus, setApprovalFocus] = useState<ApprovalFocusRequest | null>(null);
  const approvalSequence = useRef(0);
  const snapshotRef = useRef(snapshot);
  const uiRef = useRef(ui);
  const messagesRef = useRef(messagesByThread);
  snapshotRef.current = snapshot;
  uiRef.current = ui;
  messagesRef.current = messagesByThread;

  const refresh = useCallback(async () => {
    try {
      const next = await desktopApi.getWorkspaceSnapshot();
      const normalized = normalizeUi(uiRef.current, next);
      snapshotRef.current = next;
      uiRef.current = normalized;
      setSnapshot(next);
      setUi(normalized);
      setError(null);
      return next;
    } catch (cause) {
      setError(messageFromError(cause));
      return null;
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
      );
      if (
        event.type === "run-status" &&
        ["completed", "failed", "cancelled", "interrupted"].includes(event.status)
      ) {
        window.setTimeout(() => void refresh(), 60);
      }
    });
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem("scopeguard.ui.v3", JSON.stringify({
      selectedWorkspaceId: ui.selectedWorkspaceId,
      sidebarCollapsed: ui.sidebarCollapsed,
      professionalMode: ui.professionalMode,
    }));
  }, [ui.professionalMode, ui.selectedWorkspaceId, ui.sidebarCollapsed]);

  const mutateLayout = useCallback((
    update: (current: PersistedUiState) => PersistedUiState,
  ) => {
    try {
      const next = update(uiRef.current);
      const layout = layoutFromUi(next, snapshotRef.current);
      const normalized = applyLayoutToUi(next, layout);
      uiRef.current = normalized;
      setUi(normalized);
      void desktopApi.stageWorkspaceLayout(layout).catch((cause: unknown) => {
        setError(messageFromError(cause));
      });
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }, []);

  const selectedWorkspace = useMemo(() =>
    snapshot?.workspaces.find((item) => item.id === ui.selectedWorkspaceId)
      ?? snapshot?.workspaces[0]
      ?? null,
  [snapshot, ui.selectedWorkspaceId]);
  const activeThread = useMemo(() =>
    snapshot?.conversations.find((item) =>
      item.id === ui.activeConversationId && item.workspaceId === selectedWorkspace?.id
    )
      ?? null,
  [selectedWorkspace?.id, snapshot, ui.activeConversationId]);
  const activeAgent = useMemo(() =>
    snapshot?.agents.find((item) => item.id === activeThread?.agentId) ?? null,
  [activeThread?.agentId, snapshot?.agents]);

  const openThreads = useMemo(() => ui.openConversationIds.flatMap((id) => {
    const conversation = snapshot?.conversations.find((item) =>
      item.id === id && item.workspaceId === selectedWorkspace?.id
    );
    return conversation ? [conversation] : [];
  }), [selectedWorkspace?.id, snapshot?.conversations, ui.openConversationIds]);
  const maxSplitCount = Math.min(4, Math.max(1, openThreads.length));
  const effectiveSplitCount = ui.paneConversationIds.length;
  const paneIds = ui.paneConversationIds;
  const visibleThreads = paneIds.flatMap((id) => {
    const conversation = snapshot?.conversations.find((item) =>
      item.id === id && item.workspaceId === selectedWorkspace?.id
    );
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

  const transitionWorkspace = useCallback(async (workspaceId: string) => {
    const currentWorkspaceId = uiRef.current.selectedWorkspaceId;
    if (currentWorkspaceId) await desktopApi.flushWorkspaceLayouts();
    const nextSnapshot = await desktopApi.getWorkspaceSnapshot();
    const nextUi = selectWorkspace(uiRef.current, nextSnapshot, workspaceId);
    snapshotRef.current = nextSnapshot;
    uiRef.current = nextUi;
    setSnapshot(nextSnapshot);
    setUi(nextUi);
    await desktopApi.stageWorkspaceLayout(layoutFromUi(nextUi, nextSnapshot));
    setError(null);
  }, []);

  const selectProject = useCallback((workspaceId: string) => {
    void transitionWorkspace(workspaceId).catch((cause: unknown) => {
      setError(messageFromError(cause));
    });
  }, [transitionWorkspace]);

  const activateConversation = useCallback((conversationId: string, workspaceId: string) => {
    mutateLayout((current) => {
      if (current.selectedWorkspaceId !== workspaceId) {
        throw new Error("Conversation cannot be opened outside the selected Workspace.");
      }
      const next = activateConversationInLayout(
        layoutFromUi(current, snapshotRef.current),
        conversationId,
      );
      return applyLayoutToUi(current, next);
    });
  }, [mutateLayout]);

  const openThread = useCallback((conversationId: string) => {
    const conversation = snapshotRef.current?.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return;
    if (uiRef.current.selectedWorkspaceId === conversation.workspaceId) {
      activateConversation(conversationId, conversation.workspaceId);
      return;
    }
    void transitionWorkspace(conversation.workspaceId)
      .then(() => activateConversation(conversationId, conversation.workspaceId))
      .catch((cause: unknown) => setError(messageFromError(cause)));
  }, [activateConversation, transitionWorkspace]);

  const focusApproval = useCallback((conversationId: string, approvalId: string) => {
    openThread(conversationId);
    approvalSequence.current += 1;
    setApprovalFocus({ conversationId, approvalId, sequence: approvalSequence.current });
  }, [openThread]);

  const selectPane = useCallback((paneIndex: number) => {
    mutateLayout((current) => {
      const layout = layoutFromUi(current, snapshotRef.current);
      const conversationId = layout.paneConversationIds[paneIndex];
      return conversationId
        ? { ...current, activeConversationId: conversationId }
        : current;
    });
  }, [mutateLayout]);

  const setRequestedSplitCount = useCallback((count: number) => {
    mutateLayout((current) => {
      const next = setWorkspacePaneCount(
        layoutFromUi(current, snapshotRef.current),
        count,
      );
      return applyLayoutToUi(current, next);
    });
  }, [mutateLayout]);

  const resizePane = useCallback((dividerIndex: number, deltaPixels: number) => {
    mutateLayout((current) => applyLayoutToUi(
      current,
      resizeWorkspacePanePair(
        layoutFromUi(current, snapshotRef.current),
        dividerIndex,
        deltaPixels,
      ),
    ));
  }, [mutateLayout]);

  const setSidebarCollapsed = useCallback((value: boolean) => {
    const next = { ...uiRef.current, sidebarCollapsed: value };
    uiRef.current = next;
    setUi(next);
  }, []);
  const setProfessionalMode = useCallback((value: boolean) => {
    const next = { ...uiRef.current, professionalMode: value };
    uiRef.current = next;
    setUi(next);
  }, []);

  const closePane = useCallback((conversationId: string) => {
    mutateLayout((current) => applyLayoutToUi(
      current,
      closeConversationInLayout(
        layoutFromUi(current, snapshotRef.current),
        conversationId,
      ),
    ));
  }, [mutateLayout]);

  const createWorkspace = useCallback(async (name: string) => {
    const workspace = await desktopApi.createWorkspace({ name });
    await transitionWorkspace(workspace.id);
    return workspace;
  }, [transitionWorkspace]);

  const openLocalWorkspace = useCallback(async () => {
    const selection = await desktopApi.chooseWorkspaceDirectory();
    if (selection.canceled || !selection.localRootPath) return null;
    const name = selection.localRootPath.split(/[\\/]/).filter(Boolean).at(-1)
      ?? "Local workspace";
    const workspace = await desktopApi.createWorkspace({
      name,
      localRootPath: selection.localRootPath,
    });
    await transitionWorkspace(workspace.id);
    return workspace;
  }, [transitionWorkspace]);

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

  const generateHandoffPrompt = useCallback((
    sourceConversationId: string,
    targetConversationId: string,
    workRequest: string,
  ) => {
    const workspaceId = snapshotRef.current?.conversations.find(
      ({ id }) => id === sourceConversationId,
    )?.workspaceId;
    if (!workspaceId) throw new Error("来源 Conversation 不存在。");
    return desktopApi.generateHandoffPrompt({
      workspaceId,
      sourceConversationId,
      targetConversationId,
      workRequest,
    });
  }, []);

  const copyHandoffPrompt = useCallback((text: string) => {
    return desktopApi.copyHandoffPrompt(text);
  }, []);

  const dispatchPrompt = useCallback(async (
    sourceConversationId: string,
    targetConversationId: string,
    prompt: string,
  ) => {
    const workspaceId = snapshotRef.current?.conversations.find(
      ({ id }) => id === sourceConversationId,
    )?.workspaceId;
    if (!workspaceId) throw new Error("来源 Conversation 不存在。");
    const created = await desktopApi.createDispatch({
      workspaceId,
      sourceConversationId,
      targetConversationId,
      prompt,
      sourceRunId: [
        ...(snapshotRef.current?.activeRuns ?? []),
        ...(snapshotRef.current?.recentRuns ?? []),
      ].find(({ conversationId }) => conversationId === sourceConversationId)?.id ?? null,
    });
    const result = await desktopApi.executeDispatch(created.id);
    setSnapshot((current) => current ? {
      ...current,
      dispatches: [
        result,
        ...current.dispatches.filter(({ id }) => id !== result.id),
      ],
      activeRuns: result.targetRunId
        ? [
            ...current.activeRuns,
            ...current.recentRuns.filter(({ id }) => id === result.targetRunId),
          ].filter((run, index, values) =>
            values.findIndex(({ id }) => id === run.id) === index &&
            !["completed", "failed", "cancelled", "interrupted"].includes(run.status)
          )
        : current.activeRuns,
    } : current);
    if (result.targetRunId) await refresh();
    return result;
  }, [refresh]);

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
    requestedSplitCount: ui.requestedSplitCount,
    effectiveSplitCount,
    maxSplitCount,
    paneWidths: ui.paneWidths,
    activePaneIndex,
    sidebarCollapsed: ui.sidebarCollapsed,
    professionalMode: ui.professionalMode,
    approvalFocus,
    selectProject,
    openThread,
    focusApproval,
    selectPane,
    setRequestedSplitCount,
    resizePane,
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
    closePane,
    generateHandoffPrompt,
    copyHandoffPrompt,
    dispatchPrompt,
  };
}

function applyRunEvent(
  event: RunEvent,
  setSnapshot: React.Dispatch<React.SetStateAction<DesktopWorkspaceSnapshot | null>>,
  setMessages: React.Dispatch<React.SetStateAction<Record<string, ConversationMessage[]>>>,
  setStreaming: React.Dispatch<React.SetStateAction<Record<string, string>>>,
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
  if (!workspaceId) return {
    ...DEFAULT_UI_STATE,
    sidebarCollapsed: current.sidebarCollapsed,
    professionalMode: current.professionalMode,
  };
  if (current.selectedWorkspaceId === workspaceId && current.openConversationIds.length > 0) {
    return applyLayoutToUi(current, layoutFromUi(current, snapshot));
  }
  return selectWorkspace(current, snapshot, workspaceId);
}

function selectWorkspace(
  current: PersistedUiState,
  snapshot: DesktopWorkspaceSnapshot | null,
  workspaceId: string,
): PersistedUiState {
  if (!snapshot?.workspaces.some(({ id }) => id === workspaceId)) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  const conversations = snapshot.conversations.filter(
    (item) => item.workspaceId === workspaceId,
  );
  const persisted = snapshot.layouts.find((item) => item.workspaceId === workspaceId);
  return applyLayoutToUi(current, createWorkspaceLayout(
    workspaceId,
    conversations.map(({ id }) => id),
    persisted,
  ));
}

function layoutFromUi(
  ui: PersistedUiState,
  snapshot: DesktopWorkspaceSnapshot | null,
): WorkspaceLayout {
  const workspaceId = ui.selectedWorkspaceId;
  if (!workspaceId || !snapshot?.workspaces.some(({ id }) => id === workspaceId)) {
    throw new Error("Selected Workspace is unavailable.");
  }
  const conversationIds = new Set(snapshot.conversations
    .filter((conversation) => conversation.workspaceId === workspaceId)
    .map(({ id }) => id));
  return parseWorkspaceLayout({
    workspaceId,
    openConversationIds: ui.openConversationIds,
    paneConversationIds: ui.paneConversationIds,
    paneWidths: ui.paneWidths,
    activeConversationId: ui.activeConversationId,
    requestedPaneCount: ui.requestedSplitCount,
  }, conversationIds);
}

function applyLayoutToUi(
  current: PersistedUiState,
  layout: WorkspaceLayout,
): PersistedUiState {
  return {
    ...current,
    selectedWorkspaceId: layout.workspaceId,
    activeConversationId: layout.activeConversationId,
    openConversationIds: layout.openConversationIds,
    paneConversationIds: layout.paneConversationIds,
    paneWidths: layout.paneWidths,
    requestedSplitCount: layout.requestedPaneCount,
  };
}

function mergeMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function readUiState(): PersistedUiState {
  try {
    const parsed = JSON.parse(localStorage.getItem("scopeguard.ui.v3") ?? "null") as
      Partial<PersistedUiState> | null;
    if (!parsed) return DEFAULT_UI_STATE;
    return {
      ...DEFAULT_UI_STATE,
      selectedWorkspaceId: typeof parsed.selectedWorkspaceId === "string"
        ? parsed.selectedWorkspaceId
        : null,
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      professionalMode: parsed.professionalMode === true,
    };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
