# ScopeGuard Personal Multi-Agent V1 Architecture

Status: Target architecture accepted by
[ADR 0024](./adr/0024-adopt-a-personal-first-pi-rpc-workbench.md). The current
Native Harness implementation has not yet been replaced.

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
       |- Office Tool Pack
       `- Pi RPC client
            -> supervised Pi process
                 |- Agent loop
                 |- Provider adapters
                 |- runtime Tools
                 |- session persistence and resume
                 `- compaction
```

ScopeGuard supervises the Pi process and owns the RPC adapter, but does not
duplicate Pi's Agent loop, Tool lifecycle, session log, or compaction algorithm.
ScopeGuard persists the stable mapping between its Conversation ID and the Pi
session locator plus enough metadata to restore the workbench. Runtime events
may be projected into the UI, but Pi remains the runtime session truth.

Phase 1 must qualify the real RPC contract before replacement work starts. The
prototype must cover startup and shutdown, streaming text, Tool call events,
interrupt and cancellation, crash behavior, session resume, compaction, Provider
configuration, and multiple concurrent sessions. Unsupported behavior remains
explicit rather than being simulated by ScopeGuard.

## ScopeGuard Modules

**Desktop shell** owns native windows, lifecycle, menus, local folder selection,
and the secure Renderer boundary.

**Workbench application** owns Workspace, Agent, Conversation metadata, visible
pane layout, Run presentation, and Conversation-to-Pi-session mapping.

**Dispatch service** records source, destination, bounded prompt, selected
Artifact references, and delivery state. It never copies the source transcript
or chooses a destination automatically.

**Artifact service** owns durable work products, versions, preview state, and
the switch between multi-Conversation Workbench and Artifact Review.

**Office Tool Pack** supplies typed operations for DOCX, XLSX, PPTX, and PDF.
Plain text, Markdown, and HTML use normal Model and local-file capabilities.
Historical document-runtime research is input to this module, not an already
accepted implementation stack.

**Pi RPC adapter** translates between the ScopeGuard application contract and a
pinned Pi RPC version. It owns protocol compatibility tests and process
supervision, not product policy or UI state.

## Persistence

ScopeGuard local storage contains product metadata, layouts, Agent definitions,
Artifact records, Dispatch records, and Pi session locators. Pi owns its runtime
session and compaction data. Workspace source files remain ordinary local files.
Provider credentials must use operating-system protected storage or a Pi
mechanism qualified during Phase 1; they must not be stored in plaintext product
metadata.

There is no migration from the retired development schema. The first runtime
replacement migration creates a fresh schema and must reject accidental opening
of incompatible old databases rather than partially interpreting them.

## Concurrency And Isolation

- One Conversation has at most one active Run.
- Different Conversations may run concurrently, including with different Agents
  and Models.
- A Dispatch targets an existing Conversation in the same Workspace.
- Conversation history is not implicitly shared.
- Shared Workspace writes retain version checks and stop on conflicts.
- Closing a pane does not delete a Conversation or stop an active Run.

## Explicit Non-Goals

- Organization, Administrator, Member, Agent Template, or Admin Console models.
- ScopeGuard-hosted enterprise RAG or knowledge ingestion.
- Automatic routing, autonomous Agent creation, or hidden orchestration.
- A second native Agent Runtime beside Pi.
- Pretending external coding CLI Harnesses have one uniform contract.
- Cloud Workspace synchronization or unattended 24/7 remote execution in V1.
- Long-term support for both the retired and new schemas.

## Delivery Phases

1. Phase 0: product contract, ADR, wayfinding, and historical checkpoint.
2. Phase 1: Pi RPC qualification prototype and go/no-go decision.
3. Phase 2: fresh local schema and runtime replacement behind stable interfaces.
4. Phase 3: multi-Conversation workbench, explicit Dispatch, and recovery.
5. Phase 4: Artifact Review and the bounded Office Tool Pack.
6. Phase 5: packaging, cross-platform verification, and real-project pilot.

Each phase advances only after the exit gate in
[VERIFICATION.md](./VERIFICATION.md) and the active GitHub Wayfinder map passes.
