# ScopeGuard Capability Matrix

> Current baseline: Phase 4 complete (project-level dispatch recovery + multi-executor routing).
> This document captures what is genuinely working, what is still minimal,
> and what is explicitly not yet supported.

---

## 1. Planning / Proposal

| Capability | Status | Notes |
|---|---|---|
| Project goal → structured tasks | ✅ Established | `/plan` command parses goals into structured task proposals |
| Task schema (title, goal, scope, criteria, commands) | ✅ Established | Full `TaskRecord` with allowedFiles, acceptanceCriteria, commands |
| Proposal editing (add/remove tasks, edit fields) | ✅ Established | Inline proposal editing in `renderHome()` |
| Commit plan → formal tasks | ✅ Established | `POST /api/desktop/projects/{id}/commit-plan` |
| Import existing plan (JSON/Markdown) | ✅ Established | Structured plan detection in `handleHomeSend` |
| Proposal normalization via server | ✅ Established | `POST /api/desktop/projects/{id}/normalize-plan` |
| Proposal readiness assessment | ✅ Established | Client computes "too-vague", "needs-review", "ready-to-commit" |
| Draft task persistence | ✅ Established | Desktop draft tasks persist to disk |
| Conversational proposal editing | ⚠️ Minimal | Basic text-based; no rich structured editing |
| Multi-turn planning refinement | ⚠️ Minimal | Single `/plan` pass, no iterative refinement loop |

---

## 2. Single-Task Orchestration

| Capability | Status | Notes |
|---|---|---|
| Queue for connected agent | ✅ Established | `POST /api/desktop/tasks/{id}/queue-assignment` |
| Claim assignment | ✅ Established | `POST /api/desktop/external/pending/{id}/claim` |
| Start external run | ✅ Established | `POST /api/desktop/tasks/{id}/external-run/start` |
| Finish external run + result reporting | ✅ Established | `POST /api/desktop/tasks/{id}/external-run/finish` |
| Task status advancement (ready → needs_review → approved) | ✅ Established | `advanceTaskStatusAfterRun`, `approveDesktopTask` |
| Task detail page UI | ✅ Established | `renderTaskWorkspace()` with dispatch, run, review states |
| Rerun path (refine → re-queue) | ✅ Established | Blocked/needs_attention → refine → ready → re-queue |
| Local CLI run (fallback) | ✅ Established | `POST /api/desktop/tasks/{id}/run` |
| Single-task happy path end-to-end | ✅ Established | queue → claim → execute → finish → review → approve |

---

## 3. Review Actor

| Capability | Status | Notes |
|---|---|---|
| Auto-review on run finish (precheck / baseline) | ✅ Established | `buildTaskReviewSummary` auto-creates review with status "ready_for_review" |
| External review submission | ✅ Established | `scopeguard_submit_review` tool; `POST /api/desktop/tasks/{id}/external-review` |
| Real reviewer judgment (ready_for_review / needs_attention) | ✅ Established | Reviewer evaluates criteria and commands; must submit genuine verdict |
| Review assignment lifecycle | ✅ Established | Auto-created on run finish; pending → claimed → completed |
| Review required before complete | ✅ Established | `complete` endpoint rejects if `latestReviewSummary.reviewId` doesn't start with "external-" |
| Review assignment executor follows task executor | ✅ Established | Uses `resolveEffectiveTaskExecutor(taskAfterRun)` not hardcoded "claude-cli" |
| Multi-reviewer routing | ❌ Not yet | Review always goes to the same executor as the task execution |
| Review retry / amend | ❌ Not yet | No way to resubmit after needs_attention review |

---

## 4. Multi-Task Orchestration

| Capability | Status | Notes |
|---|---|---|
| `dependsOn` filtering in `list_pending` | ✅ Established | Unmet dependencies hide the dependent task from pending |
| `dependsOn` checking in `queueSingleTask` | ✅ Established | Queue rejected if dependency not approved/merged/closed |
| `parallelizable` runtime semantics on `list_pending` | ✅ Established | `parallelizable: false` tasks block each other per executor when claimed |
| `depBlocked` UI display (detail page) | ✅ Established | `computePrimaryTaskState` shows "Blocked by Dependency" |
| `depBlocked` sidebar badge | ✅ Established | "Waiting on dependency" badge when deps unmet |
| `depBlocked` field in `DesktopTaskListItem` | ✅ Established | Server-side computed, available for sidebar rendering |
| Dependent task auto-unlock after dependency approved | ✅ Established | Next `list_pending` call shows the unlocked task |
| Batch queue: "Queue ready tasks" | ✅ Established | `POST /api/desktop/projects/{id}/queue-ready` |
| Project summary status counts | ✅ Established | readyToQueue, queued, awaitingReview, blockedByDependency, needsAttention, approved |
| Complex dependency graph (multi-level deps) | ⚠️ Minimal | Works linearly but not optimized for deep graphs |
| `parallelizable` auto-scheduling | ❌ Not yet | Only runtime filter; no automatic scheduling optimizer |
| Batch cancel / recovery dashboard | ❌ Not yet | No per-project task management beyond individual actions |

---

## 5. Connected Session / MCP Presence

| Capability | Status | Notes |
|---|---|---|
| Session initialization via external API | ✅ Established | `POST /api/desktop/external/initialize` with clientName, executorId, mode |
| Heartbeat (25s interval, 45s staleness) | ✅ Established | Server marks session stale after 45s of no heartbeat |
| Connected client list | ✅ Established | `GET /api/desktop/external/clients` |
| Per-executor client status (online / stale) | ✅ Established | `resolveConnectedClients` returns per-client status |
| Token-based auth for external API | ✅ Established | Bearer token in `.scopeguard/config/external-api-token.json` |
| Project header shows per-executor status | ✅ Established | Grouped by executor, best status (online > stale) |
| Session discovery protocol | ✅ Established | `GET /api/desktop/external/discovery` |
| MCP bridge (generic stdio bridge) | ✅ Established | `scripts/scopeguard-mcp-bridge.js` |
| 6 MCP tools (status, list, claim, finish, review, cancel) | ✅ Established | Full tool set for external agent integration |
| `scopeguard_run_once` prompt | ✅ Established | Single-shot execution prompt (see Semantic Notes) |
| Session reconnection / auto-recovery | ❌ Not yet | No automatic reconnect if heartbeat fails |
| Multi-host session management | ❌ Not yet | No cross-host session coordination |

---

## 6. Assignment Lifecycle / Recovery

| Capability | Status | Notes |
|---|---|---|
| Assignment creation (pending) | ✅ Established | `createTaskAssignment` |
| Assignment claim (pending → claimed) | ✅ Established | `claimAssignment` |
| Auto-complete execution assignment on run finish | ✅ Established | `handlePostDesktopExternalRunFinish` auto-completes |
| Assignment complete (claimed → completed) | ✅ Established | `completeAssignment` |
| Assignment cancel (pending/claimed → canceled) | ✅ Established | `cancelAssignment` |
| Cancel resets task to ready | ✅ Established | Task status → "ready", clears latestRunResult/latestReviewSummary |
| Cancel frees parallelizable slot | ✅ Established | Canceled assignments ignored by parallelizable filter |
| Cancel requires task in execution phase | ✅ Established | Rejects if task is `needs_review` / `approved` / `merged` / `closed` |
| Cancel preserves assignment history | ✅ Established | Assignment JSON file retained on disk |
| Cancel button in task detail UI | ✅ Established | "Cancel dispatch" button on queued state |
| `scopeguard_cancel_assignment` MCP tool | ✅ Established | Tool for external agents to cancel |
| Web UI cancel via `handleCancelAssignment` | ✅ Established | Uses `activeExecutionAssignmentId` from task detail |
| Project-level batch cancel ("Cancel active dispatches") | ✅ Established | `POST /api/desktop/projects/{id}/cancel-dispatches`; reuses `cancelAssignment` per assignment |
| Batch cancel resets all tasks to ready | ✅ Established | Task status → "ready", clears summaries; queued/claimed slots all released |
| Batch cancel feedback in UI | ✅ Established | "Canceled N active dispatch(es). Skipped M (reason)." |
| Assignment auto-timeout / stale recovery | ❌ Not yet | No automatic cleanup of orphaned claimed assignments |
| Review assignment cancel | ❌ Not yet | Cancel only applies to execution assignments |

---

## 7. Multi-Executor Routing

| Capability | Status | Notes |
|---|---|---|
| `preferredExecutor` / `assignedExecutor` on task | ✅ Established | Every task carries executor identity |
| Executor resolution from task record | ✅ Established | `resolveEffectiveTaskExecutor` checks assignedExecutor → preferredExecutor |
| `list_pending` filtered by `executorId` | ✅ Established | Only returns assignments matching the requesting executor |
| Claim verifies executor match via session | ✅ Established | Reads session's `executorId` from session record, compares to `assignment.assignedExecutor` |
| Run-start verifies executor match | ✅ Established | Payload `executorId` must match `resolveEffectiveTaskExecutor(task)` |
| Parallelizable filter scoped per executor | ✅ Established | Non-parallel tasks block only same-executor tasks |
| Dispatch ready computed per executor | ✅ Established | `resolveTaskDispatchInfo` matches task executor to connected clients |
| UI shows executor name in queued/no-client states | ✅ Established | Uses `executorDisplayName(executors, id)` |
| Project header shows per-executor status | ✅ Established | "Claude CLI (online), Codex CLI (stale)" |
| Dual-executor isolation verified | ✅ Established | `verify-multi-executor.js` (12 checks, all passed) |
| Multi-executor fairness / load balancing | ❌ Not yet | No automatic distribution across executors |
| Dynamic executor registration | ❌ Not yet | Executor types are currently hardcoded ("codex-cli", "claude-cli") |
| Per-executor queue depth visibility | ❌ Not yet | No UI showing how full each executor's queue is |

---

## 8. Project-Level Batch Queue / Dispatch UX

| Capability | Status | Notes |
|---|---|---|
| "Queue ready tasks" button | ✅ Established | Queues all dispatch-ready tasks in one click |
| Batch queue respects dependsOn | ✅ Established | Skips tasks with unmet dependencies |
| Batch queue respects parallelizable | ✅ Established | Runtime filter applies on `list_pending` |
| Batch queue feedback message | ✅ Established | "Queued N task(s). Skipped M (reason)." |
| Project summary status counts | ✅ Established | readyToQueue, queued, in review, blocked, needs attention, approved |
| Sidebar task list with status badges | ✅ Established | Status + dep badge + review badges per task |
| Sidebar subtitle ("Waiting on dependency", "Ready to queue") | ✅ Established | `buildTaskSubtitle` checks dependsOn |
| Sidebar dep badge uses server-computed `depBlocked` | ✅ Established | Eliminates stale client-side dependency scans |
| `selectTask` refreshes sidebar task list | ✅ Established | Sidebar stays consistent with detail on task navigation |
| Project-level batch cancel ("Cancel active dispatches") | ✅ Established | `POST /api/desktop/projects/{id}/cancel-dispatches` |
| Batch cancel clears all queued/claimed tasks | ✅ Established | All active execution assignments canceled; tasks return to ready |
| Batch cancel feedback | ✅ Established | "Canceled N active dispatch(es)." with sidebar/summary refresh |
| Project-level status dashboard | ⚠️ Minimal | Summary counts exist but no rich dashboard |
| Task reordering / priority drag-drop | ❌ Not yet | Priority is string field only, no ordering UI |

---

## Semantic Notes

### `/scopeguard-run` is single-shot by design

The `scopeguard_run_once` prompt and `.claude/commands/scopeguard-run.md` both
process exactly **one** assignment per invocation. The prompt explicitly says
"Claim exactly one assignment" and "stop immediately" if zero pending or if
claim fails. There is no loop or drain-all instruction.

**Why single-shot:**
- Reliable: the model completes one full cycle (claim → execute → report) without
  losing context or timing out
- Composable: users can run `/scopeguard-run` multiple times
- Observable: each run produces one clear result

**Not supported yet:**
- `/scopeguard-run-all` (batch execution of all pending tasks) does not exist
- If added later, it must be a separate design — not a modification of the existing prompt

### Review actor is now a real review

- Auto-review on run finish is a **precheck / baseline**, not the final judgment
- A real reviewer (external agent or human) must submit judgment via
  `scopeguard_submit_review` or the `/external-review` endpoint
- The `complete` endpoint rejects review assignment completion unless
  `latestReviewSummary.reviewId` starts with `"external-"` (i.e., real judgment submitted)
- Review assignment executor now follows the task's execution executor
  (not hardcoded to "claude-cli")

### `dependsOn` minimum runtime semantics

- Tasks with unmet dependencies are excluded from `list_pending`
- `queueSingleTask` checks dependsOn and returns `DEPENDENCY_NOT_MET`
- Batch queue skips dependency-blocked tasks
- UI shows "Blocked by Dependency" on detail page and "Waiting on dependency" in sidebar
- `depBlocked` is computed server-side and available in both `DesktopTaskDetail` and `DesktopTaskListItem`
- Dependencies are checked against `task.status` being `"approved"`, `"merged"`, or `"closed"`

### `parallelizable` minimum runtime semantics

- `parallelizable: false` means the task modifies shared state and should not run
  concurrently with other non-parallelizable tasks for the same executor
- The filter checks for `claimed` (actively executing) non-parallelizable tasks.
  Pending (unclaimed) tasks do not block each other.
- `parallelizable: true` (or undefined) tasks bypass the filter entirely
- This is a **runtime scheduling constraint**, not a full concurrent scheduler
  or optimization system

### Cancel / recovery boundaries

- Cancel only applies to **execution** assignments (not review)
- Cancel sets assignment status to `"canceled"` (terminal, history preserved)
- Cancel resets task status to `"ready"` and clears `latestRunResult`/`latestReviewSummary`
- Cancel frees the parallelizable slot for other tasks
- Cancel is rejected if the task is already past the execution phase
  (`needs_review`, `approved`, `merged`, `closed`)
- Canceled assignments do not block re-queue (`findTaskAssignment` ignores
  `"canceled"` status)

### Batch cancel / recovery ("Cancel active dispatches")

- Project-level action: cancels ALL active execution assignments (pending + claimed)
  for the current project in one call
- Reuses the same `cancelAssignment` function — no separate cancel logic
- Each task is reset to `ready`; summaries and sidebar are refreshed
- Review assignments, completed/canceled assignments are left untouched
- Result feedback: "Canceled N active dispatch(es). Skipped M (reason)."
- After cancel, all previously queued/claimed tasks can be re-queued

### Multi-executor current boundaries

**Established:**
- Each task has a clear `preferredExecutor` / `assignedExecutor`
- `list_pending` returns only matching assignments per executor
- Claim verifies caller's executor via session record
- Run-start verifies payload executorId
- Parallelizable filter scoped per executor
- UI shows per-executor status and display names

**Not yet supported:**
- Multi-executor fairness / load balancing
- Dynamic executor registration (types are hardcoded)
- Per-executor queue depth visibility in UI
- Cross-executor task reassignment

---

## Explicitly Not Supported (Product Boundaries)

The following capabilities are **not yet supported** and should not be assumed:

| Area | Not supported |
|------|---------------|
| Batch execution | `/scopeguard-run-all` does not exist; no "drain all pending" action |
| Auto-scheduling | No automatic parallelizable scheduler or optimizer |
| Assignment timeout | No auto-recovery for orphaned/stale claimed assignments |
| Review cancel | Review assignments cannot be canceled (execution only) |
| Review retry | No resubmit path after `needs_attention` review |
| Proposal refinement | No multi-turn conversational proposal editing |
| Executor fairness | No load balancing across multiple executors |
| Executor registration | Executor types hardcoded; no dynamic registration API |
| Dashboard | No rich project-level status dashboard (only counts) |
| Complex dep graphs | Linear dependency resolution only; no DAG optimization |
| Session recovery | No auto-reconnect on heartbeat failure |
| Batch requeue / retry | No automated requeue or retry after cancel |
