# Changelog

## Unreleased - Desktop v2

### Changed

- Rebuilt ScopeGuard as an Electron-first multi-Agent workspace.
- Replaced task, queue, claim, and review orchestration with Project,
  AgentProfile, Thread, Run, ToolApproval, and ContextRevision domains.
- Replaced the static Web application and local privileged HTTP server with a
  sandboxed renderer, explicit preload API, and supervised Agent host.
- Made the Web build a capability-free renderer preview.

### Added

- OpenAI-compatible and Anthropic-compatible streaming providers.
- Encrypted provider secret vault backed by Electron `safeStorage`.
- SQLite persistence with checkpointed partial-output and interrupted Run
  recovery after graceful or unclean exits.
- Concurrent independent Threads, tabs, and 1-4 pane layouts.
- Project-confined file tools and approval-gated command execution.
- Explicit immutable shared Project Context revisions.
- Optional local CLI Agent process adapter.

### Removed

- Legacy `scopeguard` and `agentboard` task CLIs.
- Task scheduler, worktree runner, queue/claim server, MCP bridge, and related
  fixtures and documentation.

Historical v0.4 changes remain available from the `v0.4.1` tag.
