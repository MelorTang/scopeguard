# ScopeGuard Desktop UI

## Information Architecture

```text
Sidebar
  Workspace switcher
  Agent list
  Task list grouped by Agent
  Inbox entry

Workspace toolbar
  Active Workspace and task status
  1-4 pane control
  Inspector and settings controls

Workbench
  One to four independent Agent task panes

Inspector
  Activity | Artifacts | Context
```

The sidebar is the only navigation surface. There is no duplicate tab strip.
Selecting a Task assigns it to the active pane; panes are supervision layout,
not a second hierarchy. Closing or replacing a pane never stops its Run.

## Primary Workflow

1. Create a named Workspace, optionally opening a local folder.
2. Configure a Provider and, when needed, a remote Runtime.
3. Create role-based Agents from templates such as 调研、核验 and 文档.
4. Create or open a Task under an Agent and run it in an isolated pane.
5. Inspect its Artifact and explicitly publish approved content to Context.
6. Send a Handoff to another Agent and run that Agent's Task.
7. Resolve approvals, failures, completion notices, and Runtime outages from Inbox.

## Product Language

- User-facing identity is `工作区 / Agent / 任务 / 成果 / 上下文 / 交接 / 运行节点`.
- `Project`, `AgentProfile`, and raw Thread IDs are implementation/migration terms only.
- Default mode uses task language. Professional mode may reveal Provider,
  model, Runtime, CLI, tool call, and raw activity details.

## Required States

- No Workspace: one primary action to create a Workspace and a secondary action
  to open a local folder.
- Empty Workspace: create an Agent without requiring a directory.
- No Provider: Agent creation routes to Provider setup.
- Running: stable stream area, explicit stop action, unrelated panes remain usable.
- Waiting approval: non-blocking Inbox and in-pane decision controls.
- Waiting input: durable Inbox question, task locator, and enabled composer in
  the original pane; submitting an answer resumes the same Run.
- Runtime offline: node status plus an actionable, durable Inbox item.
- Interrupted or failed: partial output remains visible with retry.
- Completed: Artifact appears with Agent, Task, Run, time, type, and version.
- Context: current immutable revision and provenance are visible before publish.
- Handoff: pending and accepted states identify source and destination Agent.
- Loading and empty lists preserve layout dimensions and do not shift controls.

## Capability-sensitive Controls

- A Workspace without a local folder cannot select Local CLI.
- File and command policy controls appear only for a local native Runtime with
  a local folder. Application policy independently enforces the same restriction.
- A remote Runtime exposes only capabilities reported by its health endpoint.
- Provider API key and Runtime token fields clear after save/close and never
  display stored values.

## Desktop Layout Acceptance

| Window | Required behavior |
| --- | --- |
| 1024 x 720 | One pane; compact sidebar; inspector scroll/overlay; composer reachable |
| 1280 x 800 | Up to two usable panes; no whole-window horizontal scroll |
| 1440 x 900 | Two panes plus inspector without overlap |
| 1600 x 900 | Up to three panes with inspector closed |
| 1920 x 1080 | Four panes, each at least 400 px |

When minimum pane width is unavailable, ScopeGuard reduces the effective pane
count rather than shrinking text or adding whole-window horizontal scrolling.
Pane headers, approval controls, composer, Artifact actions, and Context/Handoff
controls remain reachable at 720 px height and 150% scaling.

## Accessibility

- All icon-only controls have accessible names and tooltips where meaning is not obvious.
- Modal focus is trapped and restored; Escape closes non-destructive dialogs.
- Keyboard focus is visible across sidebar, panes, forms, approvals, and inspector.
- Status is conveyed by text/icon semantics, not color alone.
- `prefers-reduced-motion` disables non-essential transitions and spinners retain text status.
- Dynamic Agent names, Task titles, model names, and errors wrap or truncate without overlap.

## Web Preview Boundary

The Web preview exists only for responsive and interaction iteration. Its mock
bridge may simulate Task completion, Inbox items, Artifacts, Context publishing,
and Handoffs, but it is never evidence for filesystem, secret, Provider,
Runtime, persistence, or Electron security behavior.
