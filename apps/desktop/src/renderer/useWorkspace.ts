import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentDefinition,
  AgentHandoff,
  AgentInstance,
  AgentProfile,
  AgentRun,
  AgentThread,
  ApprovalDecision,
  ContextRevision,
  CreateAgentProfileInput,
  ManagedExecutionStage,
  Project,
  ProviderConnectionResult,
  RuntimeConnectionResult,
  RuntimeNode,
  SaveRuntimeNodeInput,
  RunEvent,
  ThreadMessage,
  Workspace,
  WorkspaceTask,
} from "@scopeguard/domain";
import type {
  DesktopWorkspaceSnapshot,
  ProviderProfileView,
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
  snapshot: DesktopWorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedProject: Project | null;
  selectedWorkspace: Workspace | null;
  activeThread: AgentThread | null;
  activeAgent: AgentProfile | null;
  activeTask: WorkspaceTask | null;
  activeAgentInstance: AgentInstance | null;
  activeAgentDefinition: AgentDefinition | null;
  activeContext: ContextRevision | null;
  visibleThreads: AgentThread[];
  messagesByThread: Record<string, ThreadMessage[]>;
  streamingByThread: Record<string, string>;
  executionStageByThread: Record<string, ManagedExecutionStage>;
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
  selectPane: (paneIndex: number) => void;
  setRequestedSplitCount: (count: number) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setInspectorOpen: (value: boolean) => void;
  setProfessionalMode: (value: boolean) => void;
  refresh: () => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  addProject: () => Promise<Project | null>;
  saveProvider: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderProfileView>;
  testProvider: (
    input: SaveProviderProfileRequest,
  ) => Promise<ProviderConnectionResult>;
  saveRuntime: (input: SaveRuntimeNodeInput) => Promise<RuntimeNode>;
  testRuntime: (runtimeNodeId: string) => Promise<RuntimeConnectionResult>;
  updateAgentRuntime: (
    agentInstanceId: string,
    runtimeNodeId: string,
  ) => Promise<AgentInstance>;
  createAgentThread: (
    profileInput: Omit<CreateAgentProfileInput, "projectId">,
    title: string,
  ) => Promise<AgentThread>;
  createTaskThread: (agentInstanceId: string, title: string) => Promise<AgentThread>;
  sendMessage: (threadId: string, prompt: string) => Promise<AgentRun>;
  cancelRun: (runId: string) => Promise<void>;
  resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  resolveInboxItem: (inboxItemId: string) => Promise<void>;
  updateContext: (content: string) => Promise<ContextRevision>;
  publishArtifactToContext: (artifactId: string) => Promise<ContextRevision>;
  createHandoff: (
    toAgentInstanceId: string,
    summary: string,
  ) => Promise<AgentHandoff>;
  getRunForThread: (threadId: string) => AgentRun | null;
  getLatestRunForThread: (threadId: string) => AgentRun | null;
  retryThread: (threadId: string) => Promise<AgentRun>;
};

export function useWorkspace(): WorkspaceController {
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ui, setUi] = useState<PersistedUiState>(readUiState);
  const [messagesByThread, setMessagesByThread] = useState<
    Record<string, ThreadMessage[]>
  >({});
  const [streamingByThread, setStreamingByThread] = useState<
    Record<string, string>
  >({});
  const [executionStageByThread, setExecutionStageByThread] = useState<
    Record<string, ManagedExecutionStage>
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
        setExecutionStageByThread,
      );
      if (
        event.type === "run-status" &&
        [
          "waiting-input",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(event.status)
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
  const selectedWorkspace = useMemo(
    () =>
      snapshot?.workspaces.find(
        (workspace) => workspace.id === (ui.selectedProjectId ?? selectedProject?.id),
      )
      ?? snapshot?.workspaces[0]
      ?? null,
    [selectedProject?.id, snapshot?.workspaces, ui.selectedProjectId],
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
  const activeAssignment = useMemo(
    () => snapshot?.assignments.find(
      (assignment) => assignment.threadId === activeThread?.id,
    ) ?? null,
    [activeThread?.id, snapshot?.assignments],
  );
  const activeTask = useMemo(
    () => snapshot?.tasks.find(
      (task) => task.id === (activeAssignment?.taskId ?? activeThread?.id),
    ) ?? null,
    [activeAssignment?.taskId, activeThread?.id, snapshot?.tasks],
  );
  const activeAgentInstance = useMemo(
    () => snapshot?.agentInstances.find(
      (instance) => instance.id === activeAssignment?.agentInstanceId,
    ) ?? null,
    [activeAssignment?.agentInstanceId, snapshot?.agentInstances],
  );
  const activeAgentDefinition = useMemo(
    () => snapshot?.agentDefinitions.find(
      (definition) => definition.id === activeAgentInstance?.agentDefinitionId,
    ) ?? null,
    [activeAgentInstance?.agentDefinitionId, snapshot?.agentDefinitions],
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
  const activeContext = selectedWorkspace
    ? contextsByProject[selectedWorkspace.id] ?? null
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
    if (!selectedWorkspace || selectedWorkspace.id in contextsByProject) {
      return;
    }
    void desktopApi.getWorkspaceContext(selectedWorkspace.id)
      .then((context) => {
        setContextsByProject((current) => ({
          ...current,
          [selectedWorkspace.id]: context,
        }));
      })
      .catch((loadError: unknown) => setError(messageFromError(loadError)));
  }, [contextsByProject, selectedWorkspace]);

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

  const createWorkspace = useCallback(async (name: string) => {
    try {
      const created = await desktopApi.createWorkspace({ name: name.trim() });
      await refresh();
      setUi((current) => ({
        ...current,
        projectLayouts: rememberCurrentProjectLayout(current),
        selectedProjectId: created.id,
        activeThreadId: null,
        openThreadIds: [],
        paneThreadIds: [],
        activePaneIndex: 0,
        requestedSplitCount: 1,
      }));
      return created;
    } catch (workspaceError) {
      setError(messageFromError(workspaceError));
      throw workspaceError;
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

  const saveRuntime = useCallback(async (input: SaveRuntimeNodeInput) => {
    const runtime = await desktopApi.saveRuntimeNode(input);
    await refresh();
    return runtime;
  }, [refresh]);

  const testRuntime = useCallback(async (runtimeNodeId: string) => {
    const result = await desktopApi.testRuntimeConnection(runtimeNodeId);
    await refresh();
    return result;
  }, [refresh]);

  const updateAgentRuntime = useCallback(async (
    agentInstanceId: string,
    runtimeNodeId: string,
  ) => {
    const instance = await desktopApi.updateAgentInstanceRuntime({
      agentInstanceId,
      runtimeNodeId,
    });
    await refresh();
    return instance;
  }, [refresh]);

  const createAgentThread = useCallback(
    async (
      profileInput: Omit<CreateAgentProfileInput, "projectId">,
      title: string,
    ) => {
      if (!selectedProject) {
        throw new Error("请先创建工作区，再创建 Agent。");
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

  const createTaskThread = useCallback(async (
    agentInstanceId: string,
    title: string,
  ) => {
    if (!selectedProject || !selectedWorkspace) {
      throw new Error("请先创建工作区。");
    }
    const instance = snapshot?.agentInstances.find(
      (item) => item.id === agentInstanceId,
    );
    const definition = snapshot?.agentDefinitions.find(
      (item) => item.id === instance?.agentDefinitionId,
    );
    const legacyProfile = snapshot?.agentProfiles.find(
      (item) => item.id === definition?.id && item.projectId === selectedProject.id,
    );
    if (!instance || instance.workspaceId !== selectedWorkspace.id || !legacyProfile) {
      throw new Error("这个 Agent 尚未接入当前可执行 Runtime。");
    }
    const thread = await desktopApi.createThread({
      projectId: selectedProject.id,
      agentProfileId: legacyProfile.id,
      title: title.trim(),
    });
    await refresh();
    openThread(thread.id);
    return thread;
  }, [openThread, refresh, selectedProject, selectedWorkspace, snapshot]);

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

  const resolveInboxItem = useCallback(async (inboxItemId: string) => {
    await desktopApi.resolveInboxItem(inboxItemId);
    await refresh();
  }, [refresh]);

  const updateContext = useCallback(async (content: string) => {
    if (!selectedWorkspace) {
      throw new Error("当前没有选中的工作区。");
    }
    const activeRun = activeThread
      ? snapshot?.activeRuns.find((run) => run.threadId === activeThread.id)
      : null;
    const revision = await desktopApi.publishWorkspaceContext({
      workspaceId: selectedWorkspace.id,
      title: "共享工作区上下文",
      content,
      scope: "workspace",
      sourceThreadId: activeThread?.projectId === selectedWorkspace.id
        ? activeThread.id
        : undefined,
      sourceRunId: activeThread?.projectId === selectedWorkspace.id
        ? activeRun?.id
        : undefined,
      sourceAgentInstanceId: activeAgentInstance?.id,
      publishedBy: "user",
    });
    setContextsByProject((current) => ({
      ...current,
      [selectedWorkspace.id]: revision,
    }));
    await refresh();
    return revision;
  }, [
    activeAgentInstance?.id,
    activeThread,
    refresh,
    selectedWorkspace,
    snapshot?.activeRuns,
  ]);

  const publishArtifactToContext = useCallback(async (artifactId: string) => {
    if (!selectedWorkspace || !snapshot) {
      throw new Error("当前没有选中的工作区。");
    }
    const artifact = snapshot.artifacts.find((item) => item.id === artifactId);
    if (!artifact || artifact.workspaceId !== selectedWorkspace.id) {
      throw new Error("找不到当前工作区中的成果。");
    }
    if (!artifact.content?.trim()) {
      throw new Error("这个文件成果没有可发布的文本内容。");
    }
    const assignment = artifact.assignmentId
      ? snapshot.assignments.find((item) => item.id === artifact.assignmentId)
      : snapshot.assignments.find(
          (item) =>
            item.taskId === artifact.taskId &&
            item.agentInstanceId === artifact.agentInstanceId,
        );
    const revision = await desktopApi.publishWorkspaceContext({
      workspaceId: selectedWorkspace.id,
      title: artifact.title,
      content: artifact.content,
      scope: "workspace",
      sourceThreadId: assignment?.threadId ?? undefined,
      sourceRunId: artifact.runId ?? undefined,
      sourceAgentInstanceId: artifact.agentInstanceId,
      sourceArtifactId: artifact.id,
      publishedBy: "user",
    });
    setContextsByProject((current) => ({
      ...current,
      [selectedWorkspace.id]: revision,
    }));
    await refresh();
    return revision;
  }, [refresh, selectedWorkspace, snapshot]);

  const createHandoff = useCallback(async (
    toAgentInstanceId: string,
    summary: string,
  ) => {
    if (!selectedWorkspace || !snapshot || !activeContext) {
      throw new Error("请先发布共享上下文。");
    }
    const sourceArtifact = activeContext.sourceArtifactId
      ? snapshot.artifacts.find(
          (item) => item.id === activeContext.sourceArtifactId,
        )
      : null;
    const fromAgentInstanceId = activeContext.sourceAgentInstanceId
      ?? sourceArtifact?.agentInstanceId
      ?? activeAgentInstance?.id;
    const taskId = activeContext.taskId ?? sourceArtifact?.taskId ?? activeTask?.id;
    if (!fromAgentInstanceId || !taskId) {
      throw new Error("当前上下文缺少可交接的 Agent 或任务来源。");
    }
    const handoff = await desktopApi.createHandoff({
      workspaceId: selectedWorkspace.id,
      taskId,
      fromAgentInstanceId,
      toAgentInstanceId,
      sourceRunId: activeContext.sourceRunId ?? sourceArtifact?.runId ?? undefined,
      contextRevisionId: activeContext.id,
      summary: summary.trim(),
    });
    await refresh();
    return handoff;
  }, [
    activeAgentInstance?.id,
    activeContext,
    activeTask?.id,
    refresh,
    selectedWorkspace,
    snapshot,
  ]);

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
      throw new Error("原始任务不可用，无法重试。");
    }
    return sendMessage(threadId, prompt);
  }, [messagesByThread, sendMessage]);

  return {
    snapshot,
    loading,
    error,
    selectedProject,
    selectedWorkspace,
    activeThread,
    activeAgent,
    activeTask,
    activeAgentInstance,
    activeAgentDefinition,
    activeContext,
    visibleThreads,
    messagesByThread,
    streamingByThread,
    executionStageByThread,
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
    createWorkspace,
    addProject,
    saveProvider,
    testProvider,
    saveRuntime,
    testRuntime,
    updateAgentRuntime,
    createAgentThread,
    createTaskThread,
    sendMessage,
    cancelRun,
    resolveApproval,
    resolveInboxItem,
    updateContext,
    publishArtifactToContext,
    createHandoff,
    getRunForThread,
    getLatestRunForThread,
    retryThread,
  };
}

function applyRunEvent(
  event: RunEvent,
  setSnapshot: React.Dispatch<
    React.SetStateAction<DesktopWorkspaceSnapshot | null>
  >,
  setMessages: React.Dispatch<
    React.SetStateAction<Record<string, ThreadMessage[]>>
  >,
  setStreaming: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  setExecutionStage: React.Dispatch<
    React.SetStateAction<Record<string, ManagedExecutionStage>>
  >,
): void {
  if (event.type === "managed-execution") {
    setExecutionStage((current) => ({
      ...current,
      [event.threadId]: event.progress.stage,
    }));
    return;
  }
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
      setExecutionStage((current) => {
        const next = { ...current };
        delete next[event.threadId];
        return next;
      });
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
  snapshot: DesktopWorkspaceSnapshot,
): PersistedUiState {
  const projectIds = new Set(snapshot.workspaces.map((workspace) => workspace.id));
  const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
  const selectedProjectId = current.selectedProjectId &&
    projectIds.has(current.selectedProjectId)
    ? current.selectedProjectId
    : snapshot.workspaces[0]?.id ?? null;
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
  snapshot: DesktopWorkspaceSnapshot | null,
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
