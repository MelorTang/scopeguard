# Legacy Module Boundary Inventory

Snapshot: 2026-08-13. This inventory answers [盘点：确定旧模块的保留、替换与删除边界](https://github.com/MelorTang/scopeguard/issues/7) for the ScopeGuard V1 Wayfinder map.

This is a source-level disposition of the current repository. It does not define the final V1 module architecture; that remains the responsibility of the downstream architecture decision. The inventory uses four dispositions:

- **Retain**: keep the boundary and most behavior.
- **Adapt**: keep the boundary or implementation foundation, but change its contract.
- **Replace**: preserve no compatibility contract; write a new implementation behind a deliberate boundary.
- **Delete**: remove the package, model, UI, persistence, tests, and documentation after its replacement is usable.

## Executive Decision

ScopeGuard should continue in this repository, but it should not evolve the current Task -> Assignment -> Thread compatibility model. The code already contains useful infrastructure, but the domain and orchestration layers are carrying two successive products at once:

1. the older Project -> AgentProfile -> Thread product;
2. the current Workspace -> Task -> Assignment -> Thread -> Run product.

V1 establishes a third and final canonical chain:

```text
Organization control plane
  -> Member
  -> Workspace
  -> Conversation (fixed Agent, selectable allowed Model)
  -> Run
  -> Artifact
  -> Artifact Version
```

The safest refactor is a new local schema and a vertical replacement of the domain, store, application use cases, IPC contract, and Renderer projections. No development-database migration or compatibility aliases should survive. Git tags remain the migration and rollback mechanism for the former product.

## Repository-Level Disposition

| Area | Disposition | Decision |
| --- | --- | --- |
| pnpm monorepo and TypeScript build | Retain | The package layout and build chain are adequate for the new product. |
| Electron Main / Preload / Renderer / Agent-host process split | Retain and adapt | Preserve process ownership and typed IPC. Change the application contract and add document workers and an unmanaged terminal process owner. |
| React/Vite Web preview | Retain | Keep it as an in-memory UI preview only. It must not become a supported Member client or receive local capabilities. |
| Current domain model | Replace | Remove Task, Assignment, Schedule, Inbox, RuntimeNode, legacy Project/Profile aliases, and context-publication workflow. |
| Current SQLite schema and migrations | Replace | Create a new V1 schema. Reuse connection hardening, transactions, mapping discipline, and tests, not the v1-v6 migration chain. |
| Local native Agent loop | Adapt | Preserve a narrow provider/tool streaming interface until the Pi vendoring decision fixes the loop boundary. Do not preserve its current domain coupling. |
| Managed CLI Agent runtime | Delete | External Codex/Kimi are opened in the unmanaged Workspace Terminal and are not ScopeGuard Agents. |
| Persistent remote Agent runtime | Delete | The enterprise server is an identity/configuration/model-proxy control plane, not a remote ScopeGuard harness. |
| Provider adapters | Adapt | Preserve HTTP/SSE parsing, redaction, abort behavior, fixtures, and transport tests. Split protocols into explicit Responses, Chat Completions, and Anthropic Messages adapters. |
| Tool runtime | Adapt | Preserve path confinement, process cancellation, output bounding, and approval plumbing. Replace per-tool policy with the three-level Conversation Execution Profile and add Skill/MCP mediation. |
| UI shell and multi-pane layout | Adapt | Preserve the sidebar and pane mechanics as implementation input. Replace Task/Inbox/Runtime/Context surfaces with Conversation Workbench, Artifact Review, Terminal, and configuration surfaces. |
| Existing first-stage docs and screenshot | Delete after replacement | They describe a superseded product and must not remain normative after the V1 spec and updated README exist. |

## Package Inventory

### `packages/domain`

**Disposition: replace contents; retain the package boundary.**

Reusable:

- dependency-free domain package;
- explicit status unions and transition guards;
- normalized Provider base URL validation;
- immutable identifiers and timestamps.

Remove:

- `Project` as a compatibility mirror of `Workspace`;
- `AgentProfile`, `AgentInstance`, and `RuntimeNode`;
- `WorkspaceTask`, `TaskAssignment`, `WorkspaceSchedule`, and `InboxItem`;
- `ContextRevision`, `ContextRevisionUse`, and the publish-to-context workflow;
- `RemoteRunBinding`;
- Task-derived provenance on `Artifact` and `Handoff`;
- `local-cli` as an Agent runtime kind;
- `openai-compatible` and `anthropic-compatible` protocol names.

Introduce in the replacement domain:

- Organization, Administrator, Member, Workspace, Agent Template, Agent, Provider, Model, and MCP Connection;
- Conversation, Conversation Attachment, Active Context Projection, Run, and Conversation Execution Profile;
- Workspace File, Artifact, and immutable Artifact Version;
- Skill package and installation scope;
- Handoff Prompt and Agent Dispatch as separate concepts;
- explicit `openai-responses`, `openai-chat-completions`, and `anthropic-messages` protocols.

The duplicate `"waiting-input"` member in the current `AssignmentStatus` union is direct evidence that the compatibility model should not be patched further.

### `packages/application`

**Disposition: replace implementation; retain ports-and-use-cases as the architectural style.**

The current `ScopeGuardApplication` is a roughly 3,000-line coordinator. It owns workspace creation, provider administration, remote Runtime health, task lifecycle, assignments, artifacts, handoffs, schedules, inbox state, context publication, native runs, managed CLI runs, remote runs, approvals, persistence checkpoints, and recovery. That breadth prevents the old product from being removed independently.

Retain as patterns:

- dependency inversion through store, vault, provider, tool, CLI, and event ports;
- one active run per Conversation;
- abort propagation and bounded partial-output checkpoints;
- restart recovery that never projects an interrupted run as completed;
- event publishing isolated from Renderer state.

Replace with narrow application services, provisionally grouped by capability:

- Workspace and Conversation lifecycle;
- Run execution and recovery;
- Agent Dispatch;
- Artifact Version publication and conflict detection;
- Skill and MCP resolution;
- enterprise session/configuration projection;
- document job coordination.

Delete all remote-run polling, runtime health inbox generation, schedule methods, Task/Assignment synchronization, project compatibility methods, and context publication use cases.

### `packages/storage-sqlite`

**Disposition: replace schema and repository API; retain SQLite infrastructure.**

Retain:

- single-writer ownership in the Agent host;
- transaction boundaries and prepared parameter binding;
- database, WAL, SHM, and journal permission hardening;
- typed row mapping and corruption rejection;
- active-run uniqueness and restart-recovery test patterns;
- temporary-write and atomic-publication patterns where applicable.

Replace:

- the `ScopeGuardStore` monolith with repositories or cohesive store modules aligned to the final architecture;
- schema versions 1-6 with a fresh V1 schema;
- compatibility inserts that mirror Workspace records into Projects;
- legacy record-copy migrations.

No old development database is migrated. On first V1 start, ScopeGuard creates a new database identity or refuses an old schema with a clear reset/export instruction.

### `packages/ipc-contracts`

**Disposition: replace contract surface; retain runtime validation and a fixed preload API.**

Retain sender validation, explicit channel names, parse-at-boundary functions, secret-free Renderer views, and run-event subscription. Replace the current snapshot-shaped API, which exposes both old and intermediate domain models, with capability-oriented request/response contracts. Renderer payloads must never contain Provider secrets, enterprise MCP credentials, personal MCP secrets, or unrestricted filesystem handles.

### `packages/agent-runtime`

**Disposition: adapt behind a stable internal interface.**

Retain the provider-neutral message/tool/event vocabulary, streaming turn abstraction, abort handling, bounded loop behavior, and tool-result correlation. Remove assumptions tied to `AgentProfile`, Task/Assignment state, or managed CLI execution.

The internal loop should not be expanded before the Pi vendoring research is accepted. The target is a ScopeGuard-owned facade whose implementation may vendor selected Pi source without exposing Pi session, CLI, TUI, OAuth, memory, or coding-tool contracts.

### `packages/provider-adapters`

**Disposition: adapt.**

Retain:

- SSE parser and truncated-stream detection;
- HTTP error normalization and credential redaction;
- streaming text, tool call, usage, and finish-reason fixtures;
- abortable `fetch` transport.

Change:

- split OpenAI Responses and Chat Completions into different adapters;
- rename Anthropic support to the concrete Messages protocol;
- remove custom Provider headers from the Member-facing contract;
- source Provider configuration and credentials from the enterprise server proxy contract;
- support manually configured model metadata rather than discovery or protocol guessing.

### `packages/tool-runtime`

**Disposition: adapt and deepen.**

Retain path canonicalization, Workspace confinement, symlink/reparse-point checks, bounded file/process I/O, timeout/cancellation, approval waiters, and secret redaction. Map operations to the Conversation Execution Profile instead of separate `readFiles`, `writeFiles`, and `runCommands` flags.

Add a single authorization decision point that evaluates:

- requested operation and declared capability;
- Workspace boundary and outside-Workspace target;
- network use;
- Conversation Execution Profile;
- Skill or MCP origin;
- enterprise-secret non-disclosure.

Skills and MCP tools inherit this result. They must not create separate approval semantics.

### `packages/cli-runtime`

**Disposition: delete.**

The package currently validates commands, spawns a managed child process, captures output, and presents a CLI Agent as a ScopeGuard run. That contradicts the confirmed unmanaged-terminal boundary. Reuse generic process-control lessons in a new terminal owner, but do not reuse this API or represent terminal tabs as Conversations, Runs, Agents, or Artifacts.

### `packages/remote-runtime`

**Disposition: delete.**

The package implements bearer-authenticated durable remote jobs, event polling, cancellation, remote SQLite persistence, and Artifact import. V1 explicitly keeps the managed harness local. The new server must be developed as a separate enterprise control plane with login, templates, Provider configuration, encrypted credentials, model proxying, and Organization knowledge MCP configuration. None of the current remote job protocol is a compatibility requirement.

### `apps/desktop`

**Disposition: retain shell; replace product projections.**

Retain and adapt:

- `main.ts`: window lifecycle, navigation policy, sender validation, process supervision, and controlled directory selection;
- `preload.cjs`: narrow `contextBridge` surface and event cleanup;
- `main/renderer-security.ts`: hardened Renderer preferences and navigation policy;
- `main/project-directory-authorizer.ts`: adapt from Project to Workspace authorization;
- `main/private-data-directory.ts`: retain private local-data ownership;
- `main/encrypted-secret-vault.ts`: retain for personal MCP credentials and offline local credential material, not enterprise Provider keys;
- `main/agent-host-client.ts` and `agent-host.ts`: retain the supervised local service-process pattern and replace their method contract;
- `Sidebar.tsx`, `ThreadPane.tsx`, and current pane-layout logic: retain as prototype input, then rename and rewrite around Conversation semantics;
- `MarkdownText.tsx`, `Modal.tsx`, icon library, and general accessibility patterns.

Replace or delete:

- `TaskDialog.tsx`: delete;
- `RuntimeDialog.tsx`: delete;
- managed CLI choices in `AgentDialog.tsx`: delete;
- Provider administration in `ProviderDialog.tsx`: move to the server Admin Console; Desktop consumes an allowed configuration projection;
- Inbox, Schedule, Runtime, shared-context publishing, and old Handoff panels in `Inspector.tsx`: delete;
- the monolithic Inspector concept: replace with the full-center Artifact Review mode and a bottom Workspace Terminal;
- `useWorkspace.ts`: replace its mixed legacy/canonical snapshot and localStorage layout coupling with focused stores/controllers;
- `bridge.ts` Web mock: rewrite against the V1 contract while keeping it in-memory and capability-free;
- all Project, Task, Assignment, Thread, Inbox, Schedule, RuntimeNode, and ContextRevision display language.

The final Conversation Workbench supports one to four panes. Artifact Review replaces the center canvas and may show one associated Conversation. The terminal is a collapsible bottom tool and must not compete for a permanent third column.

## Persistence Table Disposition

| Current table | Disposition | V1 treatment |
| --- | --- | --- |
| `schema_metadata` | Adapt | Keep schema identity/version metadata, starting a new lineage. |
| `projects` | Delete | Workspace is the only local project boundary. |
| `workspaces` | Replace | New row shape includes local identity, file root, settings, and enterprise projection identifiers without a Project mirror. |
| `provider_profiles` | Delete locally | Provider definitions and API keys are server-owned. Cache only non-secret allowed configuration needed for offline display. |
| `agent_profiles` | Delete | Superseded by Agent Template plus Agent. |
| `agent_definitions` | Replace | Split server-projected templates from local Workspace Agent instances. |
| `agent_instances` | Replace | Agent belongs to a Workspace and does not bind to a local/remote RuntimeNode. |
| `runtime_nodes` | Delete | Native harness is local; the server is not an Agent RuntimeNode. |
| `workspace_tasks` | Delete | Task intent is represented by Conversation purpose and Run requests, not a separate lifecycle aggregate. |
| `task_assignments` | Delete | A Conversation binds one Agent directly. |
| `agent_threads` | Replace | New `conversations` table with immutable Agent binding and mutable allowed Model selection. |
| `thread_messages` | Replace | New transcript/message schema with attachment references and durable tool/result blocks. |
| `agent_runs` | Replace | New runs reference Conversation, execution profile snapshot, model/protocol snapshot, and active-context projection. |
| `run_partials` | Adapt | Retain bounded checkpoints under the new Run schema. |
| `run_events` | Adapt | Retain local recovery/event sequencing; it is not an enterprise audit log. |
| `tool_calls` | Adapt | Record operational state needed to execute/recover a Run, not a permanent audit feature. |
| `tool_approvals` | Adapt | Store only pending/resolved execution control needed by Request Approval mode; apply retention bounds. |
| `project_context_versions` | Delete | Superseded by Workspace Files, Conversation transcript, and Active Context Projection. |
| `context_revisions` | Delete | Same as above; do not preserve a user-published shared-memory object. |
| `context_revision_uses` | Delete | Run context snapshots carry their own selected inputs. |
| `artifacts` | Replace | Split logical Artifact from immutable Artifact Version and file storage metadata. |
| `agent_handoffs` | Replace | Split Handoff Prompt from Agent Dispatch; dispatch targets an existing Conversation. |
| `workspace_schedules` | Delete | Scheduling and unattended execution are outside V1. |
| `inbox_items` | Delete | Run status and approvals are shown in Conversations/sidebar; no durable general inbox. |
| `remote_run_bindings` | Delete | No managed remote Agent runtime. |

New local persistence is also required for Conversation attachments, Workspace file index metadata, Artifact Versions, installed Skill packages and scopes, personal/Workspace MCP definitions, encrypted credential references, document jobs, pane layout, terminal tab metadata, enterprise session projection, and offline credential verification state. Exact tables belong in the final architecture/specification.

## Test Disposition

Tests are reusable when they assert infrastructure behavior rather than old product semantics.

Retain or port:

- Renderer sandbox, navigation, sender, and preload restrictions;
- private-directory and secret-vault permissions;
- Workspace path confinement and symlink/reparse-point escape rejection;
- provider SSE framing, tool-call assembly, redaction, abort, and truncated-stream handling;
- run cancellation, one-active-run constraint, partial checkpointing, and interrupted recovery;
- SQLite permission and transaction failure behavior.

Delete and replace:

- Task/Assignment synchronization tests;
- Inbox and Schedule tests;
- remote Runtime submission/poll/import tests;
- managed CLI Agent tests;
- Project/Workspace compatibility and v1-v6 data-copy migrations;
- context publication and context-use ledger tests;
- UI snapshots and mocks containing obsolete navigation or domain names.

## Documentation Disposition

The new `CONTEXT.md` and accepted ADRs are authoritative for the refactor. `docs/V2_ARCHITECTURE.md`, `docs/V2_UI_SPEC.md`, `docs/FIRST_STAGE_GAP_ANALYSIS.md`, `docs/V0.4_TO_DESKTOP_V2.md`, `docs/VERIFICATION.md`, and `docs/assets/scopeguard-workspace.png` describe an earlier milestone. Keep them only until the V1 specification, verification plan, README, and current screenshots replace their useful information; then remove them in one documentation cleanup change.

`docs/SECURITY.md` should be reviewed rather than deleted automatically because its Electron and local-secret guidance may remain valid.

## Replacement Sequence

Use vertical slices so the repository stays testable while compatibility code is removed:

1. Freeze the final module architecture and V1 interaction contract from the remaining Wayfinder decisions.
2. Introduce the new domain types and fresh SQLite schema without migrating old development data.
3. Implement one local native Conversation end to end: create, send, stream, persist, cancel, restart, and resume/retry.
4. Replace Provider protocol handling and enterprise control-plane projections.
5. Add Workspace Files, attachments, Artifact Versions, atomic publication, and conflict detection.
6. Add Conversation Execution Profiles, Skills, enterprise/personal MCP, and Agent Dispatch.
7. Add document workers and Artifact Review.
8. Add the unmanaged Workspace Terminal.
9. Replace the Renderer navigation and Web preview fixtures.
10. Delete remote-runtime, cli-runtime, Task/Assignment/Inbox/Schedule/context compatibility code, old migrations, and obsolete docs.

Deletion should happen as soon as the replacement slice is verified. Keeping old and new aggregate paths live until the end would recreate the same mixed-domain problem this refactor is intended to remove.

## Completion Criteria

This inventory is complete when the downstream architecture decision can identify, for every current package and persisted aggregate, whether it is retained, adapted, replaced, or deleted without reopening the old product direction. The final architecture may rename proposed new modules, but it should not reintroduce Task/Assignment, managed CLI Agents, remote Agent Runtime, Inbox, Schedule, or legacy context publication as compatibility requirements.
