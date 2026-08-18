# Do not replace the Runtime with stock Pi RPC

Status: Proposed No-Go on 2026-08-18; pending Phase 1 review.

Qualifies the Pi RPC preference in ADR 0024. It does not supersede ADR 0024 or
authorize a different Runtime.

## Context

ADR 0024 made Pi RPC the preferred Agent Runtime boundary only if Phase 1 could
reliably map process lifecycle, streaming, Tool behavior, interruption,
Session recovery, compaction, Provider configuration, and four-way concurrency.
The qualification fixed official package
`@earendil-works/pi-coding-agent@0.84.2` at upstream commit
`914cf1472e715297caa30db4b9535d534a9eb718` and ran the published CLI against a
deterministic local Provider.

The executable prototype proves that Pi can own the Agent loop, Provider
protocol, Session transcript, and compaction while ScopeGuard owns a process
per active Conversation. Four Sessions execute concurrently; a targeted abort
does not stop peers; an opaque locator survives restart; and a Pi-generated
compaction entry survives a second restart.

The same qualification found a critical mismatch. ScopeGuard's User-selected
permission level must decide whether a side-effecting Tool may execute. Stock Pi
RPC emits Tool execution events but has no host command that pauses a pending
Tool and accepts an approve or reject decision. It also does not report whether
an interrupted Tool's side effect was absent, completed, or partial. The
prototype deliberately creates a partial file effect before abort, demonstrating
why `isError` and an aborted Run cannot be treated as rollback evidence.

## Decision

Do not enter the Phase 2 Runtime replacement using stock Pi RPC. The Phase 1
candidate verdict is **No-Go** because the required Tool permission contract is
unsupported and the effect-certainty contract is lossy.

Pi remains the preferred candidate only if a new, bounded qualification proves
an official extension-based pre-execution Tool approval boundary. Such a bridge
must preserve Pi as the Agent loop and Session truth, must not vendor or fork Pi,
and must map an interrupted non-idempotent Tool without a trustworthy receipt to
ScopeGuard's `effect_unknown`. Observation-only event interception is not an
approval mechanism.

No formal Runtime, schema, or Renderer change is authorized by this ADR.

## Ownership If The Blocker Is Resolved

Pi owns:

- the Agent loop and Provider protocol implementation;
- Tool invocation and result records;
- the Session JSONL transcript and opaque locator;
- compaction generation, entries, and reconstructed context.

ScopeGuard owns:

- process supervision, readiness timeout, exit/stderr classification, and one
  active Pi process per running Conversation;
- User-visible permission policy and any proven approval bridge;
- conservative `effect_unknown` projection;
- Workspace, Agent, Conversation mapping, Artifact, and Dispatch metadata;
- version pinning, unknown-event handling, Session backup, upgrade gate, and
  rollback policy.

ScopeGuard must not copy Pi's transcript into a competing source of truth or
replace Pi compaction with a ScopeGuard summary.

## Qualified Contracts

| Area | Result | Required production rule |
| --- | --- | --- |
| Process | lossy | Pin CLI version, use `get_state` readiness, close stdin for graceful exit, bound stderr, and classify code/signal in the host. |
| Streaming | exact | Preserve LF wire order; assemble by content index; commit authoritative `message_end`; complete at `agent_settled`. |
| Tool events/results | exact | Correlate only completed calls by Tool call ID and keep `isError` separate from effect certainty. |
| Tool approval | unsupported, blocker | Do not claim Request Approval mode until a supported pre-execution bridge passes a separate prototype. |
| Session create/resume | exact | Store Pi's Session ID and file path as an opaque locator with the pinned Pi version. |
| Four-way concurrency | exact | Run one active Conversation per isolated Pi process; never switch one process among simultaneously running Conversations. |
| Targeted interrupt | exact | Address abort to the owning process; map uncertain started Tool effects to `effect_unknown`. |
| Compaction | exact | Preserve Pi compaction events and entries and restart from the same opaque locator. |
| Provider/model | exact at spawn, lossy dynamically | Build an isolated profile before spawn; do not send credentials over RPC or command arguments. Restart for configuration changes. |
| Compatibility | lossy | Tolerate and preserve unknown events without success semantics. Qualify upgrades on a copied Session before opening user truth. |

## Upgrade Strategy

1. Pin one exact Pi package version and npm integrity in the lockfile.
2. Associate every opaque Session locator with that version.
3. Before upgrading, back up the Session and run the full qualification plus an
   open-copy migration test; Pi may rewrite older Session formats.
4. Accept unknown events as opaque diagnostics only, never as known success.
5. Roll back the executable and untouched backup together if qualification or
   migration fails. Downgrade compatibility is not assumed.

## Consequences

- Phase 1 can be reviewed and closed with a No-Go result, but Phase 2 remains
  blocked rather than starting a knowingly incomplete replacement.
- The process, Session, Provider, interrupt, and compaction findings remain
  reusable if the Tool approval bridge later passes.
- A real-Provider smoke test would add service evidence but cannot fix the stock
  RPC permission blocker.
- The full evidence and repeatable command live in
  `prototypes/pi-rpc-qualification/RESULT.md`; pinned source analysis lives in
  `docs/research/pi-rpc-qualification.md`.
