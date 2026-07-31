# Changelog

## Unreleased - Multi-Agent Desktop MVP

### Changed

- Repositioned ScopeGuard as a desktop-first workspace for personal knowledge
  work with multiple persistent, role-specific Agents.
- Replaced the Project/Thread-centric product model with Workspace, Agent
  Definition/Instance, Task, Assignment, Artifact, Handoff, Inbox, Schedule,
  ContextRevision, RuntimeNode, and Run boundaries.
- Made local folders optional Workspace resources instead of product identity.
- Rebuilt the Chinese interface around Workspace-scoped Tasks annotated by
  Agent, 1-4 supervision panes, and one inspector for Inbox, Artifacts,
  Context, and activity.
- Kept the Web build as a capability-free Renderer preview; Electron remains
  the product surface and privileged execution boundary.

### Added

- OpenAI-compatible and Anthropic-compatible streaming providers.
- Encrypted provider secret vault backed by Electron `safeStorage`.
- An authenticated persistent remote Runtime with idempotent submission,
  event-cursor reconnection, independent cancellation, and Artifact import.
- Remote Runs that continue after Desktop exits and reconcile when it reopens.
- SQLite schema v6 with forward migration from legacy Project, AgentProfile,
  Thread, Run, approval, and Context records.
- Concurrent independent Threads and Runs with isolated transcripts.
- Explicit immutable Context revisions, source-aware Handoffs, and per-Run
  Context usage provenance.
- Versioned text, Markdown, report, and written-file Artifacts attributed to
  Workspace, Task, Assignment, Agent, and Run.
- A unified Inbox for approval, failure, completion, required input, and
  Runtime-offline attention.
- Agent-requested user input that pauses and resumes the same local Run.
- Workspace-confined file tools and approval-gated writes and commands.
- Optional local CLI Agent process adapter.
- Restart recovery for canonical work state, partial output, layout, panes,
  drafts, Context, Inbox, and Artifacts.

### Removed

- Legacy `scopeguard` and `agentboard` task CLIs.
- Task scheduler, worktree runner, queue/claim server, MCP bridge, and related
  fixtures and documentation.

### Deferred

- Multi-user accounts, organizations, RBAC/SSO, billing, and cloud sync.
- Production Runtime hosting, Runtime secret escrow across process restart,
  message channels, mobile clients, and plugin distribution.
- Autonomous Schedule execution UI and signed/notarized installers.

Historical v0.4 and orchestration-MVP code remain available from the
`v0.4.1` and `v0.5.0-orchestration-mvp` tags.
