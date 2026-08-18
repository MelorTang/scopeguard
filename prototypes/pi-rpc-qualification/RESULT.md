# Pi RPC Qualification Result

Status: Third candidate evidence for Phase 1 review on 2026-08-18.

## Verdict

**Go with constraints for Pi RPC plus a mandatory, default-fail-closed
ScopeGuard Tool policy extension.** The pinned package provides usable process,
streaming, Tool, Session, interrupt, compaction, Provider, and four-process
concurrency contracts.

This is not a Go for bare Pi RPC or arbitrary extensions. Request Approval is
valid only when startup disables discovery, verifies the committed extension
manifest and hashes, loads exactly one final Tool policy, and binds approval to the exact process,
RPC request ID, Tool call ID/name, canonical input, and input SHA-256. A missing,
changed, reordered, or disconnected policy fails closed.

## Fixed Runtime

| Item                | Qualified value                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Package             | `@earendil-works/pi-coding-agent@0.84.2`                                                          |
| Git tag / commit    | `v0.84.2` / `914cf1472e715297caa30db4b9535d534a9eb718`                                            |
| npm integrity       | `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==` |
| License             | MIT                                                                                               |
| Qualification host  | macOS arm64, Node.js `v26.0.0`                                                                    |
| Provider            | Deterministic local OpenAI-compatible SSE fake                                                    |
| Dependency boundary | Prototype-owned package and frozen lockfile; absent from root workspace and root lock             |

## Observed Matrix

| Contract                           | Result               | Classification        | Evidence                                                                                                                                                                                 |
| ---------------------------------- | -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn, version, ready              | Pass                 | lossy                 | CLI reports `0.84.2`; correlated `get_state` is readiness because RPC has no handshake/version command.                                                                                  |
| Graceful shutdown                  | Pass                 | lossy                 | Closing stdin exits 0 without a shutdown acknowledgement.                                                                                                                                |
| Host termination and crash         | Pass                 | lossy                 | SIGTERM becomes exit 143; SIGKILL remains distinct; errors preserve bounded redacted diagnostics.                                                                                        |
| Streaming text                     | Pass                 | exact                 | LF JSONL preserves U+2028 and ordered message events through `agent_settled`.                                                                                                            |
| Tool call and result               | Pass                 | exact                 | Authoritative arguments, execution IDs/content/details/error, and persisted `toolResult` payloads correlate.                                                                             |
| Default Tool policy                | Pass                 | exact                 | Unmarked `bash`, `write`, and `edit` all requested approval; reject paths persisted errors with no effect.                                                                               |
| Read-only allowlist                | Pass                 | exact                 | Only explicit `read` auto-allowed and completed without an approval request.                                                                                                             |
| Unknown Tool default               | Pass                 | exact                 | A registered unknown mutating Tool was blocked, persisted, and produced no file effect.                                                                                                  |
| Approval binding                   | Pass                 | exact                 | Request carries canonical input and SHA-256; host tuple includes process, request ID, Tool ID/name, and hash.                                                                            |
| Approve/reject/cancel/timeout      | Pass                 | exact                 | Approve executes only after response; all false paths persist correlated blocks without effects.                                                                                         |
| RPC response validation            | Pass                 | exact                 | Forged type/ID, mixed members, wrong types, false cancel, and extra fields throw before wire write.                                                                                      |
| Extension composition              | Pass                 | exact                 | Manifest hash drift, unknown IDs, multiple/misordered policy composition, and post-policy mutators fail before spawn.                                                                    |
| Pre-policy mutation                | Pass                 | exact with constraint | A declared earlier mutator changed input; the final policy approved the changed hash and only the changed command executed. Production should omit mutators unless explicitly qualified. |
| Extension error                    | Pass                 | exact                 | A thrown final policy handler persists an error and does not execute the Tool.                                                                                                           |
| Host disconnect                    | Pass                 | exact                 | Closing the owning process during confirmation produces no Tool effect; no completed blocked result is claimed.                                                                          |
| Approval isolation                 | Pass                 | exact                 | Two processes produced distinct IDs and affected only their owning Conversation.                                                                                                         |
| Four concurrent Sessions           | Pass                 | exact                 | Four independent processes exposed distinct Session IDs and settled concurrently.                                                                                                        |
| Targeted interrupt                 | Pass                 | exact                 | Aborting one process did not stop three peers.                                                                                                                                           |
| Interrupted Tool effect            | Pass                 | lossy                 | The Tool left a partial file, so ScopeGuard must record `effect_unknown`.                                                                                                                |
| Session create/resume              | Pass                 | exact                 | Opaque locator and format v3 survived process restart with prior provider-visible history.                                                                                               |
| Session compatibility              | Pass with constraint | lossy                 | RPC has no format negotiation; upgrades require pin, backup, open-copy test, and rollback.                                                                                               |
| Compaction and recovery            | Pass                 | exact                 | Real manual compaction persisted, survived restart, and continued.                                                                                                                       |
| Provider/model and errors          | Pass                 | exact                 | Fixed profile selects the model; invalid model and HTTP 503 remain distinct.                                                                                                             |
| Credential boundary                | Pass                 | lossy                 | The fake key reached only the Provider and was absent from temporary files.                                                                                                              |
| Unknown event                      | Pass with constraint | unsupported           | A synthetic future event is preserved without success semantics.                                                                                                                         |
| UTF-8 diagnostic bound and cleanup | Pass                 | exact                 | Multibyte stderr remained at or below 2,048 bytes without broken code points; protocol failure propagated and all temporary resources were removed.                                      |

## Approval Sequence

```text
controlled extension manifest + SHA-256 verification
  -> earlier declared registration/mutator fixtures, if any
  -> final ScopeGuard tool_call policy
  -> explicit read allow OR unknown block OR canonical approval payload
  -> RPC extension_ui_request owned by one Pi process
  -> strict matching-ID extension_ui_response
  -> execute exact approved input or persist blocked toolResult
```

`tool_execution_start` is not approval. Pi emits it before the pre-execution
extension decision. In a composition with mutation, the model's
`toolcall_end` remains the original input; the final policy request is the
authoritative approval input. This is why production startup must control the
entire extension list and forbid any handler after the policy.

## Command And Output

From the repository root:

```bash
pnpm qualify:pi-rpc
```

The command performs the prototype's independent frozen install and exits
non-zero on any failed assertion. The successful third-candidate run reported:

```json
{
  "package": "@earendil-works/pi-coding-agent@0.84.2",
  "license": "MIT",
  "node": "v26.0.0",
  "platform": "darwin-arm64",
  "checks": 26,
  "exact": 21,
  "lossy": 4,
  "unsupported": 1,
  "result": "qualification-complete"
}
```

Classifications are runtime-validated finite values. The unsupported record is
safe unknown-event interpretation, not a required-contract failure.

## Evidence Boundary

- No real Provider smoke or Windows extension packaging run was performed.
- Automatic threshold compaction remains unqualified; manual RPC compaction and
  post-restart continuation are qualified.
- Phase 2 must package and verify the manifest/policy hash as Runtime readiness,
  reject unmanaged extensions, and persist the process-bound approval tuple.
- Production permission-level mapping and process-loss recovery remain Phase 2
  implementation gates.
- Pi remains Session and transcript truth. ScopeGuard must not fabricate a
  replacement transcript or compaction history.
