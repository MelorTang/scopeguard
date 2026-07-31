# ScopeGuard First-Stage Gap Analysis

## Target

The first-stage product is a desktop control plane for one person managing a
small team of persistent Agents. Work can run locally or on a durable remote
Runtime. Conversations remain isolated; only explicit, attributable Context
revisions and Handoffs cross Agent boundaries.

## Baseline Reused

The rebuild retained the reliable v2 foundations rather than starting another
parallel application:

- sandboxed Electron Renderer, typed/validated IPC, supervised Agent host, and encrypted SecretVault.
- OpenAI-compatible and Anthropic-compatible Provider adapters.
- native and optional Local CLI execution with independent cancellation.
- project-root file confinement, command approval, partial-output recovery, and SQLite migration framework.
- persisted multi-pane desktop layout and Chinese operational UI.

## Gap Closure

| Area | Previous limitation | First-stage implementation |
| --- | --- | --- |
| Workspace | Project required a local path | Workspace identity is independent; `localRootPath` is optional |
| Agent | Profile belonged to one Project | Definition plus Workspace/Runtime-bound Instance |
| Work | Thread doubled as work unit | Task and Assignment own intent/status; Thread owns isolated history |
| Output | Assistant messages only | Versioned Artifact with Agent/Task/Run provenance and preview |
| Sharing | Project context had partial provenance | Immutable ContextRevision with source graph and per-Run usage |
| Collaboration | No durable Agent transfer | Explicit Handoff with target Agent, Context, source Run, and state |
| Attention | Approval was the only queue | Inbox covers approval, failure, completion, input, and Runtime offline |
| Runtime | Execution tied to Desktop host | Local/remote Runtime abstraction and persisted remote Run bindings |
| Recovery | All active Runs became interrupted | Remote-owned Runs survive Desktop exit and reconcile by event cursor |
| Automation | No canonical object | Schedule model, persistence, application use case, and IPC contract |
| UI | Project/Thread tabs duplicated navigation | Workspace -> Agent -> Task sidebar plus 1-4 supervision panes |

## Compatibility Debt Kept Intentionally

The execution engine still uses legacy `Project`, `AgentProfile`, and `Thread`
records as internal adapters. Creating a Workspace also creates a same-ID
compatibility Project. A no-folder Workspace uses an internal sentinel path,
but application policy never exposes it to prompts or tools. New UI and domain
contracts use canonical terminology.

Removing this adapter before first-stage validation would increase migration
risk without changing user behavior. It is a second-stage internal cleanup,
with schema migration required before deletion.

## Remaining Non-blocking Work

- Schedule execution and management UI; only the durable contract exists now.
- Remote secret escrow and recovery across a Runtime process restart.
- Rich file/binary Artifact viewers beyond text/Markdown/report preview.
- Signed installers, auto-update, crash reporting, and Windows/Linux packaging.
- Multi-user accounts, organization administration, RBAC/SSO, billing, team
  secrets, cloud synchronization, message channels, and mobile clients.

These items do not replace or weaken the first-stage acceptance gate in
[VERIFICATION.md](./VERIFICATION.md). Any failed core gate remains a blocker,
not a deferred feature.
