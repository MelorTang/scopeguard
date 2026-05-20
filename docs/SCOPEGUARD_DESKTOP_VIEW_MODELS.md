# ScopeGuard Desktop View Models

## Purpose

This document defines the desktop-facing data models for:

- project
- task
- conversation
- sidebar state
- context drawer state

These are not meant to replace ScopeGuard Core storage.

They are UI-oriented view models derived from:

- `.scopeguard/config.json`
- `.scopeguard/tasks/*/task.json`
- review / verify artifacts
- local desktop conversation state

The main rule is:

ScopeGuard Core remains the source of truth for workflow and task state.

Desktop view models are read-friendly projections for UI rendering and conversational behavior.

## Source Of Truth

### Core-owned state

These remain owned by ScopeGuard Core:

- project metadata in `.scopeguard/config.json`
- task metadata and workflow state in `.scopeguard/tasks/*/task.json`
- lock data in `.scopeguard/locks.json`
- project map in `.scopeguard/project-map.json`
- review and verification artifacts

### Desktop-owned state

These can initially be owned by the desktop app:

- recent projects list
- active project selection
- active task selection
- task conversation history
- project conversation history
- drawer open/closed UI state
- quick prompt interaction history

## Model Overview

Recommended desktop-side models:

- `DesktopProject`
- `DesktopTaskListItem`
- `DesktopTaskDetail`
- `DesktopConversationThread`
- `DesktopMessage`
- `DesktopTaskContext`
- `DesktopProjectSession`

## 1. DesktopProject

This powers:

- sidebar project cards
- project home state
- current project selection

```ts
type DesktopProject = {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string | null;
  isInitialized: boolean;
  taskCount: number;
  activeTaskCount: number;
  updatedAt: string | null;
  source: "scopeguard" | "new-folder";
};
```

### Mapping

- `id` -> `.scopeguard/config.json.projectId`
- `name` -> `.scopeguard/config.json.projectName`
- `rootPath` -> `.scopeguard/config.json.rootPath`
- `defaultBranch` -> `.scopeguard/config.json.defaultBranch`
- `isInitialized` -> whether `.scopeguard/config.json` exists
- `taskCount` -> number of discovered task records
- `activeTaskCount` -> count excluding `merged` and `closed`

## 2. DesktopTaskListItem

This powers:

- sidebar task rows
- task status labels
- light project-level summaries

```ts
type DesktopTaskListItem = {
  id: string;
  projectId: string;
  title: string;
  subtitle: string;
  status: "Draft" | "In Progress" | "Needs Review" | "Blocked";
  rawStatus: CoreTaskStatus;
  riskLevel: "low" | "medium" | "high" | null;
  updatedAt: string | null;
  hasConversation: boolean;
};
```

### Why this model is separate

The sidebar should not expose every internal ScopeGuard state.

It needs:

- one human-friendly status
- one short subtitle
- enough identity to reopen the task

### Suggested core-to-UI status mapping

```ts
type CoreTaskStatus =
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
```

Recommended mapping:

- `backlog` -> `Draft`
- `planned` -> `Draft`
- `ready` -> `Draft`
- `blocked` -> `Blocked`
- `in_progress` -> `In Progress`
- `needs_review` -> `Needs Review`
- `test_failed` -> `Blocked`
- `conflict` -> `Blocked`
- `approved` -> `Needs Review`
- `merged` -> hidden by default in sidebar
- `closed` -> hidden by default in sidebar

## 3. DesktopTaskDetail

This powers:

- task header
- task summary card
- task conversation bootstrap

```ts
type DesktopTaskDetail = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  uiStatus: "Draft" | "In Progress" | "Needs Review" | "Blocked";
  rawStatus: CoreTaskStatus;
  riskLevel: "low" | "medium" | "high";
  acceptanceCriteria: string[];
  commands: string[];
  dependencies: string[];
  branchName: string | null;
  worktreePath: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
};
```

### Notes

This model should not include every drawer field directly.

Keep the main task view focused on what the task conversation needs immediately.

## 4. DesktopTaskContext

This powers the collapsed right-side drawer.

```ts
type DesktopTaskContext = {
  taskId: string;
  allowedFiles: string[];
  lockedFiles: string[];
  forbiddenFiles: string[];
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
```

### Notes

This model is intentionally smaller than raw underlying artifacts.

The drawer should show:

- the most relevant constraints
- latest validation state
- a short activity view

Not every raw internal file needs to be rendered in MVP.

## 5. DesktopConversationThread

This is the most important desktop-owned model.

It powers:

- project conversation
- task conversation
- inline review
- inline approval prompts

```ts
type DesktopConversationThread = {
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
```

## 6. DesktopMessage

This is the message unit used in the desktop conversation UI.

```ts
type DesktopMessage = {
  id: string;
  role: "user" | "scopeguard" | "system";
  kind:
    | "text"
    | "summary"
    | "review"
    | "approval_request"
    | "approval_result"
    | "handoff"
    | "validation"
    | "warning";
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
```

## 7. DesktopMessageAction

This powers:

- quick inline buttons in conversation
- approval buttons
- follow-up suggestions

```ts
type DesktopMessageAction = {
  id: string;
  label: string;
  intent:
    | "continue-task"
    | "summarize-task"
    | "generate-handoff"
    | "explain-route"
    | "review-task"
    | "approve-step"
    | "request-safer-revision";
  payload?: Record<string, string>;
};
```

## 8. DesktopProjectSession

This is the top-level runtime state for the active project screen.

```ts
type DesktopProjectSession = {
  activeProjectId: string | null;
  activeTaskId: string | null;
  activeThreadId: string | null;
  activeView: "home" | "task";
  drawerState: {
    contextOpen: boolean;
    logsOpen: boolean;
  };
};
```

This is runtime UI state, not persistent core state.

## Conversation Storage Recommendation

For MVP, store conversation threads separately from ScopeGuard Core task files.

Suggested location:

- `.scopeguard/desktop/conversations/*.json`

Suggested reason:

- avoids mutating core task schema too early
- keeps desktop experiment isolated
- lets us evolve conversation format independently

Suggested file layout:

```text
.scopeguard/
  desktop/
    conversations/
      project-<project-id>.json
      task-<task-id>.json
    ui-state.json
```

## Suggested Conversation File Schema

```json
{
  "id": "task-T-014",
  "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
  "kind": "task",
  "taskId": "T-014",
  "title": "Add README redesign",
  "status": "active",
  "createdAt": "2026-05-13T00:00:00.000Z",
  "updatedAt": "2026-05-13T00:20:00.000Z",
  "messages": [
    {
      "id": "m1",
      "role": "scopeguard",
      "kind": "summary",
      "text": "You are now in the task workspace for Add README redesign.",
      "createdAt": "2026-05-13T00:00:00.000Z"
    },
    {
      "id": "m2",
      "role": "user",
      "kind": "text",
      "text": "Generate a Codex handoff, but keep me in the loop if anything needs review later.",
      "createdAt": "2026-05-13T00:01:00.000Z"
    },
    {
      "id": "m3",
      "role": "scopeguard",
      "kind": "handoff",
      "text": "I can do that. The current task already has enough context for execution.",
      "createdAt": "2026-05-13T00:02:00.000Z",
      "actions": [
        {
          "id": "a1",
          "label": "Generate executor handoff",
          "intent": "generate-handoff",
          "payload": { "target": "codex" }
        }
      ]
    }
  ]
}
```

## Why Conversation Should Not Live Inside task.json Yet

Current `task.json` is workflow state owned by ScopeGuard Core.

If we put desktop conversation history into it too early, we risk:

- coupling UI experiments to core workflow state
- making CLI/task storage harder to evolve
- mixing operational state with UX state

Conversation can move closer to core later if it proves stable.

## Project Home Conversation Model

Project-level conversations are different from task conversations.

They should be stored separately and used for:

- opening a folder and orienting the user
- describing a new goal before a task exists
- deciding whether to create/import/start a task

Suggested `kind`:

- `project`

Suggested behavior:

- one active project conversation per project
- many task conversations under the project

## Adapter Output Recommendation

The adapter layer should not dump raw files directly into the frontend.

Instead it should expose shaped responses.

Suggested endpoints or typed functions:

- `getDesktopProjects(): DesktopProject[]`
- `getDesktopProject(projectId): DesktopProject`
- `getDesktopTasks(projectId): DesktopTaskListItem[]`
- `getDesktopTask(taskId): DesktopTaskDetail`
- `getDesktopTaskContext(taskId): DesktopTaskContext`
- `getConversation(threadId): DesktopConversationThread`
- `saveConversation(thread): void`

## Initial Derivation Rules

### From `.scopeguard/config.json`

Derive:

- `DesktopProject`

### From `.scopeguard/tasks/*/task.json`

Derive:

- `DesktopTaskListItem`
- `DesktopTaskDetail`
- parts of `DesktopTaskContext`

### From verify/review artifacts

Derive:

- validation summary
- review summary
- activity summary

### From `.scopeguard/desktop/conversations/*.json`

Derive:

- `DesktopConversationThread`

## MVP Defaults

Recommended MVP defaults:

- hide `merged` and `closed` tasks from sidebar
- always keep one project conversation available
- create a task conversation file when the user starts a new task from Home
- create approval prompts as `DesktopMessage` entries rather than special pages

## Next Step

After these view models, the next implementation document should define:

- the adapter API contract
- request/response shapes
- which functions call CLI commands vs read files directly
