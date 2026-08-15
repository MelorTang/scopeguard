# ScopeGuard First-Stage Architecture

## Product Boundary

ScopeGuard is a desktop-first control plane for one person coordinating several
persistent AI Agents. It targets non-coding knowledge work as well as local
project work. Model inference comes from a directly reachable Provider or a
user-supplied relay URL; execution can run in the local Agent host or an
authenticated, persistent remote Runtime.

Electron is the production surface. The Web build is an in-memory Renderer
preview and deliberately has no filesystem, process, Provider, Runtime, SQLite,
or SecretVault access.

First stage excludes multi-user identity, organizations, RBAC/SSO, billing,
team secret custody, mobile clients, message-channel adapters, and implicit
autonomous cross-Agent memory.

## Canonical Model

```text
Workspace
  ├─ optional localRootPath
  ├─ AgentInstance ── AgentDefinition ── ProviderProfile
  │        └────────── RuntimeNode
  ├─ Task ── Assignment ── Thread ── Run
  │                            └────── ContextRevisionUse
  ├─ Artifact
  ├─ ContextRevision
  ├─ Handoff
  ├─ InboxItem
  └─ Schedule
```

- `Workspace` is the product boundary. Its local folder is optional.
- `AgentDefinition` owns reusable instructions, Provider/model selection, and
  tool policy. `AgentInstance` binds that definition to a Workspace and Runtime.
- `Task` owns user intent and status. `Assignment` records which Agent handles
  the work. `Thread` is isolated interaction history; it is not shared memory.
- `Run` is one immutable execution snapshot. Different Threads may run
  concurrently; one Thread has at most one non-terminal Run.
- `Artifact` is a versioned result with Workspace, Task, Assignment, Run, and
  Agent provenance.
- `ContextRevision` is immutable, scoped, explicitly published, and records its
  source Thread, Run, Agent, Artifact, and publisher. Every consuming Run is
  recorded by `ContextRevisionUse`.
- `Handoff` points from one Agent to another through a specific ContextRevision
  and optional source Run. It is accepted only when the destination Agent next runs.
- `InboxItem` is the durable attention queue for approvals, failures,
  completions, required input, and offline Runtimes.
- `Schedule` is persisted as a first-stage domain boundary; autonomous schedule
  execution remains deferred.

Legacy `Project`, `AgentProfile`, and `Thread` APIs remain only as an execution
compatibility adapter while the canonical UI and persistence use Workspace,
Agent, and Task terminology.

## Isolation Invariants

- A Run receives its own Thread transcript and the explicitly selected
  ContextRevision. It never receives another Agent's transcript.
- Publishing or handing off validates that Workspace, Task, Thread, Run,
  Agent, and Artifact provenance agree. Forged same-Workspace attribution is rejected.
- A pending Handoff does not inject text by itself. Its referenced context is
  already explicit, and acceptance is recorded when the target Agent runs.
- Closing a pane never cancels work. Cancelling one Run never cancels another.
- Unknown or interrupted state is never projected as completed.

## Runtime Boundary

`RuntimeNode` advertises native-Agent, CLI, file-tool, command-tool, and
persistent-Run capabilities.

### Local Runtime

The Electron Agent host owns application use cases, Provider calls, tools,
SQLite writes, and per-Run cancellation. A Workspace without `localRootPath`
receives no local tools. Local CLI Agents additionally require a local folder
and cannot bind to a remote Runtime.

Native local Agents always receive the non-side-effecting `request_user_input`
control tool. It moves the Run, Task, and Assignment to `waiting-input`, creates
a durable Inbox item, and waits without starting another Run. A reply appended
to the same Thread resolves the Inbox item and resumes the same provider loop.
Successful `write_file` results also create a file Artifact from the persisted
tool arguments, after path and provenance checks.

Every Conversation has an immutable execution profile. Request Approval forces
mutating tools through user review; Auto Approve skips review; both route
`run_command` through the same Windows LPAC Managed Execution adapter. Full
Access routes to a current-user adapter. Bounded adapter unavailability never
falls back to Full Access. Execution progress is a typed Run event and output
chunks are streamed without persisting every chunk in SQLite.

Electron Main owns the Desktop Execution Broker. Agent Host sends typed private
request/event/response/cancel messages over its utility-process channel. The
Windows adapter uses a registered Workspace ID, installed Provisioner service,
durable current-user Profile intent, parent-monitoring outer Job, LPAC launcher
inner Job, and a fixed Node/CMD worker. See `docs/MANAGED_EXECUTION.md`.

### Remote Runtime

The remote Runtime exposes a versioned Bearer-authenticated HTTP API for
health, idempotent submission, cursor-based event polling, cancellation, and
Artifact retrieval. It stores jobs, events, and Artifacts in its own SQLite
database. Submitted Provider credentials exist only in the running process and
are not stored in that database.

Desktop persists `RemoteRunBinding(runId, runtimeNodeId, remoteRunId,
lastSequence)`. Normal desktop shutdown stops polling but does not interrupt a
bound remote Run. On restart, the Agent host resumes polling from the stored
cursor, imports the final Artifact once, and reconciles local Task/Assignment/Run state.

Temporary network failures retry with bounded exponential backoff. A terminal
remote result without an Artifact is a protocol failure, not an infinite retry.
Runtime health failures set the node offline, create deduplicated Inbox items
for affected Agents, and redact credentials from errors.

## Process Ownership

| Process | Owns |
| --- | --- |
| Electron Main | Window lifecycle, directory picker, navigation policy, SecretVault, Agent-host supervision, sender validation, Desktop Execution Broker |
| Preload | Fixed typed API and Run-event subscription; no generic IPC |
| Renderer | Workspace navigation, panes, dialogs, Inbox, Artifact/Context views, local layout and drafts |
| Agent host | The only desktop SQLite writer, use cases, Provider requests, tool orchestration, CLI adapter, remote polling |
| Remote Runtime | Durable remote jobs, events, cancellation, and final Artifacts |

Renderer payloads never contain Provider API keys, Runtime tokens, or SQLite
credential references. Main resolves a secret only when the Agent host needs it.

## Package Boundaries

```text
packages/domain           Entities, policies, transitions, schema version
packages/application      Use cases and local/remote orchestration ports
packages/agent-runtime    Native Provider/tool loop
packages/provider-adapters
packages/tool-runtime     Path confinement, approval policy, process control
packages/managed-execution Typed execution contract, Full Access adapter, Windows LPAC Broker adapter
packages/cli-runtime      Optional local CLI adapter
packages/remote-runtime   Protocol, HTTP client, service, remote job store
packages/storage-sqlite   Desktop repositories and migrations
packages/ipc-contracts    Runtime validators and typed desktop contract
apps/desktop              Main, preload, Agent host, React Renderer
```

Dependencies point toward `domain` and application ports. Renderer never
imports Node APIs, storage, Provider adapters, or tool implementations.

## Persistence And Migration

- Schema v1 established local Projects, Profiles, Threads, Runs, events, tools,
  approvals, and Project context.
- v2 removed persisted custom Provider headers and CLI environment values.
- v3 added bounded partial-output checkpoints.
- v4 added canonical Workspace, Runtime, Agent, Task, Artifact, Context,
  Handoff, Schedule, and Inbox tables, then copied legacy records forward.
- v5 added durable remote Run bindings and event cursors.
- v6 treats `waiting-input` as an active Run and rebuilds the per-Thread
  uniqueness index so paused Runs cannot be bypassed after migration.
- v7 persists the immutable Conversation execution profile and assigns legacy
  Local CLI Profiles to Full Access while native Profiles default to Request Approval.

Migrations are sequential and transactional. Databases from a newer schema are
rejected. Legacy work is retained and mapped to ready/archived state rather
than silently marked successful.

## Recovery Rules

- Local non-terminal Runs become `interrupted` on Agent-host restart and retain
  checkpointed output. This includes a local Run waiting for user input; its
  durable Inbox item and Thread history remain available for retry.
- Remote-bound Runs remain active/unknown locally and are reconciled from the
  remote owner after restart.
- Completed Runs create an Artifact and completion Inbox item. Failed or
  interrupted Runs update canonical Task/Assignment state and create a failure item.
- Desktop layout and message/context drafts are stored locally in Renderer
  storage; canonical work state is in SQLite.

## Deferred Architecture

Production cloud orchestration, Runtime secret escrow across Runtime process
restarts, autonomous schedules, multi-user authorization, cross-device sync,
message channels, plugin marketplace, and unbounded recursive orchestration are
second-stage concerns.
