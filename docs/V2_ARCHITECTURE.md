# ScopeGuard v2 Architecture

## Product Boundary

ScopeGuard is a desktop-first multi-agent workspace. It runs agent loops and
tools locally, while model inference is supplied by a configured direct or
relay endpoint.

ScopeGuard does not provide VPN access, relay deployment, model hosting,
multi-user identity, or cloud synchronization. A relay URL is treated exactly
like any other provider base URL.

The production surface is Electron. The browser build is a renderer preview
with a mock bridge and has no filesystem, secret, command, or model access.

## Core Invariants

- A `Project` points to one normalized local directory, which does not need to
  be a Git repository.
- An `AgentProfile` is reusable configuration, not a running agent.
- A `Thread` owns an isolated conversation.
- A `Run` snapshots its provider, model, tool policy, instructions, and project
  context revision when it starts.
- One Thread can have at most one non-terminal Run. Different Threads can run
  concurrently.
- Closing a tab or removing a pane never stops its Run.
- Threads never read each other's transcript implicitly.
- Shared project context changes only through an explicit immutable
  `ContextRevision`.
- API key input is transient renderer state and clears after save or close.
  Saved keys are never returned to the renderer or written to SQLite, run
  events, or logs.

## Modules

```text
packages/domain
  Pure entities, value objects, state transitions, and invariants.

packages/application
  Use cases and ports for projects, providers, threads, runs, approvals,
  and context revisions.

packages/agent-runtime
  Native model/tool loop, prompt assembly, cancellation, and recovery.

packages/provider-adapters
  OpenAI-compatible and Anthropic-compatible transport adapters.

packages/tool-runtime
  Tool registry, path confinement, permission evaluation, execution, and
  output limits.

packages/storage-sqlite
  Repositories, transactions, schema migrations, and event persistence.

packages/cli-runtime
  Optional Local CLI process adapter with argument placeholders, bounded
  output, minimal environment inheritance, and process-tree cancellation.

packages/ipc-contracts
  Runtime-validated commands, DTOs, and events shared by Electron processes.

apps/desktop
  Electron main, preload, renderer, and agent-host utility process.
```

Dependencies point inward toward `domain` and `application`. The native agent
runtime receives provider and tool implementations through ports. It does not
import a concrete transport, database, Electron API, or CLI runner.

## Process Ownership

| Process | Owns |
| --- | --- |
| Electron main | Windows, directory picker, navigation policy, SecretVault, worker supervision, IPC sender validation |
| Preload | A minimal typed API; no generic invoke and no Node objects |
| Renderer | Project tree, tabs, split layout, conversations, approvals, settings, and drafts |
| Agent host | The only SQLite writer, application use cases, provider requests, tools, PTY adapters, and per-Run AbortControllers |

The main process resolves a secret reference and transfers the secret to the
agent host only for the duration of a provider request. Streaming output is
checkpointed to a bounded SQLite journal. A worker crash restores the latest
checkpoint as an interrupted message and marks all persisted non-terminal Runs
as interrupted before the worker is restarted. Both tool commands and optional
CLI Agents are terminated as process trees before a graceful Agent host
shutdown completes.

Project registration is a main-process capability. A renderer can add only the
canonical directory returned by its immediately preceding native directory
picker; the one-time authorization is bound to that WebContents and cannot be
replayed.

SQLite schema migrations are sequential and reject databases created by a
newer application. Schema v2 removes legacy plaintext custom Provider headers
and CLI environment values. Schema v3 adds the bounded partial-output recovery
journal.

## Run State

```text
queued -> preparing -> running <-> waiting-approval
queued|preparing|running|waiting-approval -> cancelling -> cancelled
preparing|running -> completed|failed
any non-terminal state -> interrupted
```

Tool calls use `proposed -> awaiting-approval -> running ->
succeeded|failed`. A pending call may become `denied`; a running call may
become `cancelled`.

## First Vertical Slice

The first usable slice is complete when:

1. A user saves and tests an OpenAI-compatible base URL, API key, and model.
2. A local Project contains two native Agent Threads.
3. Both Threads stream concurrently, and cancelling one does not affect the
   other.
4. `read_file` is confined to the Project root, including symlink checks.
5. `write_file` and `run_command` wait for an allow-once or deny decision
   before changing local state.
6. Thread A does not affect Thread B until a ContextRevision is explicitly
   published and used by B's next Run.
7. Restart restores Projects, Threads, messages, layout, and context. Any
   unfinished Run is shown as interrupted.
8. Deterministic provider tests, storage tests, Electron smoke, and desktop
   Playwright flows pass.

## Deferred

The first release excludes custom Provider headers, persisted CLI environment
variables, team accounts, SSO, automatic agent orchestration, message channels,
cloud sync, scheduled jobs, skill marketplaces, automatic cross-thread memory,
container sandboxes, browser automation, Computer Use, automatic worktrees or
pull requests, and production Web/mobile clients.
