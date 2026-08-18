# Pi RPC Qualification Result

Status: Revised candidate evidence for Phase 1 review on 2026-08-18.

## Verdict

**Go with constraints for Pi RPC plus a required ScopeGuard approval
extension.** The pinned package reliably provides process, streaming, Tool,
Session, interrupt, compaction, Provider, and four-process concurrency contracts.
Its official pre-execution `tool_call` hook and RPC extension UI protocol form a
working host approval bridge.

This is not a Go for bare Pi RPC. Request Approval requires the packaged
extension to load successfully and remain connected to the owning host. A lost
or corrupt approval channel must fail Runtime readiness or stop the owning Run.
Already-started Tool effects remain a separate certainty problem and map to
ScopeGuard's `effect_unknown` when no trustworthy result exists.

## Fixed Runtime

| Item | Qualified value |
| --- | --- |
| Package | `@earendil-works/pi-coding-agent@0.84.2` |
| Git tag / commit | `v0.84.2` / `914cf1472e715297caa30db4b9535d534a9eb718` |
| npm integrity | `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==` |
| License | MIT |
| Qualification host | macOS arm64, Node.js `v26.0.0` |
| Provider | Deterministic local OpenAI-compatible SSE fake; no real credential used |
| Approval extension | `approval-extension.ts`, loaded by official `--extension` |

The exact Pi dependency belongs to the private
`@scopeguard/pi-rpc-qualification` workspace, not the repository root or a
product package. The pnpm workspace has one shared lockfile, so Pi's transitive
`yaml` peer still changes Vite's peer-resolution snapshot. No product source or
bundle imports Pi in Phase 1. Phase 2 must move the exact dependency to the
Runtime-owning package and regenerate/review the shared lockfile.

## Observed Matrix

| Contract | Result | Classification | Evidence |
| --- | --- | --- | --- |
| Spawn, version, ready | Pass | lossy | CLI reports `0.84.2`; correlated `get_state` is the bounded readiness policy because RPC has no handshake/version command. |
| Graceful shutdown | Pass | lossy | Closing stdin exits 0. There is no shutdown acknowledgement. |
| Host termination and crash | Pass | lossy | SIGTERM becomes exit 143; SIGKILL remains a distinct signal; startup/model errors use non-zero exit and redacted stderr. |
| Streaming text | Pass | exact | LF JSONL preserves U+2028 and orders message start, deltas, authoritative message end, and `agent_settled`. |
| Tool call mapping | Pass | exact | `toolcall_end.toolCall` ID/name/full arguments equal execution ID/name/args; partial deltas are not executed. |
| Tool result mapping | Pass | exact | `tool_execution_end` content, optional details presence/value, `isError`, and concrete success/error text equal the persisted Pi `toolResult` payload. |
| Extension approve | Pass | exact | Tool effect is absent before confirm; matching-ID `confirmed:true` permits execution and persists the correlated success result. |
| Extension reject/cancel/timeout | Pass | exact | Each resolves to `block:true`; no Tool effect exists and a scenario-specific error body is persisted. Timeout uses Pi's 150 ms dialog timeout. |
| Extension error | Pass | exact | A thrown `tool_call` handler becomes a persisted error Tool result and the Tool implementation does not run. |
| Host disconnect during approval | Pass | exact | Closing stdin while confirm is pending exits 0 without executing the Tool effect. No completed blocked result is claimed for this process-loss case. |
| Approval isolation | Pass | exact | Two Pi processes emit different opaque IDs; approve and reject responses affect only their owning Conversation. |
| Four concurrent Sessions | Pass | exact | Four independent Pi processes expose distinct Session IDs and settle concurrently. One Pi process has one active Session. |
| Targeted interrupt | Pass | exact | Aborting one process stops only its Session; three peers complete. |
| Interrupted Tool effect | Pass | lossy | The target wrote a marker before abort. Pi reports abort/error but not effect certainty; ScopeGuard must record `effect_unknown`. |
| Session create and locator | Pass | exact | `new_session` returns `cancelled=false`; `get_state` exposes the new ID and opaque file locator. |
| Restart and resume | Pass | exact | Restart with the locator preserves Session ID, Pi-owned history, and provider-visible prior context. |
| Session compatibility | Pass with constraint | lossy | Qualified files use format v3. RPC has no compatibility negotiation; upgrades require pin, backup, open-copy test, and rollback. |
| Compaction and recovery | Pass | exact | Real manual `compact` calls the Provider, emits start/end, persists a Pi entry, survives restart, and continues. |
| Provider/model | Pass | exact | Isolated `models.json` selects the fixed Provider/model; invalid model and HTTP 503 paths remain distinct. |
| Credential boundary | Pass | lossy | The fake key reaches only the Provider and is absent from profile, Workspace, Session, and committed fixtures. Dynamic Provider/auth mutation is not RPC. |
| Unknown event | Pass with constraint | unsupported | A synthetic future record is preserved and classified unknown without success semantics. RPC has no event-schema negotiation. |
| Forced protocol failure cleanup | Pass | exact | Invalid JSONL becomes a propagated bounded/redacted error; child, fake Provider, profile, Workspace, Sessions, and temporary root are removed. |
| Normal cleanup | Pass | exact | All Pi children, Provider, profile, Workspace, and Sessions are removed. |

## Approval Sequence

The executable bridge is:

```text
assistant toolcall_end
  -> Pi tool_execution_start
  -> extension tool_call (Tool implementation has not run)
  -> ctx.ui.confirm
  -> RPC extension_ui_request { id, method: "confirm" }
  -> host extension_ui_response { id, confirmed | cancelled }
  -> extension allow or { block: true, reason }
  -> Tool execution or persisted blocked toolResult
```

`tool_execution_start` is not treated as approval. The extension hook is the
pre-execution boundary, and the opaque RPC UI ID is valid only in its owning Pi
process.

## Command And Output

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm qualify:pi-rpc
```

The command exits non-zero on any failed assertion. The revised successful run
reported:

```json
{
  "package": "@earendil-works/pi-coding-agent@0.84.2",
  "license": "MIT",
  "node": "v26.0.0",
  "platform": "darwin-arm64",
  "checks": 21,
  "exact": 16,
  "lossy": 4,
  "unsupported": 1,
  "result": "qualification-complete"
}
```

Classifications are runtime-validated finite values. The unsupported count is
safe unknown-event interpretation, not a failed required contract. The 21 count
is the number of emitted evidence records; the matrix separates some combined
records into individual contract rows.

## Evidence Boundary

- No real Provider smoke was run. Deterministic protocol evidence does not claim
  service-specific compatibility.
- Windows process and extension packaging behavior remain unqualified.
- Automatic threshold compaction was not tested; the qualified contract is the
  real manual RPC compaction and post-restart continuation.
- Extension load/hash readiness, production permission-level mapping, and
  process-loss recovery belong to Phase 2 implementation and verification.
- The fake Provider is not transcript truth. Pi's Session JSONL, Tool results,
  and compaction entries remain authoritative.
- Each Pi or extension change must rerun this command and an open-copy Session
  migration test before production pin changes.
