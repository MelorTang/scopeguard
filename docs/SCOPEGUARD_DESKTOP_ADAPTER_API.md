# ScopeGuard Desktop Adapter API

## Purpose

This document defines the MVP adapter API contract between:

- the desktop frontend runtime
- the local ScopeGuard adapter/service

The adapter exists to protect the frontend from:

- direct shell command orchestration
- raw `.scopeguard` file traversal
- leaking internal CLI workflow details into UI code

The adapter should expose shaped, desktop-friendly data and actions.

## Design Rules

- keep the frontend typed and simple
- reuse existing ScopeGuard data and commands
- prefer file reads for fast hydration
- use CLI/core actions for workflow-changing operations
- keep review, approval, and state transitions authoritative in the adapter/core layer

## Transport Recommendation

For MVP, either of these are acceptable:

1. local HTTP server
2. Electron/Tauri IPC adapter with the same logical contract

Recommended first move:

- keep an HTTP-like contract
- even if implemented through IPC later

That makes frontend development easier and preserves compatibility with the current `apps/server` direction.

## API Areas

The adapter should expose 8 logical areas:

1. project discovery
2. sidebar data
3. task workspace data
4. conversation storage
5. task actions
6. executor integration
7. provider and workspace configuration
8. session and UI state

## 1. Project Discovery

### `POST /api/desktop/open-folder`

Open a folder and decide whether it is:

- a new project
- an existing ScopeGuard project
- a plain local workspace folder

#### Request

```json
{
  "folderPath": "/path/to/scopeguard"
}
```

#### Response

```json
{
  "ok": true,
  "mode": "existing-project",
  "project": {
    "id": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
    "name": "scopeguard",
    "rootPath": "/path/to/scopeguard",
    "defaultBranch": "master",
    "isInitialized": true,
    "taskCount": 3,
    "activeTaskCount": 3,
    "updatedAt": "2026-05-13T00:00:00.000Z",
    "source": "scopeguard"
  }
}
```

#### `mode` values

- `new-project`
- `existing-project`
- `workspace-folder`
- `not-a-repo`
- `error`

### Implementation notes

This endpoint may:

- locate git root
- inspect `.scopeguard/config.json`
- decide whether `init` should be suggested

It should also allow non-git folders to open in workspace mode instead of failing hard.

This endpoint should not automatically start expensive background work unless explicitly requested.

## 2. Sidebar Data

### `GET /api/desktop/projects`

Return recent or known projects for sidebar rendering.

#### Response

```json
{
  "projects": [
    {
      "id": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
      "name": "scopeguard",
      "rootPath": "/path/to/scopeguard",
      "defaultBranch": "master",
      "isInitialized": true,
      "taskCount": 3,
      "activeTaskCount": 3,
      "updatedAt": "2026-05-13T00:00:00.000Z",
      "source": "scopeguard"
    }
  ]
}
```

### `GET /api/desktop/projects/:projectId/tasks`

Return sidebar-safe task items only.

#### Response

```json
{
  "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
  "tasks": [
    {
      "id": "T-014",
      "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
      "title": "Add README redesign",
      "subtitle": "Context pack ready",
      "status": "In Progress",
      "rawStatus": "in_progress",
      "riskLevel": "medium",
      "updatedAt": "2026-05-13T00:00:00.000Z",
      "hasConversation": true
    }
  ]
}
```

### Implementation notes

This is a read-optimized endpoint.

Preferred sources:

- `.scopeguard/tasks/*/task.json`
- desktop conversation files for `hasConversation`

Avoid invoking CLI for every sidebar refresh if local files are enough.

## 3. Task Workspace Data

### `GET /api/desktop/tasks/:taskId`

Return main task detail payload for header + summary.

#### Response

```json
{
  "task": {
    "id": "T-014",
    "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
    "title": "Add README redesign",
    "description": "Rewrite the README homepage for first-time users.",
    "uiStatus": "In Progress",
    "rawStatus": "in_progress",
    "riskLevel": "medium",
    "acceptanceCriteria": [],
    "commands": [],
    "dependencies": [],
    "branchName": null,
    "worktreePath": null,
    "resultSummary": null,
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:10:00.000Z"
  }
}
```

### `GET /api/desktop/tasks/:taskId/context`

Return the compact drawer payload.

#### Response

```json
{
  "context": {
    "taskId": "T-014",
    "allowedFiles": ["README.md", "README.zh-CN.md"],
    "lockedFiles": ["README.md", "README.zh-CN.md"],
    "forbiddenFiles": ["dist/**", "build/**"],
    "validationSummary": {
      "latestStatus": "pending",
      "latestReportPath": null,
      "summaryText": null
    },
    "activitySummary": {
      "lastEvent": "Task conversation created",
      "lastEventAt": "2026-05-13T00:10:00.000Z",
      "eventCount": 4
    }
  }
}
```

### Implementation notes

This endpoint should merge:

- task record data
- latest verification/review artifact summary
- lightweight conversation/activity summary

## 4. Conversation Storage

### `GET /api/desktop/conversations/:threadId`

Return one project or task conversation thread.

#### Response

```json
{
  "thread": {
    "id": "task-T-014",
    "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
    "kind": "task",
    "taskId": "T-014",
    "title": "Add README redesign",
    "status": "active",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:20:00.000Z",
    "messages": []
  }
}
```

### `PUT /api/desktop/conversations/:threadId`

Persist the entire conversation thread.

#### Request

```json
{
  "thread": {
    "id": "task-T-014",
    "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
    "kind": "task",
    "taskId": "T-014",
    "title": "Add README redesign",
    "status": "active",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:20:00.000Z",
    "messages": []
  }
}
```

### `POST /api/desktop/conversations`

Create a new thread for:

- a project conversation
- a task conversation

#### Request

```json
{
  "projectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
  "kind": "task",
  "taskId": "T-014",
  "title": "Add README redesign"
}
```

#### Response

```json
{
  "ok": true,
  "threadId": "task-T-014"
}
```

## 5. Home And Task Conversation Actions

### `POST /api/desktop/projects/:projectId/start-task`

Start a new task conversation from Home.

This is a desktop-oriented action, not necessarily a full workflow task import yet.

#### Request

```json
{
  "userGoal": "Help me redesign the README homepage for new users."
}
```

#### Response

```json
{
  "ok": true,
  "threadId": "task-draft-2026-05-13-001",
  "mode": "draft-task",
  "initialMessage": {
    "id": "m1",
    "role": "scopeguard",
    "kind": "summary",
    "text": "Let's turn that goal into a task conversation.",
    "createdAt": "2026-05-13T00:30:00.000Z"
  }
}
```

### Why this endpoint matters

The desktop app needs a way to begin useful work before a full planner/import lifecycle is complete.

This endpoint is the bridge between:

- user goal
- task conversation seed

## 6. Task Actions

These map more directly to existing ScopeGuard functionality.

### `POST /api/desktop/tasks/:taskId/verify`

#### Core mapping

- `verifyTask(...)`
- or `scopeguard verify <task-id>`

#### Response

```json
{
  "ok": true,
  "taskId": "T-014",
  "result": {
    "status": "passed",
    "summaryText": "Verification passed. No out-of-scope changes detected.",
    "reportPath": ".scopeguard/tasks/T-014/verify-report.json"
  },
  "message": {
    "id": "m10",
    "role": "scopeguard",
    "kind": "validation",
    "text": "Verification passed. No out-of-scope changes were detected.",
    "createdAt": "2026-05-13T00:31:00.000Z"
  }
}
```

### `POST /api/desktop/tasks/:taskId/review`

#### Core mapping

- `generateReviewReport(...)`
- or `scopeguard review <task-id>`

#### Response

```json
{
  "ok": true,
  "taskId": "T-014",
  "reviewPath": ".scopeguard/tasks/T-014/review.md",
  "message": {
    "id": "m11",
    "role": "scopeguard",
    "kind": "review",
    "text": "Review is ready. I can now summarize the diff and remaining risks here in the conversation.",
    "createdAt": "2026-05-13T00:32:00.000Z",
    "actions": [
      {
        "id": "a-review-summary",
        "label": "Summarize the diff",
        "intent": "review-task"
      }
    ]
  }
}
```

### `POST /api/desktop/tasks/:taskId/approve`

#### Core mapping

- `scopeguard approve <task-id>`

#### Request

```json
{
  "approvalStepId": "approve-review-001"
}
```

#### Response

```json
{
  "ok": true,
  "taskId": "T-014",
  "rawStatus": "approved",
  "message": {
    "id": "m12",
    "role": "scopeguard",
    "kind": "approval_result",
    "text": "Approval recorded. This task can now continue toward merge readiness.",
    "createdAt": "2026-05-13T00:33:00.000Z"
  }
}
```

### `POST /api/desktop/tasks/:taskId/discard`

#### Core mapping

- `discardTask(...)`

### `POST /api/desktop/tasks/:taskId/close`

#### Core mapping

- `closeTask(...)`

### `POST /api/desktop/tasks/:taskId/reopen`

#### Core mapping

- `reopenTask(...)`

## 7. Executor Integration

The adapter should hide executor-specific differences from the frontend.

Initial executor classes:

- `codex-account`
- `openai-compatible`
- `anthropic`

The frontend should ask for an assistant turn or a task action.
It should not manually branch on provider-specific HTTP or CLI behavior.

### Provider And Workspace Configuration

### `GET /api/desktop/ai-config`

Return the effective local provider configuration for the current project workspace.

### `PUT /api/desktop/ai-config`

Persist provider configuration for the local machine.

This configuration should not be stored in the repository by default if it includes secrets such as API keys.

This area supports future direct CLI execution.

The desktop app should eventually treat executors as backends.

### `POST /api/desktop/tasks/:taskId/handoff`

Generate or return executor-ready handoff content.

#### Request

```json
{
  "target": "codex"
}
```

#### Response

```json
{
  "ok": true,
  "taskId": "T-014",
  "target": "codex",
  "handoffText": "You are working inside a git worktree created by ScopeGuard...",
  "message": {
    "id": "m20",
    "role": "scopeguard",
    "kind": "handoff",
    "text": "The executor handoff is ready.",
    "createdAt": "2026-05-13T00:35:00.000Z"
  }
}
```

### `POST /api/desktop/tasks/:taskId/run`

Future direct execution endpoint.

#### Request

```json
{
  "executor": "codex",
  "mode": "direct-cli"
}
```

#### Response

```json
{
  "ok": true,
  "taskId": "T-014",
  "runId": "run-2026-05-13-001",
  "message": {
    "id": "m21",
    "role": "scopeguard",
    "kind": "summary",
    "text": "Execution started with Codex CLI.",
    "createdAt": "2026-05-13T00:36:00.000Z"
  }
}
```

### MVP note

`/run` can remain stubbed or deferred in MVP.

`/handoff` is enough for the first desktop generation.

## 8. Session And UI State

### `GET /api/desktop/session`

Return desktop UI session state.

#### Response

```json
{
  "session": {
    "activeProjectId": "655d2251-2b88-4c82-97e6-fe8edf82d2c4",
    "activeTaskId": "T-014",
    "activeThreadId": "task-T-014",
    "activeView": "task",
    "drawerState": {
      "contextOpen": false,
      "logsOpen": false
    }
  }
}
```

### `PUT /api/desktop/session`

Persist desktop UI state.

## 9. Error Shape

All endpoints should converge on one lightweight error shape:

```json
{
  "ok": false,
  "code": "TASK_NOT_FOUND",
  "message": "Task not found: T-014"
}
```

Suggested common codes:

- `PROJECT_NOT_FOUND`
- `TASK_NOT_FOUND`
- `THREAD_NOT_FOUND`
- `INVALID_REQUEST`
- `NOT_INITIALIZED`
- `VERIFY_FAILED`
- `REVIEW_FAILED`
- `APPROVAL_FAILED`
- `EXECUTOR_UNAVAILABLE`
- `INTERNAL_ERROR`

## 10. Read vs Write Strategy

### Prefer file reads for:

- project metadata
- task list hydration
- task detail hydration
- conversation history
- session state

### Prefer core actions / command-backed operations for:

- verification
- review generation
- approval
- close / reopen / discard
- direct executor dispatch

This keeps the desktop app fast without duplicating workflow logic.

## 11. Relationship To Existing `apps/server`

The current board server already exposes useful foundations:

- `/api/project`
- `/api/tasks`
- `/api/tasks/:id`
- `/api/tasks/:id/review`
- task action endpoints
- `/api/locks`
- `/api/scheduler/next`
- `/api/scheduler/schedule`

Recommended MVP implementation path:

1. keep those routes for board compatibility
2. add `/api/desktop/*` routes for desktop-specific shapes
3. let desktop use the new routes only

This avoids breaking the current board while letting the desktop API become more conversation- and UI-oriented.

## 12. Recommended Build Order

Implement in this order:

1. `GET /api/desktop/projects`
2. `POST /api/desktop/open-folder`
3. `GET /api/desktop/projects/:projectId/tasks`
4. `GET /api/desktop/tasks/:taskId`
5. `GET /api/desktop/tasks/:taskId/context`
6. conversation read/write endpoints
7. `POST /api/desktop/tasks/:taskId/review`
8. `POST /api/desktop/tasks/:taskId/approve`
9. `POST /api/desktop/tasks/:taskId/handoff`
10. later `POST /api/desktop/tasks/:taskId/run`

## Next Step

After this API contract, the next concrete task should be:

- scaffold the desktop adapter module or extend `apps/server`
- define TypeScript shared types for desktop responses
- implement the first read-only desktop endpoints
