# V1 Desktop Interaction Contract

Status: accepted interaction decision for [GitHub issue #12](https://github.com/MelorTang/scopeguard/issues/12)
Snapshot: 2026-08-13
Target: Windows 10/11 x64 Desktop; macOS is a development and secondary support platform

## 1. Contract Boundary

This document fixes the V1 Member-facing Desktop behavior strongly enough for
module architecture and specification work. It applies the vocabulary in
`CONTEXT.md` and the accepted ADRs. It does not define storage schemas, IPC
messages, document conversion libraries, or visual pixel values.

The Desktop has one navigation hierarchy and two center modes:

```text
Organization session
`- Workspace
   `- Conversation (permanently bound to one Agent)

Center
|- Conversation Workbench: one to four visible Conversations
`- Artifact Review: one Artifact canvas plus zero or one associated Conversation
```

There is no tab strip, permanent Inspector, general Inbox, Runtime dashboard,
audit product, or duplicate Agent/Task tree. Run status, approvals, failures,
and Handoffs stay in their owning Conversation and are summarized in the
Workspace sidebar.

## 2. Global Shell And Navigation

### 2.1 Sidebar

The left sidebar is the only navigation surface. It contains Workspace
selection, search, the selected Workspace's Conversations, new-Conversation
action, Agent management entry, settings, and Member identity.

- Selecting a visible Conversation focuses its existing pane.
- Selecting a hidden Conversation uses an empty pane slot when available;
  otherwise it replaces the active pane without deleting or stopping the
  replaced Conversation.
- Closing a pane only removes it from the current layout.
- Sidebar rows always expose status by text or icon semantics, not color alone.
- Search returns Workspaces and Conversations. Selecting a result follows the
  same focus/open rule and never creates a duplicate pane.

Creating a Conversation requires a title and one Agent. The Agent is immutable
after creation. The Member chooses an initial supported Model and may accept or
override the Workspace's default Conversation Execution Profile. If no Agent is
available, creation routes to Agent setup rather than creating a partial record.

### 2.2 Center Toolbar

The center toolbar contains the Workspace identity, the `对话` / `成果` mode
switch, one layout entry in Workbench mode, and the Workspace Terminal action.
The layout entry combines visible pane count (`1` through `4`) and arrangement
(`自适应`, `等宽`, `聚焦当前`). It is absent in Artifact Review.

V1 uses the accepted neutral dark appearance. Black and graphite surfaces
carry navigation and workbench UI; light primary buttons are reserved for clear
commands. Semantic colors communicate status only. Artifact pages preserve the
source format's page appearance, normally white for Office and PDF content.

## 3. Conversation Workbench

Each pane owns a stable header, scrollable transcript, transient Run controls,
and Composer. Focusing, opening, closing, or resizing another pane must not
reset transcript scroll, draft text, selected Model, attachments, or execution
profile.

The automatic layout contract is:

| Visible Conversations | Automatic arrangement |
| --- | --- |
| 1 | One full center pane. |
| 2 | Two equal panes. |
| 3 | Three equal panes with pane-local overflow at narrow widths. |
| 4 | Four columns only when the center provides at least 400 px per pane; otherwise a two-by-two matrix. |

The grid may scroll internally to preserve readable pane width, but the Desktop
window must never gain whole-window horizontal scrolling. A Workspace restores
pane count, order, visible Conversation IDs, arrangement, active Conversation,
pane dimensions, transcript positions, and drafts after mode switches and app
restart.

### 3.1 Pane Header

The header shows Conversation title, bound Agent, active Model, and current
state. Its menu provides rename, remove from layout, and destructive deletion.
Deleting a Conversation requires explicit confirmation and never masquerades as
closing a pane.

During an active Run, the primary Run action is stop. Stop changes the visible
state to `stopping` immediately, remains reversible only by starting a later
Run, and reports `termination_unconfirmed` rather than success when process-tree
termination cannot be proven.

### 3.2 Composer

The shared Composer uses this fixed control order:

```text
Message editor
Optional attachment chips
+  | Conversation Execution Profile      Supported Model | Send/Stop
```

- `+` offers upload as a Conversation Attachment or selection of an existing
  Workspace File. A Conversation Attachment is not shared implicitly.
- `Enter` sends and `Shift+Enter` inserts a line break.
- Send is disabled for an empty message and while the same Conversation already
  owns an active Run, except that `waiting_input` enables the answer Composer
  to resume that Run.
- Model selection lists only Models supported by the bound Agent. A change is
  allowed only while no Run is active, applies to the next Run, and leaves a
  visible boundary in the transcript. It never changes Agent identity.
- The execution profile is independent per Conversation. A downgrade applies
  immediately. An upgrade can only result from a Member action.
- Draft text and selected files survive pane replacement, mode switching, and
  ordinary app restart.

## 4. Run State Contract

Only one Run may be active in a Conversation; different Conversations may run
in parallel. The durable transcript is not replaced by status UI or by a
bounded Active Context Projection.

| State | Required interaction |
| --- | --- |
| `ready` | Composer enabled; previous transcript and Artifacts remain visible. |
| `starting` | Stable inline state; prevent duplicate send without clearing the submitted message. |
| `streaming` | Append output without moving other panes; expose stop. |
| `waiting_approval` | Inline approval card in the owning Conversation; unrelated panes remain usable. |
| `waiting_input` | Durable question plus enabled answer Composer in the same Conversation. |
| `stopping` | Disable repeated stop; continue showing the last confirmed output. |
| `completed` | Preserve response; show produced Artifact Versions and next-message Composer. |
| `failed` | Preserve partial output and exact failure category; offer retry from the last safe boundary. |
| `interrupted` | Explain loss of execution ownership after restart or disconnect; never present as completed. |
| `termination_unconfirmed` | Warn that a child process may remain; offer retry of termination and local process guidance. |
| `offline_blocked` | Preserve draft and references; disable server-dependent send until authentication returns. |

Retry creates a new Run in the same Conversation. It must not silently replay a
write, command, Dispatch, or external request whose outcome is unknown. Such a
Run first presents the uncertain operation and requires a Member decision.

## 5. Handoff Contract

### 5.1 Handoff Prompt

An Agent may render a structured, plain-text Handoff Prompt containing source,
background, confirmed facts, requested outcome, constraints, and explicitly
selected Workspace File or Artifact Version references. It is a normal
copyable transcript block with a top-right copy action. Copying does not create
internal state or claim that another Agent received it.

### 5.2 Agent Dispatch

Agent Dispatch targets one existing Conversation in the same Workspace. The
target Agent is already fixed; Dispatch cannot create a Conversation, replace
an Agent, cross a Workspace, share a source transcript, or stage hidden text in
the target Composer.

- The dispatch menu shows only eligible target Conversations and their states.
- A busy target is disabled with an explanation; V1 does not create a hidden
  dispatch queue. The Member may wait or copy the Handoff Prompt manually.
- Only explicitly selected Workspace Files and Artifact Versions may travel.
  Conversation Attachments must first be promoted by the Member.
- On acceptance, source and target transcripts immediately show attribution and
  selected references, and the target Run starts.
- The target Run remains independently stoppable. No separate receipt or audit
  surface is created.

## 6. Artifact Review

Opening an Artifact replaces the center Workbench with a focused review canvas.
It never opens a permanent third column. At most one collapsible Conversation
associated with the Artifact appears on the right.

Artifact Review must provide:

- Artifact identity, producing Conversation and Agent, format, current Version,
  and source location;
- version selection and supported two-Version comparison;
- an explicit `设为当前版本` action that does not overwrite prior Versions;
- preview, revise, export, and external-application fallback states according to
  the document Runtime acceptance contract from issue #9;
- conflict state when the source Workspace File changed after the editable read;
- loading, unsupported, damaged, password-protected, conversion-failed, and
  export-failed states without replacing them with a blank canvas.

Returning to Workbench restores the exact prior pane layout. Other Conversations
continue running while an Artifact is open and report status in the sidebar.
V1 does not open detached Artifact windows.

## 7. Permissions And Approvals

The Composer exposes exactly three Conversation Execution Profiles:
`请求批准`, `自动审批`, and `完全访问`. Their descriptions must distinguish
approval decisions from Windows confinement. Request Approval and Auto Approve
use the same OS-enforced Managed Execution Sandbox; changing the reviewer never
changes the sandbox boundary.

- Request Approval shows operation-specific inline cards in the originating
  Conversation. Each card identifies operation type, resolved target, relevant
  diff or request scope, and the requested sandbox escalation.
- Auto Approve lets the automatic reviewer decide eligible requests inside the
  same sandbox contract. It never converts a denied or unenforceable operation
  into an unsandboxed launch.
- Full Access requires one explicit confirmation when selected for a
  Conversation, then avoids per-action ScopeGuard prompts. It means current OS
  user authority without the Managed Execution Sandbox, not administrator
  elevation.
- Approval expiry, mutation, failure, and cancellation remain inline. V1 does
  not build a general approval Inbox or an approval audit product.

## 8. Workspace Terminal

The terminal is a resizable bottom drawer rooted initially at the Workspace and
opened only by a Member action. It supports multiple terminal tabs and may be
used while either center mode is active.

The terminal is outside Conversations, Agents, the Native Harness, and all
Conversation Execution Profiles. A compact persistent disclosure states that
it uses the current OS account and is not confined to the Workspace. ScopeGuard
does not parse terminal output, restore shell sessions, inject enterprise
credentials, or dispatch tasks into it.

Closing an idle tab closes directly. Closing a tab with a running foreground
process requires one confirmation and terminates the owned process tree.
Desktop shutdown attempts the same termination and reports unconfirmed cleanup
on the next launch. Workspace file monitoring invalidates stale file hashes
after terminal changes.

## 9. Online, Offline, And Session States

First use requires a successful enterprise login. After the local profile has
been bound to the Organization, Member, and current OS account, the Member may
unlock local work while the enterprise server is unavailable.

Offline mode must be explicit but non-blocking:

- local Conversation Transcripts, Workspace Context, Workspace Files, cached
  previews, Artifacts, drafts, and terminal remain available;
- Model execution and Organization Knowledge are disabled, never shown as empty
  or healthy;
- local personal or Workspace `stdio` MCP may remain available when it does not
  require the enterprise server;
- remote MCP and server-governed configuration are unavailable;
- reconnect reauthenticates and refreshes Organization configuration without
  replacing local Workspace state.

An interrupted Model stream preserves partial output and offers a deliberate
retry after reconnect. ScopeGuard never auto-resubmits a Run with possible side
effects merely because connectivity returned.

## 10. Failure And Recovery Rules

| Failure | Required recovery behavior |
| --- | --- |
| Workspace folder missing or moved | Keep metadata and transcript; offer locate/relink; do not create an empty replacement folder silently. |
| Workspace file changed concurrently | Stop write, show both identities/hashes, and offer reread, save separate Version, or abandon. Never silently merge or overwrite. |
| Provider unavailable or Model removed | Keep the Conversation and draft; explain configuration state and allow another supported Model when no Run is active. |
| Organization Knowledge unavailable | Mark retrieval unavailable or partial; never project it as zero results or confirmed absence. |
| MCP connection fails | Identify the connection and phase; keep unrelated tools and local work usable. |
| Artifact conversion fails | Preserve source and prior Versions; offer retry or external application fallback. |
| Local database locked, unreadable, or migration fails | Fail closed with retry and diagnostic location; never open an apparently empty healthy Workspace. |
| Desktop restarts during a Run | Reconcile persisted events; mark local orphaned Runs interrupted; never fabricate completion. |
| Approval target mutates | Invalidate approval and show the changed scope before another decision. |

Loading placeholders preserve pane, Composer, toolbar, and sidebar dimensions.
Errors remain close to the owning object. Toasts are reserved for transient
confirmation such as copy success, not durable failures or questions.

## 11. Accessibility And Window Acceptance

- Every icon-only action has an accessible name and a tooltip when unfamiliar.
- Keyboard focus is visible; popovers and dialogs return focus to their trigger.
- Escape closes non-destructive menus and dialogs. Destructive operations retain
  explicit confirmation.
- Text and icon semantics accompany status color.
- Dynamic titles, Agent names, Model names, and errors truncate or wrap without
  moving fixed controls.
- Reduced-motion preference removes nonessential animation.

Acceptance uses real Windows Desktop builds at 100% and 150% scaling:

| Window | Gate |
| --- | --- |
| 1024 x 720 | Composer and pane headers remain reachable; internal pane overflow does not become window overflow. |
| 1366 x 768 | Three panes are usable; four automatic panes form a two-by-two matrix. |
| 1600 x 900 | Three full-height panes remain readable. |
| 1920 x 1080 | Four columns each provide at least 400 px. |

The Renderer Web preview is evidence only for layout and interaction behavior.
It cannot prove filesystem, credential, Provider, persistence, process, MCP, or
Windows execution guarantees.

## 12. Release-Critical Flows

V1 interaction acceptance requires all of these end-to-end flows:

1. Login, create/open a Workspace, create a Conversation with an Agent, send,
   stream, stop, restart the Desktop, and resume.
2. Keep three Conversations active independently, open a fourth in automatic
   two-by-two layout, and restore the layout after Artifact Review.
3. Add a Conversation Attachment, select a Workspace File, change to another
   supported Model, and apply each execution profile at its allowed boundary.
4. Copy a Handoff Prompt and Dispatch to an eligible existing Conversation;
   verify busy-target, source attribution, selected references, and stop.
5. Open, compare, revise, version, export, conflict, and externally fall back for
   representative Office/PDF Artifacts as bounded by issue #9.
6. Lose enterprise connectivity, unlock local work, observe server-dependent
   capabilities as unavailable, reconnect, and retry without duplicate effects.
7. Open multiple terminal tabs, modify a Workspace file, invalidate its version
   hash, close the process tree, and recover an unconfirmed termination state.

## 13. Explicit V1 Exclusions

- Automatic Agent or Model routing.
- External Harness integration or managed Codex/Kimi CLI sessions.
- General Inbox, audit trail, receipt center, or permanent Inspector.
- First-party WeCom or other business-system automation.
- Detached Artifact windows, full Office editing, or silent format degradation.
- Multi-device Workspace synchronization, unattended Agents, schedules, and
  public SaaS behavior.

This contract can feed target architecture now. Architecture and implementation
tickets remain blocked on the Managed Execution Sandbox prototype and the
document Runtime acceptance boundary in issues #8 and #9.
