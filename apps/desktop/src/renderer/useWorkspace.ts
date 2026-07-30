import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentProfile,
  AgentRun,
  AgentThread,
  ApprovalDecision,
  ContextRevision,
  CreateAgentProfileInput,
  Project,
  ProviderConnectionResult,
  ProviderProfile,
  RunEvent,
  ThreadMessage,
  WorkspaceSnapshot,
} from "@scopeguard/domain";
import type {
  SaveProviderProfileRequest,
} from "@scopeguard/ipc-contracts";

import { desktopApi } from "./bridge.js";

type PersistedUiState = {
  selectedProjectId: string | null;
  activeThreadId: string | null;
  openThreadIds: string[];
  paneThreadIds: string[];
  activePaneIndex: number;
  requestedSplitCount: number;
  projectLayouts: Record<string, ProjectLayout>;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  professionalMode: boolean;
};

type ProjectLayout = {
  activeThreadId: string | null;
  openThreadIds: string[];
  paneThreadIds: string[];
  activePaneIndex: number;
  requestedSplitCount: number;
};

type ApprovalFocusRequest = {
  threadId: string;
  approvalId: string;
  sequence: number;
};

const DEFAULT_UI_STATE: PersistedUiState = {
  selectedProjectId: null,
  activeThreadId: null,
  openThreadIds: [],
  paneThreadIds: [],
  activePaneIndex: 0,
  requestedSplitCount: 1,
  projectLayouts: {},
  sidebarCollapsed: false,
  inspectorOpen: true,
  professionalMode: false,
};

export type WorkspaceController = {
  snapshot: WorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedProject: Project | null;
  activeThread: AgentThread | null;
  activeAgent: AgentProfile | null;
  activeContext: ContextRevision | null;
  openThreads: AgentThread[];
  visibleThreads: AgentThread[];
  messagesByThread: Record<string, ThreadMessage[]>;
  streamingByThread: Record<string, string>;
  requestedSplitCount: number;
  effectiveSplitCount: number;
  maxSplitCount: number;
  activePaneIndex: number;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  professionalMode: boolean;
  approvalFocus: ApprovalFocusRequest | null;
  selectProject: (projectId: string) => void;
  openThread: (threadId: string) => void;
  focusApproval: (threadId: string, approvalId: string) => void;
  closeThread: (threadId: string) => void;
  selectPane: (paneIndex: number) => void;
  setRequestedSplitCount: (count: number) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setInspectorOpen: (value: boolean) => void;
  setProfessionalMode: (value: boolean) => void;
  refresh: () => Promise<void>;
  addProject: () => Promise<Project | null>;
  saveProvider: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderProfile>;
  testProvider: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderConnectionResult>;
  createAgentThread: (
    profileInput: Omit<CreateAgentProfileInput, "projectId">,
    title: string,
  ) => Promise<AgentThread>;
  sendMessage: (threadId: string, prompt: string) => Promise<AgentRun>;
  cancelRun: (runId: string) => Promise<void>;
  resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  updateContext: (content: string) => Promise<ContextRevision>;
  getRunForThread: (threadId: string) => AgentRun | null;
  getLatestRunForThread: (threadId: string) => AgentRun | null;
  retryThread: (threadId: string) => Promise<AgentRun>;
};

export function useWorkspace(): WorkspaceController {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ui, setUi] = useState<PersistedUiState>(readUiState);
  const [messagesByThread, setMessagesByThread] = useState<
    Record<string, ThreadMessage[]>
  >({});
  const [streamingByThread, setStreamingByThread] = useState<
    Record<string, string>
  >({});
  const [contextsByProject, setContextsByProject] = useState<
    Record<string, ContextRevision | null>
  >({});
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [approvalFocus, setApprovalFocus] =
    useState<ApprovalFocusRequest | null>(null);
  const approvalFocusSequence = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const refresh = useCallback(async () => {
    try {
      const next = await desktopApi.getWorkspaceSnapshot();
      setSnapshot(next);
      setError(null);
      setUi((current) => normalizeUiState(current, next));
    } catch (refreshError) {
      setError(messageFromError(refreshError));
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
        void refresh();
      }
    });
  }, [refresh]);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "scopeguard.ui.v2",
      JSON.stringify({
        ...ui,
        projectLayouts: rememberCurrentProjectLayout(ui),
      }),
    );
  }, [ui]);

  const selectedProject = useMemo(
    () =>
      snapshot?.projects.find((project) => project.id === ui.selectedProjectId)
      ?? snapshot?.projects[0]
      ?? null,
    [snapshot, ui.selectedProjectId],
  );
  const activeThread = useMemo(
    () =>
      snapshot?.threads.find((thread) => thread.id === ui.activeThreadId) ?? null,
    [snapshot, ui.activeThreadId],
  );
  const activeAgent = useMemo(
    () =>
      snapshot?.agentProfiles.find(
        (profile) => profile.id === activeThread?.agentProfileId,
      ) ?? null,
    [snapshot, activeThread],
  );
  const openThreads = useMemo(
    () =>
      ui.openThreadIds.flatMap((threadId) => {
        const thread = snapshot?.threads.find((item) => item.id === threadId);
        return thread ? [thread] : [];
      }),
    [snapshot, ui.openThreadIds],
  );
  const effectiveSplitCount = Math.min(
    ui.requestedSplitCount,
    maxPaneCount(windowWidth, ui.sidebarCollapsed, ui.inspectorOpen),
    Math.max(1, openThreads.length),
  );
  const maxSplitCount = Math.min(
    maxPaneCount(windowWidth, ui.sidebarCollapsed, ui.inspectorOpen),
    Math.max(1, openThreads.length),
  );
  const logicalPaneThreadIds = useMemo(
    () => normalizePaneThreadIds(
      ui.paneThreadIds,
      ui.openThreadIds,
      Math.min(
        ui.requestedSplitCount,
        Math.max(1, ui.openThreadIds.length),
      ),
    ),
    [ui.openThreadIds, ui.paneThreadIds, ui.requestedSplitCount],
  );
  const visibleThreadIds = useMemo(
    () => selectVisiblePaneThreadIds(
      logicalPaneThreadIds,
      effectiveSplitCount,
      ui.activeThreadId,
    ),
    [
      effectiveSplitCount,
      logicalPaneThreadIds,
      ui.activeThreadId,
    ],
  );
  const visibleThreads = useMemo(() => {
    return visibleThreadIds.flatMap((threadId) => {
      const thread = snapshot?.threads.find((item) => item.id === threadId);
      return thread ? [thread] : [];
    });
  }, [snapshot?.threads, visibleThreadIds]);
  const visibleActivePaneIndex = visibleThreadIds.indexOf(
    ui.activeThreadId ?? "",
  );
  const activePaneIndex = visibleActivePaneIndex >= 0
    ? visibleActivePaneIndex
    : 0;
  const activeContext = selectedProject
    ? contextsByProject[selectedProject.id] ?? null
    : null;

  useEffect(() => {
    for (const thread of openThreads) {
      if (messagesByThread[thread.id]) {
        continue;
      }
      void desktopApi.listThreadMessages(thread.id)
        .then((messages) => {
          setMessagesByThread((current) => ({
            ...current,
            [thread.id]: mergeMessages(
              current[thread.id] ?? [],
              messages,
            ),
          }));
        })
        .catch((loadError: unknown) => setError(messageFromError(loadError)));
    }
  }, [messagesByThread, openThreads]);

  useEffect(() => {
    if (!selectedProject || selectedProject.id in contextsByProject) {
      return;
    }
    void desktopApi.getProjectContext(selectedProject.id)
      .then((context) => {
        setContextsByProject((current) => ({
          ...current,
          [selectedProject.id]: context,
        }));
      })
      .catch((loadError: unknown) => setError(messageFromError(loadError)));
  }, [contextsByProject, selectedProject]);

  const selectProject = useCallback((projectId: string) => {
    setUi((current) => {
      const projectLayouts = rememberCurrentProjectLayout(current);
      return {
        ...current,
        selectedProjectId: projectId,
        projectLayouts,
        ...threadSelectionForProject(
          snapshotRef.current,
          projectId,
          projectLayouts[projectId],
        ),
      };
    });
  }, []);

  const openThread = useCallback((threadId: string) => {
    const thread = snapshotRef.current?.threads.find((item) => item.id === threadId);
    if (!thread) {
      return;
    }
    setUi((current) => {
      const switchingProject = current.selectedProjectId !== thread.projectId;
      const projectLayouts = switchingProject
        ? rememberCurrentProjectLayout(current)
        : current.projectLayouts;
      const base = switchingProject
        ? threadSelectionForProject(
            snapshotRef.current,
            thread.projectId,
            projectLayouts[thread.projectId],
          )
        : current;
      const openThreadIds = base.openThreadIds.includes(threadId)
        ? base.openThreadIds
        : [...base.openThreadIds, threadId];
      const paneCount = Math.max(1, base.requestedSplitCount);
      const targetPaneIndex = Math.min(
        base.activePaneIndex,
        paneCount - 1,
      );
      const paneThreadIds = assignThreadToPane(
        normalizePaneThreadIds(base.paneThreadIds, openThreadIds, paneCount),
        threadId,
        targetPaneIndex,
      );
      return {
        ...current,
        selectedProjectId: thread.projectId,
        projectLayouts,
        activeThreadId: threadId,
        openThreadIds,
        paneThreadIds,
        activePaneIndex: targetPaneIndex,
        requestedSplitCount: base.requestedSplitCount,
      };
    });
  }, []);

  const focusApproval = useCallback((
    threadId: string,
    approvalId: string,
  ) => {
    openThread(threadId);
    if (window.innerWidth < 1440) {
      setUi((current) => current.inspectorOpen
        ? { ...current, inspectorOpen: false }
        : current);
    }
    approvalFocusSequence.current += 1;
    setApprovalFocus({
      threadId,
      approvalId,
      sequence: approvalFocusSequence.current,
    });
  }, [openThread]);

  const closeThread = useCallback((threadId: string) => {
    setUi((current) => {
      const nextOpen = current.openThreadIds.filter((id) => id !== threadId);
      const paneThreadIds = normalizePaneThreadIds(
        current.paneThreadIds.filter((id) => id !== threadId),
        nextOpen,
        Math.min(current.requestedSplitCount, Math.max(1, nextOpen.length)),
      );
      const activePaneIndex = Math.min(
        current.activePaneIndex,
        Math.max(0, paneThreadIds.length - 1),
      );
      const activeThreadId = current.activeThreadId === threadId
        ? paneThreadIds[activePaneIndex] ?? nextOpen.at(-1) ?? null
        : current.activeThreadId;
      return {
        ...current,
        activeThreadId,
        openThreadIds: nextOpen,
        paneThreadIds,
        activePaneIndex,
      };
    });
  }, []);

  const selectPane = useCallback((paneIndex: number) => {
    setUi((current) => {
      const effectiveCount = Math.min(
        current.requestedSplitCount,
        maxPaneCount(
          window.innerWidth,
          current.sidebarCollapsed,
          current.inspectorOpen,
        ),
        Math.max(1, current.openThreadIds.length),
      );
      const logicalPaneThreadIds = normalizePaneThreadIds(
        current.paneThreadIds,
        current.openThreadIds,
        Math.min(
          current.requestedSplitCount,
          Math.max(1, current.openThreadIds.length),
        ),
      );
      const visibleThreadIds = selectVisiblePaneThreadIds(
        logicalPaneThreadIds,
        effectiveCount,
        current.activeThreadId,
      );
      const activeThreadId =
        visibleThreadIds[Math.max(0, Math.min(
          paneIndex,
          visibleThreadIds.length - 1,
        ))] ?? current.activeThreadId;
      const activePaneIndex = activeThreadId
        ? Math.max(0, logicalPaneThreadIds.indexOf(activeThreadId))
        : 0;
      return {
        ...current,
        activePaneIndex,
        activeThreadId,
      };
    });
  }, []);

  const addProject = useCallback(async () => {
    try {
      const selection = await desktopApi.chooseProjectDirectory();
      if (selection.canceled || !selection.rootPath) {
        return null;
      }
      const project = await desktopApi.addProject({
        rootPath: selection.rootPath,
      });
      await refresh();
      setUi((current) => ({
        ...current,
        projectLayouts: rememberCurrentProjectLayout(current),
        selectedProjectId: project.id,
        activeThreadId: null,
        openThreadIds: [],
        paneThreadIds: [],
        activePaneIndex: 0,
        requestedSplitCount: 1,
      }));
      return project;
    } catch (projectError) {
      setError(messageFromError(projectError));
      throw projectError;
    }
  }, [refresh]);

  const saveProvider = useCallback(
    async (input: SaveProviderProfileRequest) => {
      const provider = await desktopApi.saveProviderProfile(input);
      await refresh();
      return provider;
    },
    [refresh],
  );

  const testProvider = useCallback(
    (input: SaveProviderProfileRequest) =>
      desktopApi.testProviderConnection(input),
    [],
  );

  const createAgentThread = useCallback(
    async (
      profileInput: Omit<CreateAgentProfileInput, "projectId">,
      title: string,
    ) => {
      if (!selectedProject) {
        throw new Error("Open a Project before creating an Agent.");
      }
      const profile = await desktopApi.createAgentProfile({
        ...profileInput,
        projectId: selectedProject.id,
      });
      const thread = await desktopApi.createThread({
        projectId: selectedProject.id,
        agentProfileId: profile.id,
        title,
      });
      await refresh();
      openThread(thread.id);
      return thread;
    },
    [openThread, refresh, selectedProject],
  );

  const sendMessage = useCallback(async (threadId: string, prompt: string) => {
    setStreamingByThread((current) => ({ ...current, [threadId]: "" }));
    const run = await desktopApi.startRun({ threadId, prompt });
    await refresh();
    return run;
  }, [refresh]);

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

  const updateContext = useCallback(async (content: string) => {
    if (!selectedProject) {
      throw new Error("No Project is selected.");
    }
    const revision = await desktopApi.updateProjectContext({
      projectId: selectedProject.id,
      content,
      sourceThreadId: activeThread?.projectId === selectedProject.id
        ? activeThread.id
        : undefined,
      sourceRunId: activeThread?.projectId === selectedProject.id
        ? snapshot?.activeRuns.find((run) => run.threadId === activeThread.id)?.id
        : undefined,
    });
    setContextsByProject((current) => ({
      ...current,
      [selectedProject.id]: revision,
    }));
    await refresh();
    return revision;
  }, [activeThread, refresh, selectedProject, snapshot?.activeRuns]);

  const getRunForThread = useCallback(
    (threadId: string) =>
      snapshot?.activeRuns.find((run) => run.threadId === threadId) ?? null,
    [snapshot?.activeRuns],
  );

  const getLatestRunForThread = useCallback(
    (threadId: string) =>
      snapshot?.recentRuns.find((run) => run.threadId === threadId) ?? null,
    [snapshot?.recentRuns],
  );

  const retryThread = useCallback(async (threadId: string) => {
    const knownMessages = messagesByThread[threadId]
      ?? await desktopApi.listThreadMessages(threadId);
    const trigger = [...knownMessages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt = trigger?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!prompt) {
      throw new Error("The original task is unavailable for retry.");
    }
    return sendMessage(threadId, prompt);
  }, [messagesByThread, sendMessage]);

  return {
    snapshot,
    loading,
    error,
    selectedProject,
    activeThread,
    activeAgent,
    activeContext,
    openThreads,
    visibleThreads,
    messagesByThread,
    streamingByThread,
    requestedSplitCount: ui.requestedSplitCount,
    effectiveSplitCount,
    maxSplitCount,
    activePaneIndex,
    sidebarCollapsed: ui.sidebarCollapsed,
    inspectorOpen: ui.inspectorOpen,
    professionalMode: ui.professionalMode,
    approvalFocus,
    selectProject,
    openThread,
    focusApproval,
    closeThread,
    selectPane,
    setRequestedSplitCount: (requestedSplitCount) =>
      setUi((current) => {
        const nextCount = Math.max(
          1,
          Math.min(
            4,
            requestedSplitCount,
            maxPaneCount(
              window.innerWidth,
              current.sidebarCollapsed,
              current.inspectorOpen,
            ),
            Math.max(1, current.openThreadIds.length),
          ),
        );
        const paneThreadIds = normalizePaneThreadIds(
          current.paneThreadIds,
          current.openThreadIds,
          nextCount,
        );
        const activePaneIndex = Math.min(
          current.activePaneIndex,
          nextCount - 1,
        );
        return {
          ...current,
          requestedSplitCount: nextCount,
          paneThreadIds,
          activePaneIndex,
          activeThreadId:
            paneThreadIds[activePaneIndex] ?? current.activeThreadId,
        };
      }),
    setSidebarCollapsed: (sidebarCollapsed) =>
      setUi((current) => ({ ...current, sidebarCollapsed })),
    setInspectorOpen: (inspectorOpen) =>
      setUi((current) => ({ ...current, inspectorOpen })),
    setProfessionalMode: (professionalMode) =>
      setUi((current) => ({ ...current, professionalMode })),
    refresh,
    addProject,
    saveProvider,
    testProvider,
    createAgentThread,
    sendMessage,
    cancelRun,
    resolveApproval,
    updateContext,
    getRunForThread,
    getLatestRunForThread,
    retryThread,
  };
}

function applyRunEvent(
  event: RunEvent,
  setSnapshot: React.Dispatch<React.SetStateAction<WorkspaceSnapshot | null>>,
  setMessages: React.Dispatch<
    React.SetStateAction<Record<string, ThreadMessage[]>>
  >,
  setStreaming: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): void {
  if (event.type === "assistant-delta") {
    setStreaming((current) => ({
      ...current,
      [event.threadId]: `${current[event.threadId] ?? ""}${event.delta}`,
    }));
    return;
  }
  if (event.type === "message-created") {
    setMessages((current) => {
      const existing = current[event.threadId] ?? [];
      return {
        ...current,
        [event.threadId]: existing.some((message) => message.id === event.message.id)
          ? existing
          : [...existing, event.message],
      };
    });
    if (event.message.role === "assistant") {
      setStreaming((current) => ({ ...current, [event.threadId]: "" }));
    }
    return;
  }
  if (event.type === "run-status") {
    const terminal = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(event.status);
    if (terminal) {
      setStreaming((current) => ({ ...current, [event.threadId]: "" }));
    }
    setSnapshot((current) => {
      if (!current) {
        return current;
      }
      const existing = current.activeRuns.find((run) => run.id === event.runId);
      return {
        ...current,
        activeRuns: terminal
          ? current.activeRuns.filter((run) => run.id !== event.runId)
          : existing
            ? current.activeRuns.map((run) =>
                run.id === event.runId
                  ? { ...run, status: event.status, error: event.error ?? null }
                  : run,
              )
            : current.activeRuns,
      };
    });
    return;
  }
  if (event.type === "approval-required") {
    setSnapshot((current) => current
      ? {
          ...current,
          pendingApprovals: [
            ...current.pendingApprovals.filter(
              (item) => item.approval.id !== event.approval.id,
            ),
            { approval: event.approval, toolCall: event.toolCall },
          ],
        }
      : current);
  }
}

function normalizeUiState(
  current: PersistedUiState,
  snapshot: WorkspaceSnapshot,
): PersistedUiState {
  const projectIds = new Set(snapshot.projects.map((project) => project.id));
  const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
  const selectedProjectId = current.selectedProjectId &&
    projectIds.has(current.selectedProjectId)
    ? current.selectedProjectId
    : snapshot.projects[0]?.id ?? null;
  const savedLayout = selectedProjectId
    ? current.projectLayouts[selectedProjectId]
    : undefined;
  const sourceLayout = current.selectedProjectId === selectedProjectId
    ? current
    : savedLayout ?? current;
  let openThreadIds = sourceLayout.openThreadIds.filter((id) =>
    threadIds.has(id)
  );
  openThreadIds = openThreadIds.filter((id) =>
    snapshot.threads.some(
      (thread) => thread.id === id && thread.projectId === selectedProjectId,
    ),
  );
  if (openThreadIds.length === 0 && selectedProjectId) {
    const firstThread = snapshot.threads.find(
      (thread) => thread.projectId === selectedProjectId,
    );
    openThreadIds = firstThread ? [firstThread.id] : [];
  }
  const requestedSplitCount = Math.max(
    1,
    Math.min(4, sourceLayout.requestedSplitCount),
  );
  const paneThreadIds = normalizePaneThreadIds(
    sourceLayout.paneThreadIds,
    openThreadIds,
    requestedSplitCount,
  );
  const activePaneIndex = Math.min(
    Math.max(0, sourceLayout.activePaneIndex),
    Math.max(0, paneThreadIds.length - 1),
  );
  const activeThreadId = sourceLayout.activeThreadId &&
    openThreadIds.includes(sourceLayout.activeThreadId)
    ? sourceLayout.activeThreadId
    : paneThreadIds[activePaneIndex] ?? openThreadIds[0] ?? null;
  return {
    ...current,
    selectedProjectId,
    activeThreadId,
    openThreadIds,
    paneThreadIds,
    activePaneIndex,
    requestedSplitCount,
  };
}

function threadSelectionForProject(
  snapshot: WorkspaceSnapshot | null,
  projectId: string,
  savedLayout?: ProjectLayout,
): ProjectLayout {
  if (!snapshot) {
    return {
      activeThreadId: null,
      openThreadIds: [],
      paneThreadIds: [],
      activePaneIndex: 0,
      requestedSplitCount: 1,
    };
  }
  const projectThreadIds = new Set(
    snapshot.threads
      .filter((thread) => thread.projectId === projectId)
      .map((thread) => thread.id),
  );
  const openThreadIds = (savedLayout?.openThreadIds ?? []).filter((id) =>
    projectThreadIds.has(id),
  );
  if (openThreadIds.length === 0) {
    const firstThreadId = projectThreadIds.values().next().value as
      | string
      | undefined;
    if (firstThreadId) {
      openThreadIds.push(firstThreadId);
    }
  }
  const requestedSplitCount = Math.max(
    1,
    Math.min(4, savedLayout?.requestedSplitCount ?? 1),
  );
  const paneThreadIds = normalizePaneThreadIds(
    savedLayout?.paneThreadIds ?? [],
    openThreadIds,
    requestedSplitCount,
  );
  const activePaneIndex = Math.min(
    Math.max(0, savedLayout?.activePaneIndex ?? 0),
    Math.max(0, paneThreadIds.length - 1),
  );
  return {
    activeThreadId:
      savedLayout?.activeThreadId &&
      openThreadIds.includes(savedLayout.activeThreadId)
        ? savedLayout.activeThreadId
        : paneThreadIds[activePaneIndex] ?? openThreadIds[0] ?? null,
    openThreadIds,
    paneThreadIds,
    activePaneIndex,
    requestedSplitCount,
  };
}

function rememberCurrentProjectLayout(
  current: PersistedUiState,
): Record<string, ProjectLayout> {
  if (!current.selectedProjectId) {
    return current.projectLayouts;
  }
  return {
    ...current.projectLayouts,
    [current.selectedProjectId]: {
      activeThreadId: current.activeThreadId,
      openThreadIds: current.openThreadIds,
      paneThreadIds: current.paneThreadIds,
      activePaneIndex: current.activePaneIndex,
      requestedSplitCount: current.requestedSplitCount,
    },
  };
}

function normalizePaneThreadIds(
  paneThreadIds: string[],
  openThreadIds: string[],
  count: number,
): string[] {
  const open = new Set(openThreadIds);
  const normalized = paneThreadIds.filter(
    (id, index) => open.has(id) && paneThreadIds.indexOf(id) === index,
  );
  for (const threadId of openThreadIds) {
    if (normalized.length >= count) {
      break;
    }
    if (!normalized.includes(threadId)) {
      normalized.push(threadId);
    }
  }
  return normalized.slice(0, count);
}

function selectVisiblePaneThreadIds(
  paneThreadIds: string[],
  count: number,
  activeThreadId: string | null,
): string[] {
  const boundedCount = Math.max(1, count);
  if (paneThreadIds.length <= boundedCount) {
    return paneThreadIds;
  }
  const activeIndex = activeThreadId
    ? paneThreadIds.indexOf(activeThreadId)
    : -1;
  if (activeIndex < 0 || activeIndex < boundedCount) {
    return paneThreadIds.slice(0, boundedCount);
  }
  const start = Math.min(
    activeIndex - boundedCount + 1,
    paneThreadIds.length - boundedCount,
  );
  return paneThreadIds.slice(start, start + boundedCount);
}

function assignThreadToPane(
  paneThreadIds: string[],
  threadId: string,
  paneIndex: number,
): string[] {
  const next = [...paneThreadIds];
  const existingIndex = next.indexOf(threadId);
  if (existingIndex === paneIndex) {
    return next;
  }
  if (existingIndex >= 0) {
    const replacedThreadId = next[paneIndex];
    if (replacedThreadId) {
      next[existingIndex] = replacedThreadId;
    } else {
      next.splice(existingIndex, 1);
    }
  }
  next[paneIndex] = threadId;
  return next;
}

function mergeMessages(
  first: ThreadMessage[],
  second: ThreadMessage[],
): ThreadMessage[] {
  const messages = new Map(
    [...first, ...second].map((message) => [message.id, message]),
  );
  return [...messages.values()].sort((left, right) =>
    left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt),
  );
}

function readUiState(): PersistedUiState {
  try {
    const value = localStorage.getItem("scopeguard.ui.v2");
    if (!value) {
      return DEFAULT_UI_STATE;
    }
    const parsed = JSON.parse(value) as Partial<PersistedUiState>;
    return {
      ...DEFAULT_UI_STATE,
      ...parsed,
      openThreadIds: Array.isArray(parsed.openThreadIds)
        ? parsed.openThreadIds.filter((id): id is string => typeof id === "string")
        : [],
      paneThreadIds: Array.isArray(parsed.paneThreadIds)
        ? parsed.paneThreadIds.filter((id): id is string => typeof id === "string")
        : [],
      activePaneIndex: typeof parsed.activePaneIndex === "number"
        ? parsed.activePaneIndex
        : 0,
      projectLayouts: readProjectLayouts(parsed.projectLayouts),
    };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

function readProjectLayouts(value: unknown): Record<string, ProjectLayout> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const layouts: Record<string, ProjectLayout> = {};
  for (const [projectId, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const layout = candidate as Partial<ProjectLayout>;
    layouts[projectId] = {
      activeThreadId:
        typeof layout.activeThreadId === "string" ? layout.activeThreadId : null,
      openThreadIds: Array.isArray(layout.openThreadIds)
        ? layout.openThreadIds.filter((id): id is string => typeof id === "string")
        : [],
      paneThreadIds: Array.isArray(layout.paneThreadIds)
        ? layout.paneThreadIds.filter((id): id is string => typeof id === "string")
        : [],
      activePaneIndex:
        typeof layout.activePaneIndex === "number" ? layout.activePaneIndex : 0,
      requestedSplitCount:
        typeof layout.requestedSplitCount === "number"
          ? layout.requestedSplitCount
          : 1,
    };
  }
  return layouts;
}

function maxPaneCount(
  width: number,
  sidebarCollapsed: boolean,
  inspectorOpen: boolean,
): number {
  const viewportLimit = width >= 1920
    ? 4
    : width >= 1600
      ? 3
      : width >= 1200
        ? 2
        : 1;
  const sidebarWidth = sidebarCollapsed
    ? 52
    : width < 1440
      ? 220
      : 252;
  const inspectorWidth = inspectorOpen && width >= 1440 ? 320 : 0;
  const workbenchWidth =
    width - sidebarWidth - inspectorWidth;
  let availableWidthLimit = 1;
  if (workbenchWidth >= 1600) {
    availableWidthLimit = 4;
  } else if (workbenchWidth >= 1200) {
    availableWidthLimit = 3;
  } else if (workbenchWidth >= 860) {
    availableWidthLimit = 2;
  }
  return Math.min(viewportLimit, availableWidthLimit);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
