# ScopeGuard

Desktop workspace for running multiple independent AI agents against the same
local project.

[简体中文](./README.zh-CN.md)

ScopeGuard keeps each Agent Thread isolated while giving the user an explicit,
versioned Project Context for decisions that should be shared. Model inference
can use a directly reachable provider or a company relay by configuring its
protocol, Base URL, API key, and model.

The production surface is Electron. The Web build is only a renderer preview
and never receives filesystem, command, provider, or secret capabilities.

## Current MVP

- Open a local folder as a Project.
- Configure and test OpenAI-compatible or Anthropic-compatible endpoints.
- Create multiple independent Agent Threads under one Project.
- Keep 1-4 Threads open in tabs and split panes.
- Stream multiple Runs concurrently and stop or retry them independently.
- Read and write Project files with root confinement.
- Require explicit approval before command execution by default.
- Inspect tool activity and publish immutable Project Context revisions.
- Restore Projects, Threads, messages, layout, drafts, and interrupted Runs.
- Clear provider key input after save or close; saved keys are encrypted outside
  SQLite and are never returned to the renderer.
- Optionally run a local CLI Agent through a constrained process adapter.

ScopeGuard does not provide a VPN, model hosting, relay deployment, team
accounts, cloud synchronization, or automatic cross-Thread memory.

## Run From Source

Prerequisites: Node.js 22 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm dev
```

`pnpm dev` builds the Electron main and Agent host processes, starts the Vite
renderer, and opens the desktop application.

For renderer-only UI work:

```bash
pnpm dev:web
```

The Web preview uses an in-memory mock bridge. It cannot access local files,
run commands, persist secrets, or call a model provider.

## Verify

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

For deterministic provider testing:

```bash
pnpm smoke:provider
```

Then configure `http://127.0.0.1:47821/v1` as an OpenAI-compatible endpoint
with any non-empty test key and model.

## Architecture

```text
apps/desktop              Electron main, preload, renderer, Agent host
packages/domain           Entities, policies, and state transitions
packages/application      Use cases and runtime orchestration
packages/agent-runtime    Native model and tool loop
packages/provider-adapters
packages/tool-runtime
packages/storage-sqlite
packages/cli-runtime      Optional local CLI process adapter
packages/ipc-contracts
```

See [V2_ARCHITECTURE.md](./docs/V2_ARCHITECTURE.md) and
[V2_UI_SPEC.md](./docs/V2_UI_SPEC.md). The complete release gate is in
[VERIFICATION.md](./docs/VERIFICATION.md).

## Security Boundary

- Electron renderer sandboxing and context isolation are enabled.
- Preload exposes an explicit typed API, not generic IPC.
- IPC calls validate both sender and payload.
- The Agent host is the only SQLite writer.
- Provider secrets are encrypted through Electron `safeStorage` and referenced
  by opaque IDs in SQLite.
- File tools resolve real paths and reject access outside the Project root.
- Command execution never uses shell string interpolation and follows each
  Agent Profile's permission policy.

This is a local desktop security boundary, not a container sandbox. Only open
Projects and approve commands that you trust.

See [SECURITY.md](./docs/SECURITY.md) for the full trust model.

## Migration

The v0.4 task queue, claim server, MCP bridge, and static Web UI were removed
because they model a different product. See
[V0.4_TO_DESKTOP_V2.md](./docs/V0.4_TO_DESKTOP_V2.md).
