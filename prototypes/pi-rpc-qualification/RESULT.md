# Pi RPC Qualification Result

Status: Complete candidate evidence for Phase 1 review on 2026-08-18.

## Verdict

**No-Go for replacing the ScopeGuard Runtime with stock Pi RPC.** The pinned
package is a viable process and Session engine, but its Tool contract cannot
reliably implement ScopeGuard's User-selected permission levels: RPC reports a
Tool only as it starts and provides no host command to approve or reject it
before execution. Pi also has no effect-certainty field after an interrupted
side-effecting Tool. Observing `isError` or an aborted Run is not proof that the
effect did or did not occur.

This verdict does not reject Pi. It blocks Phase 2 replacement until a separate
prototype proves a supported extension boundary that performs pre-execution
approval and lets ScopeGuard conservatively record `effect_unknown` without
forking or vendoring Pi.

## Fixed Runtime

| Item | Qualified value |
| --- | --- |
| Package | `@earendil-works/pi-coding-agent@0.84.2` |
| Git tag / commit | `v0.84.2` / `914cf1472e715297caa30db4b9535d534a9eb718` |
| npm integrity | `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==` |
| License | MIT |
| Qualification host | macOS arm64, Node.js `v26.0.0` |
| Provider | Deterministic local OpenAI-compatible SSE fake; no real credential used |

The package is an exact root dev dependency and the integrity is retained in
`pnpm-lock.yaml`. The harness invokes the installed `dist/cli.js` with
`--mode rpc`; it does not vendor Pi source.

## Observed Matrix

| Contract | Result | Classification | Evidence |
| --- | --- | --- | --- |
| Spawn, version, ready | Pass | lossy | CLI reports `0.84.2`; a correlated `get_state` is a bounded readiness policy because RPC has no handshake or protocol-version command. |
| Graceful shutdown | Pass | lossy | Closing stdin exits 0. There is no shutdown command or acknowledgement. |
| Host termination and crash | Pass | lossy | SIGTERM becomes numeric exit 143; SIGKILL remains a distinct signal. Startup/model errors use non-zero exit and stderr. |
| Streaming text | Pass | exact | LF JSONL preserves embedded U+2028 and orders message start, text deltas, message end, and `agent_settled`. |
| Tool call and result | Pass | exact | Streamed calls and `tool_execution_start/end` correlate by Tool call ID; success and error results retain `isError`. |
| Host Tool approval | Blocker | unsupported | Stock RPC has no pause/approve/reject command before a built-in Tool executes. |
| Four concurrent Sessions | Pass | exact | Four independent Pi processes expose four distinct Session IDs and settle concurrently. A Pi process has one active Session. |
| Targeted interrupt | Pass | exact | Aborting one active process stops only its Session; three peer Sessions complete. |
| Interrupted Tool effect | Pass | lossy | The target wrote a marker before abort. Pi reports abort/error but no effect certainty, so ScopeGuard must map the outcome to `effect_unknown`. |
| Session create and locator | Pass | exact | `new_session` returns `cancelled=false`; `get_state` exposes the new ID and opaque file locator. |
| Restart and resume | Pass | exact | Restart with `--session <opaque locator>` preserves the Session ID, Pi-owned history, and provider-visible prior context. |
| Session compatibility | Pass with constraint | lossy | Qualified files use Pi format v3. RPC has no compatibility negotiation; upgrades need pin, backup, open-copy qualification, and rollback tests. |
| Compaction and recovery | Pass | exact | Real `compact` emits start/end, calls the provider for a summary, persists a Pi compaction entry, survives process restart, and continues. |
| Provider/model | Pass | exact | An isolated `models.json` selects the fixed local Provider/model; invalid model and HTTP 503 paths remain distinct. |
| Credential boundary | Pass | lossy | The fake key is injected by environment, reaches the Provider, and is absent from profile, Workspace, and Session files. Dynamic credential/provider mutation is not an RPC feature. |
| Unknown event | Pass with constraint | unsupported | A synthetic future record is preserved and classified unknown without product semantics. RPC provides no event-schema negotiation. |
| Cleanup | Pass | exact | Success and failure paths stop children and Provider and remove the temporary profile, Workspace, and Sessions. |

## Command And Output

Run from the repository root:

```bash
pnpm qualify:pi-rpc
```

The command exits non-zero on any failed assertion. The final successful run
reported:

```json
{
  "package": "@earendil-works/pi-coding-agent@0.84.2",
  "license": "MIT",
  "node": "v26.0.0",
  "platform": "darwin-arm64",
  "checks": 16,
  "exact": 11,
  "lossy": 4,
  "unsupported": 1,
  "result": "qualification-complete"
}
```

The count describes executable assertions, not every row in the combined
source-and-runtime matrix. `unsupported` remains a deliberate test of safe
unknown-event handling; the host Tool approval blocker is established by the
pinned protocol and source because no command exists to execute.

## Evidence Boundary

- No real Provider smoke was run. Deterministic protocol, concurrency, failure,
  and credential-path evidence does not claim service-specific compatibility.
- Windows process behavior is not qualified in Phase 1. Phase 5 remains the
  release-platform gate if the Runtime decision later becomes Go.
- The fake Provider is a protocol fixture, not a transcript source. Pi's Session
  JSONL and compaction entry remain the only runtime truth.
- A Pi upgrade is never accepted from a floating version. Each candidate must
  rerun this command and an open-copy Session migration test before the pinned
  production version changes.
