export type CoreTaskStatus =
  | "backlog"
  | "planned"
  | "ready"
  | "blocked"
  | "in_progress"
  | "needs_review"
  | "test_failed"
  | "conflict"
  | "approved"
  | "merged"
  | "closed";

export type DesktopTaskStatus = "Draft" | "Ready" | "In Progress" | "Awaiting Review" | "Approved" | "Blocked";

export type DesktopProjectSource = "scopeguard" | "new-folder" | "local-folder";

export type DesktopProject = {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string | null;
  isGitRepo?: boolean;
  isInitialized: boolean;
  isTrusted: boolean;
  taskCount: number;
  activeTaskCount: number;
  updatedAt: string | null;
  source: DesktopProjectSource;
};

export type DesktopTaskListItem = {
  id: string;
  projectId: string;
  title: string;
  subtitle: string;
  status: DesktopTaskStatus;
  rawStatus: CoreTaskStatus;
  riskLevel: "low" | "medium" | "high" | null;
  updatedAt: string | null;
  hasConversation: boolean;
  preferredExecutor: DesktopExecutorId | null;
  assignedExecutor: DesktopExecutorId | null;
  goal?: string;
  allowedFiles?: string[];
  acceptanceCriteria?: string[];
  commands?: string[];
  dependsOn?: string[];
  depBlocked?: boolean;
  priority: string;
  parallelizable: boolean;
  reviewAssignmentStatus: "none" | "pending" | "claimed";
  reviewStatus: "none" | "ready_for_review" | "needs_attention";
};

export type DesktopTaskReviewSummary = {
  reviewId: string;
  taskId: string;
  runId: string | null;
  status: "ready_for_review" | "needs_attention";
  runSucceeded: boolean | null;
  changedFileCount: number;
  hasAcceptanceCriteria: boolean;
  hasCommands: boolean;
  suggestion: string;
  createdAt: string;
};

export type DesktopLatestRunResult = {
  runId: string;
  executorId: DesktopExecutorId;
  status: DesktopTaskRunStatus;
  exitCode: number | null;
  resultSummary: string | null;
  changedFiles: string[];
  startedAt: string;
  finishedAt: string | null;
};

export type DesktopTaskDetail = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  uiStatus: DesktopTaskStatus;
  rawStatus: CoreTaskStatus;
  riskLevel: "low" | "medium" | "high";
  isDraft?: boolean;
  acceptanceCriteria: string[];
  commands: string[];
  dependencies: string[];
  branchName: string | null;
  worktreePath: string | null;
  resultSummary: string | null;
  preferredExecutor: DesktopExecutorId | null;
  assignedExecutor: DesktopExecutorId | null;
  dependsOn: string[];
  depBlocked: boolean;
  parallelizable: boolean;
  priority: string;
  latestRunResult: DesktopLatestRunResult | null;
  latestReviewSummary: DesktopTaskReviewSummary | null;
  dispatchInfo: DesktopTaskDispatchInfo;
  assignmentId: string | null;
  activeExecutionAssignmentId: string | null;
  reviewAssignmentStatus: "none" | "pending" | "claimed";
  reviewStatus: "none" | "ready_for_review" | "needs_attention";
  createdAt: string;
  updatedAt: string;
};

export type DesktopTaskContext = {
  taskId: string;
  allowedFiles: string[];
  lockedFiles: string[];
  forbiddenFiles: string[];
  referenceFiles?: Array<{
    path: string;
    label: string;
  }>;
  validationSummary: {
    latestStatus: "unknown" | "passed" | "failed" | "pending";
    latestReportPath: string | null;
    summaryText: string | null;
  };
  activitySummary: {
    lastEvent: string | null;
    lastEventAt: string | null;
    eventCount: number;
  };
};

export type DesktopOpenFolderMode = "new-project" | "existing-project" | "workspace-folder" | "not-a-repo" | "error";

export type DesktopOpenFolderResponse = {
  ok: boolean;
  mode: DesktopOpenFolderMode;
  project?: DesktopProject;
  message?: string;
};

export type DesktopMessageActionIntent =
  | "continue-task"
  | "summarize-task"
  | "generate-handoff"
  | "explain-route"
  | "explain-constraints"
  | "set-allowed-files"
  | "set-acceptance-criteria"
  | "set-commands"
  | "review-task"
  | "approve-step"
  | "refine-draft"
  | "request-safer-revision";

export type DesktopMessageAction = {
  id: string;
  label: string;
  intent: DesktopMessageActionIntent;
  payload?: Record<string, string>;
};

export type DesktopMessageKind =
  | "text"
  | "summary"
  | "review"
  | "approval_request"
  | "approval_result"
  | "handoff"
  | "validation"
  | "warning";

export type DesktopMessage = {
  id: string;
  role: "user" | "scopeguard" | "system";
  kind: DesktopMessageKind;
  text: string;
  createdAt: string;
  metadata?: {
    taskId?: string;
    approvalStepId?: string;
    handoffTarget?: string;
    reportPath?: string;
    rawStatus?: string;
  };
  actions?: DesktopMessageAction[];
};

export type DesktopConversationThread = {
  id: string;
  projectId: string;
  kind: "project" | "task";
  taskId: string | null;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  messages: DesktopMessage[];
};

export type DesktopProjectSession = {
  activeProjectId: string | null;
  activeTaskId: string | null;
  activeThreadId: string | null;
  activeView: "home" | "task" | "settings";
  drawerState: {
    contextOpen: boolean;
    logsOpen: boolean;
  };
};

export type DesktopExecutorId = "codex-cli" | "claude-cli";

export type DesktopExecutorAdapter = {
  id: DesktopExecutorId;
  displayName: string;
  command: string;
  buildArgs: (task: { title: string; description: string; acceptanceCriteria: string[]; commands: string[]; preferredExecutor?: string; userText?: string }) => string[];
  buildEnv: (workspaceRoot: string) => Record<string, string>;
};

export type DesktopLaunchMode = "managed" | "connected";

export type DesktopTaskRunStatus = "starting" | "running" | "succeeded" | "failed";

export type DesktopTaskRunRecord = {
  runId: string;
  taskId: string;
  executorId: DesktopExecutorId;
  status: DesktopTaskRunStatus;
  startedAt: string;
  finishedAt: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  resultSummary: string | null;
  changedFiles: string[];
  launchMode: DesktopLaunchMode;
  externalSessionId: string | null;
};

export type DesktopExternalRunStart = {
  executorId: DesktopExecutorId;
  externalSessionId: string;
  launchMode?: DesktopLaunchMode;
  sessionId?: string; // optional session from /external/initialize
};

export type DesktopExternalRunFinish = {
  executorId: DesktopExecutorId;
  externalSessionId: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  resultSummary?: string;
  changedFiles?: string[];
  exitCode?: number;
  sessionId?: string; // optional session from /external/initialize
};

export type DesktopExternalReview = {
  executorId: DesktopExecutorId;
  externalSessionId: string;
  status: "ready_for_review" | "needs_attention";
  suggestion: string;
  sessionId?: string; // optional session from /external/initialize
};


export type DesktopProjectRecentRun = {
  runId: string;
  taskId: string;
  taskTitle: string;
  executorId: DesktopExecutorId;
  status: DesktopTaskRunStatus;
  startedAt: string;
  finishedAt: string | null;
  resultSummary: string | null;
};

export type DesktopExecutorConfig = {
  codexCommand: string;
  claudeCommand: string;
};

export type DesktopCLITestResult = {
  ok: boolean;
  message: string;
  version: string | null;
};

export type DesktopConnectedClient = {
  sessionId: string;
  clientName: string;
  clientVersion: string | null;
  executorId: DesktopExecutorId | null;
  mode: string;
  status: "online" | "stale";
  lastSeenAt: string;
  createdAt: string;
  protocolVersion: string;
};

export type DesktopTaskDispatchInfo = {
  status: "idle" | "ready" | "dispatched" | "no_client";
  assignedExecutor: DesktopExecutorId | null;
  matchingClient: DesktopConnectedClient | null;
};

export type DesktopAssignmentStatus = "pending" | "claimed" | "completed" | "canceled";

export type DesktopAssignmentRecord = {
  assignmentId: string;
  taskId: string;
  projectId: string;
  assignedExecutor: DesktopExecutorId;
  sessionTarget: string | null;
  status: DesktopAssignmentStatus;
  kind: "execution" | "review";
  handoffSnapshot: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
};

export type DesktopPlanTask = {
  title: string;
  goal: string;
  allowedFiles: string[];
  acceptanceCriteria: string[];
  commands: string[];
  preferredExecutor: DesktopExecutorId;
  assignedExecutor?: DesktopExecutorId;
  dependsOn?: string[];
  parallelizable?: boolean;
  priority?: "high" | "medium" | "low";
};

export type DesktopTaskHandoff = {
  taskId: string;
  title: string;
  goal: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  acceptanceCriteria: string[];
  commands: string[];
  preferredExecutor: DesktopExecutorId | null;
  projectName: string;
  projectRoot: string;
  projectMemory: Array<{ title: string; content: string }>;
  recentContext: Array<{ role: string; text: string }>;
};
