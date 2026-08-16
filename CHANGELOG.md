# Changelog

## Unreleased - Conversation Core

### Changed

- Narrowed the desktop product to Workspace, native Agent, persistent
  conversation, Run, Provider, tool approval, and explicit Project Context.
- Made each conversation's Agent immutable while keeping its model override and
  execution profile configurable; every Run persists the effective snapshot.
- Kept multiple conversations independently runnable and visible in one to four
  panes.
- Preserved request manifests, usage accounting, partial output, user-input
  continuation, and unknown-effect recovery inside the conversation lifecycle.
- Kept Web as a capability-free Renderer preview; Electron remains the product
  and privileged execution boundary.

### Removed

- Persistent remote Runtime service, HTTP client, protocol, and desktop
  reconciliation path.
- Managed Local CLI Agent package and application orchestration path.
- Runtime node, Agent Definition/Instance, Task/Assignment, Artifact, Handoff,
  Schedule, and Inbox use cases from the desktop application core.
- Side effects that mirrored conversation Runs into the retired control plane.

### Compatibility

- SQLite retains legacy tables and forward migrations so existing local data is
  not destroyed. Legacy non-terminal Runs are interrupted on startup.
- Domain/storage compatibility types and the Web preview fixture remain until a
  later migration can remove them without data loss or blocking UI iteration.
- Historical releases remain available from the `v0.4.1` and
  `v0.5.0-orchestration-mvp` tags.

### Deferred

- Multi-user identity and authorization, cloud synchronization, enterprise MCP
  policy, message channels, installer distribution, and auto-update.
- External Agent CLIs remain user-operated terminal sessions outside
  ScopeGuard's Run lifecycle.
