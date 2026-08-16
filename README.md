# ScopeGuard

Local-first multi-agent desktop workspace for general knowledge work.

[简体中文](./README.zh-CN.md)

ScopeGuard keeps several persistent conversations open inside one Workspace so
different Agents can work in parallel without sharing hidden context. A
conversation is bound to its Agent when it is created; the user may switch
between models supported by that Agent without changing the conversation's
execution harness.

![ScopeGuard multi-agent desktop workspace](./docs/assets/scopeguard-workspace.png)

Electron is the product surface. The Web build is an in-memory renderer preview
for UI iteration and has no filesystem, command, provider, or secret capability.

## Current Product Core

- Workspaces with an optional local folder.
- Multiple persistent conversations displayed in one to four parallel panes.
- OpenAI-compatible and Anthropic-compatible Provider configuration.
- One native ScopeGuard Agent per conversation, with model selection at run time.
- Independent Runs, cancellation, retry, approval, and user-input continuation.
- Request approval, automatic approval, and full-access permission profiles.
- Root-confined local file tools and managed command execution.
- Explicit Workspace Context for user-controlled shared information between
  conversations; conversation transcripts remain isolated.
- SQLite recovery for conversations, runs, usage, layout, and drafts.

ScopeGuard does not manage external Agent CLIs or persistent remote workers.
Advanced CLIs can be opened in a separate terminal, outside ScopeGuard's run
lifecycle. Enterprise knowledge bases are separate systems connected through
MCP; ScopeGuard does not embed their RAG pipeline.

The current milestone is single-user and local-first. It does not provide team
accounts, cloud sync, model hosting, a VPN, or automatic cross-Agent routing.

## Run From Source

Requires Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

Renderer-only preview:

```bash
pnpm dev:web
```

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
packages/domain           Core entities and state transitions
packages/application      Conversation and Run use cases
packages/agent-runtime    Native model and tool loop
packages/provider-adapters
packages/tool-runtime     Root-confined file and managed command tools
packages/storage-sqlite   Fresh V1 SQLite schema and recovery repositories
packages/ipc-contracts    Runtime-validated desktop IPC contracts
```

V1 uses the schema identity `scopeguard-v1-core`. Pre-V1 development databases
are rejected with an explicit error instead of being migrated or treated as an
empty profile. Historical tags preserve the former implementation.

See [V2_ARCHITECTURE.md](./docs/V2_ARCHITECTURE.md),
[SECURITY.md](./docs/SECURITY.md), and
[VERIFICATION.md](./docs/VERIFICATION.md).
