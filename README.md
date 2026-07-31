# ScopeGuard

Desktop multi-agent workspace for personal knowledge work.

[简体中文](./README.zh-CN.md)

ScopeGuard lets one user run several persistent, role-specific Agents inside a
Workspace. Agent conversations are isolated by default. Only an explicitly
published `ContextRevision` or `Handoff` crosses Agent boundaries, with
provenance back to the Agent, Task, Run, and Artifact.

![ScopeGuard multi-agent desktop workspace](./docs/assets/scopeguard-workspace.png)

Electron is the product surface. The Web build is an in-memory renderer preview
and has no filesystem, command, provider, remote-runtime, or secret capability.

## First-stage MVP

- Workspaces with an optional local folder.
- OpenAI-compatible and Anthropic-compatible Provider configuration.
- Local and authenticated persistent remote Runtime nodes.
- Persistent Agent definitions and Workspace-bound Agent instances.
- Task/Assignment work tracking, isolated Threads, and immutable Run snapshots.
- Two or more concurrent Runs with independent stop and retry behavior.
- Traceable text, Markdown, report, and written-file Artifacts with explicit
  Context publishing and Agent Handoffs.
- A unified Inbox for approvals, failures, completions, input, and offline Runtimes.
- An Agent can pause its current local Run for required user input and resume
  that same Run from the original conversation.
- Root-confined local file tools and approval-gated writes and commands.
- Remote Runs that continue after Desktop exits and reconcile on restart.
- SQLite recovery for product state plus local layout and draft restoration.

ScopeGuard does not provide a VPN, model hosting, relay deployment, team
accounts, cloud sync, or implicit cross-Agent memory. This milestone is
single-user and team-ready, not a multi-user collaboration service.

## Run from source

Requires Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

Renderer-only preview:

```bash
pnpm dev:web
```

## Remote Runtime

```bash
pnpm runtime:build
SCOPEGUARD_RUNTIME_TOKEN='replace-with-a-long-random-token' \
SCOPEGUARD_RUNTIME_HOST='127.0.0.1' \
SCOPEGUARD_RUNTIME_PORT='8787' \
SCOPEGUARD_RUNTIME_DB="$HOME/.scopeguard-runtime/runtime.sqlite" \
pnpm runtime:start
```

Loopback HTTP is accepted for local testing. Non-loopback Runtime URLs must use
HTTPS. See [VERIFICATION.md](./docs/VERIFICATION.md) for the full desktop and
remote continuation gate.

## Verify

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Run `pnpm smoke:provider` for a deterministic local Provider at
`http://127.0.0.1:47821/v1`.

## Packages

```text
apps/desktop              Electron main, preload, renderer, and Agent host
packages/domain           Product entities and state transitions
packages/application      Use cases and local/remote Run orchestration
packages/agent-runtime    Native model and tool loop
packages/provider-adapters
packages/tool-runtime
packages/storage-sqlite   SQLite schema v6 and forward migrations
packages/cli-runtime      Optional local CLI process adapter
packages/remote-runtime   Persistent remote job service and HTTP client
packages/ipc-contracts    Runtime-validated desktop IPC contracts
```

See [V2_ARCHITECTURE.md](./docs/V2_ARCHITECTURE.md),
[V2_UI_SPEC.md](./docs/V2_UI_SPEC.md), and
[SECURITY.md](./docs/SECURITY.md).
