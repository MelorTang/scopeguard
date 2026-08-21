# ScopeGuard Personal Multi-Agent V1 Architecture

Status: Product boundary accepted by
[ADR 0024](./adr/0024-adopt-a-personal-first-pi-rpc-workbench.md), Pi RPC
contract accepted by [ADR 0025](./adr/0025-adopt-pi-rpc-with-an-extension-approval-bridge.md),
and the Phase 2 Runtime/storage reset is accepted by
[ADR 0026](./adr/0026-replace-the-native-harness-with-pi-runtime.md). Agent file
editing and Artifact ownership are fixed by
[ADR 0027](./adr/0027-use-agent-tools-for-file-editing.md).

## Product Shape

ScopeGuard is a local Desktop workbench around this user-visible chain:

```text
User
`- Workspace
   |- Agent configuration
   |- Conversation -> Run -> Pi session
   |- Conversation -> Run -> Pi session
   |- Dispatch between existing Conversations
   `- Artifact -> version
```

A Workspace may reference a local directory. One to four Conversations can be
visible at the same time, and each can run independently. A Conversation keeps
one Agent identity for its lifetime. Model changes are allowed only when they do
not replace that identity or invalidate the runtime session.

## Runtime Boundary

```text
Electron Renderer
  -> fixed Preload API
  -> Electron Main / ScopeGuard application layer
       |- local metadata store
       |- Workspace and Agent configuration
       |- Artifact and Dispatch services
       `- Pi RPC client
            -> supervised Pi process
                 |- Agent loop
                 |- Provider adapters
                 |- runtime Tools
                 |- session persistence and resume
                 `- compaction
```

ScopeGuard supervises one Pi process per running Conversation and owns the RPC
adapter, but does not
duplicate Pi's Agent loop, Tool lifecycle, session log, or compaction algorithm.
ScopeGuard persists the stable mapping between its Conversation ID and the Pi
session locator plus enough metadata to restore the workbench. Runtime events
may be projected into the UI, but Pi remains the runtime session truth.

The fixed Runtime is `@earendil-works/pi-coding-agent@0.84.2`. Before Pi starts
with Tools enabled, ScopeGuard verifies the CLI version plus a manifest that
contains exactly one final Tool-policy extension and SHA-256 pins for every
policy file. `read` remains inside the active Workspace and follows Agent
allow/ask/deny policy. `bash`, `write`, and `edit` always cross an approval bound
to the exact process, RPC request, Tool call, Tool name, canonical input, and
input hash; the Conversation profile decides whether the User or ScopeGuard
answers that tuple. Agent deny policy still blocks Auto Approve. Full Access
automatically answers known Tools, while unknown Tools remain blocked. Manifest
drift, wrong composition, or a lost approval channel fails closed. Qualification
remains an independent frozen-lock upgrade gate.

## ScopeGuard Modules

**Desktop shell** owns native windows, lifecycle, menus, local folder selection,
and the secure Renderer boundary.

**Workbench application** owns Workspace, Agent, Conversation metadata, visible
pane layout, Run presentation, and Conversation-to-Pi-session mapping.

**Dispatch service** records source, destination, bounded prompt, selected
Artifact references, and delivery state. It never copies the source transcript
or chooses a destination automatically.

**Artifact service** owns durable work products, versions, preview state, and
the switch between multi-Conversation Workbench and Artifact Review. It records
the source/output identity and provenance of Agent-produced files, stops on
conflicting Workspace changes, and never mutates an existing Artifact Version.

**Agent file editing** is not a separate ScopeGuard module. Agents use Pi Tools,
selected Skills, scripts, libraries, and mature external applications to work
with ordinary Workspace Files. ScopeGuard captures the resulting files as
Artifact Versions and exposes the actual workflow's limits; it does not provide
a uniform Office operation layer or ship a Document Runtime.

**Pi RPC adapter** translates between the ScopeGuard application contract and
the pinned Pi RPC version. It owns process supervision, strict response unions,
bounded redacted diagnostics, readiness and policy composition, not UI state or
Pi's transcript.

## Persistence

ScopeGuard schema family `scopeguard-personal-pi-v1`, version 2, contains
Workspace, Provider reference, Agent, Conversation-to-Pi-locator, Run,
approval-tuple, Workspace context, Artifact, Dispatch, and layout metadata.
Phase 4 activates immutable Artifact Versions, declared Workspace input
identities, source/output identities, provenance, Review state, and the exact
Phase 3-to-Phase 4 schema migration. Artifact file bytes live in
content-addressed local storage rather than SQLite. The database has no message,
Tool result, transcript, or compaction tables. Pi's Session JSONL is the sole
Runtime truth. Workspace source files remain ordinary local files, and Provider
secrets remain in the operating-system vault rather than SQLite or RPC payloads.

There is no migration from the retired development schema; only the exact
Phase 3 candidate schema version can move to version 2. Startup validates
the schema family/version, complete table and column shape, SQLite integrity,
the complete Pi locator, fixed Pi/Session versions, Session file readability,
Session ID, and Workspace identity. Missing, malformed, incompatible, or
unopenable state stops startup; it never creates an empty replacement Session.

## Concurrency And Isolation

- One Conversation has at most one active Run.
- Different Conversations may run concurrently, including with different Agents
  and Models.
- A Dispatch targets an existing Conversation in the same Workspace.
- Conversation history is not implicitly shared.
- Shared Workspace writes retain version checks and stop on conflicts.
- Closing a pane does not delete a Conversation or stop an active Run.
- Workspace layout transitions validate every active, open, and pane Conversation
  against the selected Workspace before display or persistence. Pending layout
  saves and revisions are isolated per Workspace.
- Pane widths are bounded Workspace metadata. Accessible mouse and keyboard
  separators adjust adjacent panes; constrained windows scroll horizontally and
  never remove requested panes as a responsive shortcut.

## Explicit Non-Goals

- Organization, Administrator, Member, Agent Template, or Admin Console models.
- ScopeGuard-hosted enterprise RAG or knowledge ingestion.
- Automatic routing, autonomous Agent creation, or hidden orchestration.
- A second native Agent Runtime beside Pi.
- Pretending external coding CLI Harnesses have one uniform contract.
- Cloud Workspace synchronization or unattended 24/7 remote execution in V1.
- Long-term support for both the retired and new schemas.

## Delivery Phases

1. Phase 0: product contract, ADR, wayfinding, and historical checkpoint. Complete.
2. Phase 1: Pi RPC qualification prototype and go/no-go decision. Complete.
3. Phase 2: fresh local schema and runtime replacement behind stable interfaces. Complete.
4. Phase 3: multi-Conversation workbench, explicit Dispatch, and recovery.
   Candidate implementation has passed independent review but still awaits
   exact-candidate Windows development and staged Pilot acceptance.
5. Phase 4: Artifact Review and the Agent file-editing lifecycle. Candidate
   implementation under verification; not yet accepted.
6. Phase 5: packaging, cross-platform verification, and real-project pilot.

Each phase advances only after the exit gate in
[VERIFICATION.md](./VERIFICATION.md) and the active GitHub Wayfinder map passes.
