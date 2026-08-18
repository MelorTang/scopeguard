# Adopt Pi RPC with an extension approval bridge

Status: Proposed constrained Go on 2026-08-18; pending Phase 1 review.

Qualifies the Pi RPC preference in ADR 0024. It does not start Phase 2 or
authorize a formal Runtime, schema, or Renderer change.

## Context

ADR 0024 prefers Pi RPC only if Phase 1 can reliably map process lifecycle,
streaming, Tool behavior, interruption, Session recovery, compaction, Provider
configuration, and four-way concurrency. The qualification pins official
`@earendil-works/pi-coding-agent@0.84.2` at upstream commit
`914cf1472e715297caa30db4b9535d534a9eb718` and runs its published CLI against a
deterministic local Provider.

The first candidate incorrectly treated the absence of a bare RPC approve
command as a Runtime blocker. Pi exposes a supported composition instead:

1. an extension `tool_call` hook runs before the Tool implementation and may
   return `{block: true, reason}`;
2. `ctx.ui.confirm()` becomes an `extension_ui_request` in RPC mode;
3. ScopeGuard returns an `extension_ui_response` using the same opaque request
   ID; and
4. the extension either allows execution or returns a blocked Tool result.

The revised prototype loads a minimal extension through Pi's official
`--extension` argument. It proves approve, reject, cancel, timeout, extension
error, host disconnect, persisted blocked results, and two-process approval
isolation. This is pre-execution control; `tool_execution_start` observation is
not used as an approval mechanism.

Pi still has no effect-certainty field. The prototype separately proves that an
aborted bash Tool can leave a partial file effect. An error or aborted Run is
therefore not rollback evidence.

## Decision

The Phase 1 candidate verdict is **Go with constraints** for Pi RPC as the
ScopeGuard Runtime boundary. Phase 2 may begin only after this ADR and the Phase
1 evidence pass review.

The supported integration is Pi RPC plus a pinned, ScopeGuard-owned Pi
extension that performs pre-execution Tool policy. ScopeGuard must never claim
Request Approval mode when that extension is absent, failed to load, or cannot
reach the host. The process must fail readiness rather than continue with an
unapproved side-effecting Tool surface.

Approval outcomes map as follows:

| Host outcome | Extension result | Product consequence |
| --- | --- | --- |
| Approve | no block | Pi may execute the correlated Tool. |
| Reject | `block: true` | No Tool implementation runs; persist Pi's identifiable error Tool result. |
| Cancel | `block: true` | Same fail-closed result as reject. |
| Timeout | confirmation defaults false, then `block: true` | No Tool implementation runs; persist the timeout-scenario block result. |
| Extension error | Pi converts the thrown preflight error to an error Tool result | No Tool implementation runs; surface and persist the failure. |
| Host disconnect while pending | Pi process shuts down | No approved Tool runs; recover the unfinished Run conservatively. |

An interrupted non-idempotent Tool that may already have started and lacks a
trustworthy receipt maps to ScopeGuard's `effect_unknown`. Pi's `isError`, abort,
timeout, process exit, or missing response does not prove absence of effect.

## Ownership

Pi owns:

- the Agent loop and Provider protocol implementation;
- Tool invocation and Pi Tool result records;
- the Session JSONL transcript and opaque locator;
- compaction generation, entries, and reconstructed context;
- extension loading and the pre-execution `tool_call` hook invocation.

ScopeGuard owns:

- the approval extension source, version, policy, and startup requirement;
- presenting RPC confirmation requests and returning responses by opaque ID;
- process supervision, readiness timeout, bounded redacted stderr, and
  code/signal/protocol-error classification;
- one active Pi process per running Conversation;
- conservative `effect_unknown` projection and recovery;
- Workspace, Agent, Conversation mapping, Artifact, and Dispatch metadata;
- Pi version pinning, unknown-event handling, Session backup, upgrade gate, and
  rollback policy.

ScopeGuard must not copy Pi's Transcript into a competing source of truth or
replace Pi compaction with a ScopeGuard summary.

## Qualified Contracts

| Area | Result | Required production rule |
| --- | --- | --- |
| Process | lossy | Pin CLI version, use correlated `get_state` readiness, close stdin for graceful exit, and classify bounded redacted stderr plus code/signal. |
| Streaming | exact | Preserve LF wire order; assemble by content index; commit authoritative `message_end`; complete at `agent_settled`. |
| Tool call/result | exact | Use authoritative `toolcall_end` arguments, correlated execution result content/details, and persisted `toolResult`; keep `isError` separate from effect certainty. |
| Tool approval bridge | exact for the pinned prototype | Load the required extension; answer only the matching opaque confirmation ID; reject, cancel, timeout, extension failure, and disconnect fail closed. |
| Session create/resume | exact | Store Pi's Session ID and file path as an opaque locator with the pinned Pi version. |
| Four-way concurrency | exact | Run one active Conversation per isolated Pi process; never switch one process among simultaneously running Conversations. |
| Targeted interrupt | exact, effect projection lossy | Address abort to the owning process; uncertain started Tool effects become `effect_unknown`. |
| Compaction | exact for manual RPC compaction | Preserve Pi compaction events and entries and restart from the same opaque locator. |
| Provider/model | exact at spawn, lossy dynamically | Build an isolated profile before spawn; do not send credentials over RPC or command arguments. Restart for configuration changes. |
| Compatibility | lossy | Preserve unknown events without success semantics and qualify upgrades on copied Sessions before opening user truth. |

## Mandatory Phase 2 Constraints

1. Package the approval extension with the Desktop Runtime and include its hash
   or version in readiness evidence.
2. Treat extension load diagnostics, protocol corruption, and approval-channel
   loss as fail-closed Runtime failures.
3. Keep Pi at one exact package version; do not vendor or fork its source.
4. Keep one process per active Conversation and route every confirmation by the
   owning process plus Pi request ID.
5. Persist Pi's blocked Tool result, but use ScopeGuard's canonical
   `effect_unknown` status for uncertain already-started effects.
6. Bound and redact stderr and protocol diagnostics before persistence or UI.
7. Re-run the complete qualification before changing Pi, the extension, or the
   process topology.

## Upgrade Strategy

1. Pin the Pi package version and npm integrity in the qualification/Runtime
   workspace lockfile.
2. Associate every opaque Session locator with that version.
3. Back up the Session and run the full qualification plus an open-copy
   migration test before upgrade; Pi may rewrite older Session formats.
4. Accept unknown events as opaque diagnostics only, never as known success.
5. Roll back the executable, extension, and untouched Session backup together.
   Downgrade compatibility is not assumed.

## Consequences

- Phase 1 has a supportable Go candidate instead of a false bare-RPC No-Go.
- Request Approval depends on a small product extension, but Pi remains the
  Agent loop and Session truth; ScopeGuard does not fork the Runtime.
- Automatic compaction policy, real Provider smoke, Windows behavior, extension
  packaging/hash validation, and Session migration remain later gates.
- The executable evidence is in
  `prototypes/pi-rpc-qualification/RESULT.md`; fixed-source analysis is in
  `docs/research/pi-rpc-qualification.md`.
