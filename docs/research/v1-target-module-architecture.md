# V1 Target Module Architecture

> Status: Historical enterprise-route architecture. It is superseded by [ADR 0024](../adr/0024-adopt-a-personal-first-pi-rpc-workbench.md) and [the current target architecture](../V2_ARCHITECTURE.md).

Snapshot: 2026-08-14. This decision resolves the target module and replacement
question tracked by [issue #10](https://github.com/MelorTang/scopeguard/issues/10).
It is constrained by `CONTEXT.md`, ADR 0001 through ADR 0022, and the accepted
runtime, MCP, Windows execution, document, interaction, and legacy inventories.

## Decision

ScopeGuard V1 is a local-first system with two deployment units:

1. A Windows-first Electron Desktop that owns Workspaces, Conversations, Runs,
   local effects, files, Artifacts, document processing, and the Native Harness.
2. A private, single-node enterprise server that owns Member identity,
   Organization configuration, Provider credentials, Model access, Agent
   Templates, Organization Skills, and the Organization Knowledge gateway.

The Desktop is organized around one supervised Local Core process. The Local
Core is the only writer of canonical local state and the only process allowed to
coordinate a Native Harness Run. Renderer, Main, workers, and terminals do not
become alternate application owners.

The enterprise server is a modular monolith, not a remote Agent Runtime. Model
traffic crosses a protocol-preserving Model Gateway: the Desktop constructs and
parses one of the three supported Provider protocols, while the server validates
the selected Organization configuration, injects the server-held credential,
and relays the upstream stream. The server never supplies a Provider key, base
URL, arbitrary header, or enterprise MCP credential to the Desktop.

The implementation keeps modules deep and package seams few. A package exists
only to enforce domain ownership, a process or trust separation, a cross-process
contract, a native-binary integration, or an independently testable runtime
seam. Application capabilities within the Local Core are modules inside
`packages/application`, not one package per use case.

## Fixed Product Constraints

- The canonical local chain is `Workspace -> Conversation -> Run -> Artifact ->
  Artifact Version`. Task is the Conversation's primary objective, not a
  separately persisted aggregate.
- A Conversation is permanently bound to one Agent. It may select another Model
  only from that Agent's allowed Models.
- One Conversation has at most one non-terminal Run. Different Conversations
  may run concurrently.
- The Desktop stores the durable Conversation Transcript. A Run receives only
  its immutable Active Context Projection.
- Request Approval and Auto Approve use the same OS-enforced Managed Execution
  Sandbox. Full Access is an explicit current-user, unsandboxed mode.
- The Workspace Terminal is Member-operated and outside Agent execution.
- Workspace Files and Organization Knowledge are separate capabilities.
- The Web Renderer build is a capability-free preview, not a supported client.
- V1 has no remote Agent runtime, automatic routing, schedules, general inbox,
  public SaaS control plane, or first-party business-system integration.

## Deployment And Process Ownership

```text
Windows Desktop
  Electron Main
    - window and navigation policy
    - Local Core supervision
    - OS credential store
    - directory picker
    - unmanaged terminal ownership
  Preload
    - fixed Desktop Contract only
  Renderer
    - Workbench and Artifact Review projections
    - drafts and interaction state
  Local Core utility process
    - application modules and state transitions
    - only local SQLite writer
    - Native Harness coordination
    - enterprise session/config projection
    - approvals, recovery, and event publication
  Ephemeral managed workers
    - document jobs
    - executable Skills
    - local stdio MCP
    - command and script execution
  Unmanaged terminal children
    - current-user shell, outside Agent execution

Enterprise deployment
  Server application
    - identity and session
    - Organization configuration
    - Model Gateway
    - Organization Knowledge gateway
    - Admin Console backend
  Admin Console web assets
  PostgreSQL
```

Electron Main is a process supervisor and security adapter. It does not own
Conversation state or call Providers. Preload performs validation and transport
only. Renderer never imports Node, SQLite, Provider, MCP, Skill, document worker,
or local process implementations.

The Local Core may launch a worker only through the Managed Execution module.
The one exception is an explicitly Member-opened Workspace Terminal, launched
and labelled by Electron Main under the unmanaged-terminal contract.

## Desktop Modules

### 1. Desktop Contract

**Location:** `packages/ipc-contracts`, adapted in place.

**Interface:** versioned, capability-oriented commands, queries, event streams,
and runtime validators shared by Renderer, Preload, Main, and Local Core.

**Owns:**

- request and response DTO validation;
- sender-scoped command names;
- secret-free Renderer projections;
- event cursor and subscription shapes;
- additive protocol-version negotiation during one release lineage.

**Does not own:** domain transitions, persistence, file handles, secrets, raw
Provider payloads, or generic IPC invocation.

The contract is grouped by capability: Workspace, Conversation, Run, Artifact,
Approval, Extensions, Settings, and Terminal control. It must not expose one
monolithic snapshot that forces unrelated state to reload together.

### 2. Local Core

**Location:** `packages/application`, replaced internally but retained as the
application package.

**External interface:** one `DesktopCore` command/query/event interface used by
the Local Core host. Tests cross the same interface through in-memory ports.

**Internal modules:**

- `WorkspaceCatalog`: Workspace lifecycle, local-root authorization, and
  Workspace settings.
- `ConversationCoordinator`: Conversation lifecycle, immutable Agent binding,
  Model selection validation, and transcript append rules.
- `RunCoordinator`: Active Context Projection creation, one-active-Run
  enforcement, Native Harness execution, approval waits, cancellation,
  checkpointing, and recovery.
- `ArtifactWorkflow`: Workspace File imports, Conversation Attachments,
  Artifact and Artifact Version publication, provenance, conflict detection,
  and export.
- `HandoffCoordinator`: Handoff Prompt generation and same-Workspace Agent
  Dispatch to an existing Conversation.
- `ConfigurationProjection`: online refresh and offline-safe projection of the
  active Member, Agent Templates, Agents, Models, Organization Skills, and
  Organization Knowledge availability.
- `DocumentJobCoordinator`: durable job state and handoff to Document Runtime.

The Local Core owns orchestration and state transitions, not adapter behavior.
It depends on ports for persistence, inference, capabilities, documents,
enterprise access, clocks, IDs, and events. It must not import concrete SQLite,
HTTP, Electron, worker, or Windows runner implementations.

### 3. Local Store

**Location:** `packages/storage-sqlite`, replaced with a fresh V1 schema.

**Interface:** cohesive repositories and a transaction runner implementing the
Local Core persistence ports.

**Owns:**

- one schema lineage for V1;
- transaction boundaries, row mapping, constraints, and corruption rejection;
- WAL and local database permission hardening;
- one-active-Run database enforcement;
- bounded Run checkpoints and restart-recovery state;
- local cache metadata and retention markers.

The store does not contain workflow transitions and does not expose SQL-shaped
records to callers. No former development database migration or compatibility
view is retained.

### 4. Native Harness

**Locations:** `packages/agent-runtime` and `packages/provider-adapters`, both
adapted and kept as separate modules because three concrete protocol adapters
already vary behind one real Provider seam.

**Interface:** execute one immutable Run input and emit normalized ordered
events until completion, failure, cancellation, or required Member input.

**Owns:**

- the bounded provider/tool loop;
- Provider message projection and stream state machines;
- strict tool-call completion and argument validation ordering;
- abort propagation, terminal-event detection, and bounded protocol retry;
- normalized text, reasoning, usage, tool-call, and terminal events;
- the allowlisted Pi-derived protocol kernel and provenance.

**Does not own:** Conversation history, context selection, persistence,
approval policy, tool effects, Agent identity, Model authorization, or Provider
credentials.

Provider adapters receive an injected `ModelTransport`. Production uses the
enterprise Model Gateway transport. Contract tests use static local fixtures.
There is no direct-production Provider transport in V1.

### 5. Capability Runtime

**Location:** `packages/tool-runtime`, replaced and renamed to
`packages/capability-runtime` when its first V1 slice lands.

**Interface:** resolve the effective tool catalog for a Run and invoke one
strictly validated capability under an immutable execution context.

**Owns:**

- built-in typed tools;
- Skill discovery, precedence, manifests, and instruction projection;
- local and remote personal/Workspace MCP client lifecycle;
- Organization Knowledge tool projection through the Enterprise Client;
- reviewed effect manifests and tool-list drift invalidation;
- one authorization decision point for file, process, network, and effect
  categories;
- approval requests and `effect_unknown` outcomes.

Skills and MCP servers do not define approval semantics. The Capability Runtime
maps every invocation to the active Agent Policy and Conversation Execution
Profile, then delegates executable work to Managed Execution. Raw credentials
are never returned through this interface.

### 6. Managed Execution

**Location:** new `packages/managed-execution` plus a signed Windows native
launcher distributed outside ASAR.

**Interface:** execute an immutable process plan under either the bounded
sandbox policy or the explicit Full Access policy, and return bounded output,
exit state, diagnostics, and verified process-tree cleanup.

**Owns:**

- policy compilation from declared filesystem, process, IPC, and network needs;
- the selected AppContainer/LPAC adapter and Full Access adapter;
- exact environment and inherited-handle allowlists;
- Job Object process-tree ownership, timeout, cancellation, and shutdown;
- transactional profile and ACL setup/cleanup;
- fail-closed startup and runtime verification.

The Windows 10/11 client matrix in issue #14 may change the internal runner
adapter, but it does not change this interface. Until that matrix passes,
Request Approval and Auto Approve may use brokered typed tools but cannot expose
arbitrary executable capability. The unmanaged Workspace Terminal never calls
this module.

### 7. Document Runtime

**Location:** new `packages/document-runtime` with a separately versioned and
signed Document Runtime Pack.

**Interface:** admit, inspect, render, revise, compare, export, and cancel a
typed document job against immutable source and operation descriptors.

**Owns:**

- format identification, hostile-input limits, and active-content exclusion;
- DOCX/XLSX/PPTX structural operations through the Open XML worker;
- PDF.js rendering, qpdf typed page operations, and bounded OCR;
- Markdown/HTML structural parsing and isolated rendering;
- normalized and visual comparison projections;
- source-copy, source-hash, validation, and non-mutation proofs;
- temporary job directories and deterministic runtime manifests.

The Document Runtime returns a validated candidate output and comparison data.
Only `ArtifactWorkflow` publishes a new Artifact Version. All executable workers
launch through Managed Execution in Request Approval and Auto Approve.

### 8. Enterprise Client

**Location:** new `packages/enterprise-client`.

**Interface:** authenticate, refresh the allowed Organization projection,
stream a model protocol request, and search Organization Knowledge.

**Owns:**

- Desktop-to-server HTTP transport and cancellation;
- access-token refresh and explicit online/offline state;
- protocol-preserving Model Gateway transport;
- fixed Organization Knowledge request/result validation;
- configuration revision caching and stale-state projection;
- secret-free, bounded diagnostics.

The client does not know Provider or enterprise MCP credentials. It does not
persist Workspaces, Conversations, prompts, evidence corpora, or Artifacts on
the server.

### 9. Desktop Shell

**Location:** `apps/desktop`, retained and rewritten around the V1 contract.

**Owns:** Electron composition, Local Core supervision, secure window creation,
preload exposure, Workbench and Artifact Review UI, OS secret adapter,
Workspace directory authorization, terminal lifecycle, and packaging.

`agent-host.ts` becomes the Local Core composition root. It constructs concrete
adapters and passes them to `DesktopCore`; it must not grow product use cases.
The in-memory Web bridge implements only the Desktop Contract and cannot load
production adapters.

## Enterprise Modules

The enterprise server is one deployable application with internal modules. Do
not split these modules into network services in V1.

### Identity And Session

Owns Member login, session and refresh-token rotation, active Organization and
Member state, offline credential enrollment metadata, and Administrator checks.

### Organization Configuration

Owns Members, Agent Template revisions, allowed Models, Agent Policy,
Organization Skill packages, Provider definitions, and configuration revision
projection. Provider and enterprise MCP secrets are encrypted with the
deployment master key and never enter projection payloads.

### Model Gateway

Accepts only authenticated, explicitly protocol-labelled stream requests for an
allowed Provider and Model. It validates request size and selected configuration,
overwrites credential and upstream routing material, applies time and concurrency
limits, and relays the upstream byte stream without persisting prompt content.

The Desktop Provider adapter remains responsible for wire message projection
and parsing. The Gateway must not infer protocol from a URL or Model name, add
automatic routing/failover, accept arbitrary upstream URLs/headers, or expose a
generic authenticated proxy.

### Organization Knowledge Gateway

Owns the server-side MCP credential and fixed read-only
`search_organization_knowledge` adapter. It authorizes the current Member,
validates evidence and citation shapes, and returns opaque citation references.
It does not own enterprise ingestion, indexing, RAG, or source permissions.

### Admin Console

`apps/admin` is a server-hosted Administrator web surface for the Organization
Configuration module. Member Workspace data is not an Admin Console resource.

### Shared Enterprise Contract

**Location:** new `packages/enterprise-contracts`.

Contains runtime-validated Desktop/server and Admin/server DTOs plus an OpenAPI
source. It contains no server implementation, credential logic, Provider SDK,
or local domain persistence types.

## Dependency Direction

```text
apps/desktop
  -> ipc-contracts
  -> application
  -> storage-sqlite
  -> agent-runtime
  -> provider-adapters -> agent-runtime
  -> capability-runtime -> managed-execution
  -> document-runtime -> managed-execution
  -> enterprise-client -> enterprise-contracts

application -> domain
all desktop adapters -> application ports and domain values

apps/server -> enterprise-contracts
apps/admin  -> enterprise-contracts
```

Enforced rules:

1. `application` depends only on `domain` and standard library types.
2. Concrete adapters may depend on application ports; application never imports
   a concrete adapter package.
3. `apps/desktop` is the only desktop composition root.
4. Renderer code imports only Renderer-safe contract and UI modules.
5. `enterprise-contracts` never imports Desktop persistence or Electron types.
6. Server code never imports local Workspace, SQLite, Managed Execution, or
   terminal implementations.
7. A dependency-cycle check and Renderer bundle exclusion check run in CI.

## State And Persistence Ownership

| State | Authoritative owner | Persistence |
| --- | --- | --- |
| Organization, Member, Administrator | enterprise server | PostgreSQL |
| Agent Templates, Agent Policy, Providers, Models | enterprise server | PostgreSQL |
| Provider and enterprise MCP credentials | enterprise server | encrypted PostgreSQL fields / deployment secret boundary |
| Organization Skills | enterprise server | PostgreSQL metadata plus bounded package storage |
| Organization Knowledge corpus/index | external knowledge service | outside ScopeGuard |
| Workspace and Agent instances | Desktop Local Core | local SQLite |
| Conversation, Transcript, Run, checkpoints | Desktop Local Core | local SQLite |
| Active Context Projection | Desktop Local Core | immutable per-Run snapshot in local SQLite |
| Workspace Files | selected Workspace directory | local filesystem plus version metadata in SQLite |
| Conversation Attachments | Desktop Local Core | private local blob storage plus SQLite metadata |
| Artifact and Artifact Versions | Desktop Local Core | private local blob storage plus SQLite metadata; explicit export to Workspace |
| personal/Workspace Skills and MCP definitions | Desktop Local Core | local SQLite/files; secrets in OS credential store |
| approvals and recent tool operational state | Desktop Local Core | bounded local SQLite retention |
| pane layout and drafts | Renderer/Desktop projection | local UI state; never canonical work state |
| terminal contents and CLI sessions | external CLI/shell | not persisted by ScopeGuard |

The server may process model request content and knowledge queries transiently,
but must not persist them in application logs or product tables. ScopeGuard V1
does not create a separate audit or receipt product.

## Core Run Flow

1. Renderer sends a validated `StartRun` command through Preload and Main.
2. Local Core verifies Conversation, fixed Agent, selected Model, policy,
   one-active-Run, and online requirements.
3. `RunCoordinator` builds and persists the immutable Active Context Projection
   and Run configuration snapshots.
4. Capability Runtime resolves the exact tool catalog and effect declarations.
5. Native Harness projects the request through the explicit Provider adapter.
6. Enterprise Client sends the protocol-labelled request to Model Gateway.
7. Model Gateway validates Member and Model access, injects Provider routing and
   credentials, and relays the stream.
8. Native Harness emits normalized events. Local Core checkpoints bounded output
   and publishes Renderer events.
9. A tool call is strictly parsed, schema-validated, authorized by Capability
   Runtime, approved when required, then executed through a typed broker or
   Managed Execution.
10. Tool results append to the same Conversation and the loop continues.
11. Terminal state is persisted before it is projected to Renderer. Artifact
   outputs publish only through `ArtifactWorkflow`.

On Local Core restart, a non-terminal local Run becomes interrupted and retains
its bounded checkpoint. It is never projected as completed. Resume or retry
creates an explicit new execution attempt under the current valid configuration.

## Offline Flow

After local offline identity verification, the Member may open Workspaces,
Transcripts, Workspace Context, files, Artifacts, cached configuration labels,
and document previews. Model execution and Organization Knowledge remain
unavailable. The Desktop does not silently fall back to a personal Provider or
another Organization configuration.

## Current Package Disposition

| Current area | Target action |
| --- | --- |
| `packages/domain` | Replace contents; retain package. |
| `packages/application` | Replace monolith with Local Core modules and ports; retain package. |
| `packages/storage-sqlite` | Replace schema/repositories; retain package. |
| `packages/ipc-contracts` | Replace snapshot surface; retain package. |
| `packages/agent-runtime` | Adapt as Native Harness loop. |
| `packages/provider-adapters` | Adapt as three explicit protocol adapters with Pi-derived kernels. |
| `packages/tool-runtime` | Replace and rename to `capability-runtime`. |
| `packages/cli-runtime` | Delete after unmanaged terminal owner exists. |
| `packages/remote-runtime` | Delete when the first enterprise Model Gateway slice is usable. |
| `apps/desktop` | Retain shell and security adapters; replace product projections. |
| `docs/V2_*`, first-stage migration/gap docs | Delete after V1 spec, verification plan, README, and screenshots replace them. |

New areas are `packages/managed-execution`, `packages/document-runtime`,
`packages/enterprise-client`, `packages/enterprise-contracts`, `apps/server`,
and `apps/admin`.

## Replacement Sequence

Each step ends with a runnable vertical slice. Old code is deleted as soon as
its replacement passes the step gate.

1. **Contract foundation.** Introduce the V1 domain, application ports,
   capability-oriented Desktop Contract, fresh SQLite schema, and dependency
   rules. Reject old database identities. Remove Project/Task/Assignment aliases
   from the new path.
2. **Local Conversation loop.** Deliver create/open Workspace, create
   Conversation with fixed Agent, send, stream, cancel, persist, restart, and
   retry using fixture ModelTransport. Replace the sidebar and Workbench
   projection, and prove two Conversations can stream independently in the
   one-to-four-pane layout.
3. **Enterprise inference loop.** Add the modular server, login, configuration
   projection, explicit Provider/Model setup, and protocol-preserving Model
   Gateway. Run all three protocol contract suites. Delete `remote-runtime` and
   local Provider administration.
4. **Workspace and Artifact loop.** Add attachments, Workspace Files, typed
   brokered reads/writes, version hashes, conflict rejection, Artifact Versions,
   and export. Remove legacy context publication and old Artifact provenance.
5. **Managed capability and terminal loop.** Land the accepted Windows runner,
   three Conversation Execution Profiles, approvals, built-in tools, Skills,
   personal/Workspace MCP, and the unmanaged Workspace Terminal. Delete
   `cli-runtime`, managed CLI Agent UI, and old per-tool policy only after the
   terminal owner is verified.
6. **Parallel coordination loop.** Complete Handoff Prompt, Agent Dispatch,
   independent status, and pane restoration across concurrent Conversations.
7. **Document and review loop.** Land the accepted document stack, document job
   recovery, Artifact Review, version comparison, and external-Office fallback.
8. **Release loop.** Complete filesystem invalidation, Windows packaging,
   runtime-pack verification, offline recovery, backup/restore procedure, and
   ten-Member pilot load tests.
9. **Removal pass.** Delete every obsolete model, table, test, package, UI
   surface, build script, generated output, and superseded document identified
   by the legacy inventory. Confirm no compatibility path remains reachable.

## Architecture Verification Gates

- Static dependency test enforces the dependency rules and Renderer exclusions.
- Desktop Contract tests reject unknown channels, invalid senders, malformed
  payloads, and secret-bearing projections.
- Local Core tests cover every state transition through public module
  interfaces, including interruption, stale configuration, and partial output.
- SQLite tests cover transaction rollback, constraints, corruption rejection,
  permission hardening, and fresh-schema identity rejection.
- Provider tests cover all three protocols, terminal events, malformed streams,
  strict tool arguments, redaction, cancellation, and bounded retry.
- Model Gateway tests prove no arbitrary URL/header/key passthrough and no
  prompt/tool payload logging.
- Capability tests prove the most restrictive Agent Policy/profile result wins,
  changed Skills/MCP tools disable, and credentials never enter tool results.
- Managed Execution must pass issue #14's Windows 10/11 matrix before arbitrary
  executable capability is enabled in Request Approval or Auto Approve.
- Document Runtime must pass issues #8 and #9 before a format/operation appears
  as guaranteed in the Member UI.
- End-to-end tests cover two simultaneous Conversations, one approval wait,
  one cancellation, one Dispatch, one Artifact revision conflict, Local Core
  restart, enterprise outage, and offline local review.
- Windows package tests prove signed binary/runtime manifests, clean uninstall,
  no first-run development dependency, and no Provider/MCP secret in Renderer,
  logs, crash reports, or local database.

## Explicit Non-Goals

- No compatibility layer for the former Project/Profile/Task/Assignment model.
- No remote or unattended ScopeGuard Agent execution.
- No direct-production Provider call from Desktop.
- No Provider protocol inference, discovery, routing, or failover.
- No server synchronization of Workspace files, transcripts, or Artifacts.
- No automatic cross-Conversation context sharing.
- No arbitrary extension permission model outside Agent Policy plus Conversation
  Execution Profile.
- No microservice split, event bus, Redis, queue, or object store in V1.

## Residual Decisions

This architecture is stable if the AppContainer/LPAC implementation changes or
if bounded profiles temporarily expose brokered typed tools only. Issue #14 owns
the exact Windows runner and cleanup proof. Issues #8 and #9 own exact document
libraries, accepted operations, fidelity thresholds, and external-Office
fallback labels. Those decisions fill adapters behind the seams above and do
not reopen module ownership.
