# ScopeGuard Core Architecture

## Product Boundary

ScopeGuard is a local-first desktop workspace for one person coordinating
multiple AI conversations. Each conversation is an independent execution and
context boundary. The user chooses the Agent when creating the conversation;
the selected Agent cannot be replaced later.

Electron is the production surface. The Web build is an in-memory Renderer
preview and deliberately has no filesystem, process, Provider, SQLite, or
SecretVault access.

The core does not own external Agent CLIs, persistent remote workers, enterprise
RAG indexing, multi-user identity, cloud sync, or automatic Agent routing.

## Core Model

```text
Workspace
  ├─ optional localRootPath
  ├─ ProviderProfile (referenced by Agent)
  ├─ Agent (native)
  ├─ Conversation
  │    ├─ ConversationMessage
  │    └─ Run
  │         ├─ RunRequestManifest
  │         ├─ RunUsageRecord
  │         ├─ ToolCallRecord
  │         └─ ToolApproval
  └─ WorkspaceContextRevision
```

- `Workspace` is the user-visible project boundary; its local folder is optional.
- `Agent` owns native instructions, Provider selection, default model,
  default execution profile, and tool policy.
- A conversation binds one Agent at creation. Its model override and execution
  profile may change without changing the Agent or Harness; each Run stores the
  effective values in an immutable configuration snapshot.
- `Run` is one execution attempt. One conversation has at most one non-terminal
  Run; different conversations may run concurrently and cancel independently.
- `WorkspaceContextRevision` is the explicit, user-controlled shared context. ScopeGuard
  never injects another conversation's transcript implicitly.
- Request manifests and usage records preserve the effective execution input
  and accounting without turning the product into a separate control plane.

The domain, storage, application, IPC, and Renderer use the same canonical
Workspace, Agent, Conversation, Message, and Run names. There is no compatibility
projection for the former Project/Profile/Task/Assignment hierarchy.

## Execution

Only the native `NativeAgentRuntime` is managed by ScopeGuard. It executes the
conversation transcript against the configured Provider, exposes allowed tools,
and emits typed Run events. External CLI harnesses are not represented as native
Agents and remain outside ScopeGuard's lifecycle.

Every conversation has one of three current execution profiles:

| Profile | Approval | Command authority |
| --- | --- | --- |
| Request Approval | Mutating calls require a decision | Bounded adapter |
| Auto Approve | Allowed calls run without prompts | Bounded adapter |
| Full Access | No per-call approval | Current desktop user |

On Windows, bounded command execution uses the LPAC managed-execution path. If
that path is unavailable, it fails closed and never falls back to Full Access.
External Agent CLIs may be opened in a separate terminal, but ScopeGuard does
not own their sessions, permissions, recovery, or output.

## Process Ownership

| Process | Owns |
| --- | --- |
| Electron Main | Window lifecycle, native picker, navigation policy, SecretVault, Agent-host supervision, Desktop Execution Broker |
| Preload | Fixed typed desktop API and Run-event subscription |
| Renderer | Workspace navigation, parallel panes, dialogs, layout, and drafts |
| Agent host | Application core, Provider requests, tools, cancellation, and the only SQLite writer |

Renderer payloads never contain Provider API keys or SQLite secret references.
Main resolves a secret only for an Agent-host request.

## Package Boundaries

```text
packages/domain             Core entities and transitions
packages/application        ScopeGuardCore use cases
packages/agent-runtime      Native Provider/tool loop
packages/provider-adapters  Provider protocol adapters
packages/tool-runtime       Path confinement, approval, and command routing
packages/managed-execution  Bounded and Full Access command adapters
packages/storage-sqlite     Fresh V1 schema and recovery repositories
packages/ipc-contracts      Runtime validators and typed desktop contract
apps/desktop                Main, preload, Agent host, and Renderer
```

Dependencies point toward domain types and the `ScopeGuardCore` interface. The
Renderer never imports Node APIs, storage, Provider adapters, or tool
implementations.

## Persistence And Recovery

- The schema declares identity `scopeguard-v1-core` and version `1`.
- A database with missing or different identity is rejected. V1 does not migrate
  the former development schema and never silently creates a new graph over it.
- Only canonical V1 tables are created; Runtime, Task, Assignment, Artifact,
  Handoff, Schedule, Inbox, Project, AgentProfile, and AgentThread tables do not
  exist in the new schema.
- On Agent-host startup, every non-terminal Run becomes `interrupted`, including
  local record. No external owner is presumed able to reconcile it.
- Interrupted Runs retain checkpointed output and unfinished non-idempotent tool
  effects remain unknown rather than being reported as successful.
- Layout and unsent drafts are local Renderer state; conversation and Run state
  are persisted in SQLite.

## Deferred Work

Team identity and authorization, cloud synchronization, enterprise MCP policy,
installer distribution, auto-update, and richer document workflows remain
separate milestones. Adding one must not reintroduce a second execution control
plane into the core.
