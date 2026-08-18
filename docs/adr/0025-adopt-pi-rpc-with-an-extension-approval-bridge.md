# Adopt Pi RPC with a controlled approval extension

Status: Accepted constrained Go on 2026-08-18.

Phase 1 passed independent Standards and Spec review with zero findings on
2026-08-18. The accepted evidence reran the pinned qualification at 26/26: 21
exact, 4 lossy, and 1 unsupported mapping.

Qualifies the Pi RPC preference in ADR 0024. It does not start Phase 2 or
authorize formal Runtime, schema, or Renderer changes.

## Context

The qualification pins official `@earendil-works/pi-coding-agent@0.84.2`, tag
`v0.84.2`, commit `914cf1472e715297caa30db4b9535d534a9eb718`, under MIT.
Pi's pre-execution `tool_call` hook can block a Tool, while RPC mode projects
`ctx.ui.confirm()` as matching-ID `extension_ui_request` and
`extension_ui_response` records.

Two Pi details define the security contract:

1. `tool_call` handlers run serially in extension load order;
2. handlers may mutate `event.input`, later handlers see that mutation, and Pi
   performs no validation after mutation.

Therefore an extension that approves only marked commands, or one followed by a
mutating handler, is not an approval boundary. Model text and Tool arguments
cannot select whether policy applies.

The third qualification candidate uses a committed extension manifest with
SHA-256 pins. It requires exactly one final Tool policy. `read` is explicitly
auto-allowed; `bash`, `write`, and `edit` require confirmation; every unknown or
unclassified Tool blocks. The approval request includes canonical Tool input
and its SHA-256. The host binds this to the owning process, RPC request ID, Tool
call ID, and Tool name.

## Decision

The Phase 1 candidate verdict is **Go with constraints** for Pi RPC plus a
mandatory ScopeGuard-owned approval extension.

ScopeGuard may claim Request Approval only when all of these are true:

1. Pi and the extension manifest are exact-version inputs.
2. Automatic extension discovery is disabled; every loaded extension is in the
   manifest and matches its SHA-256.
3. Exactly one Tool policy is loaded and it is the final extension.
4. Known side-effecting Tools require confirmation; unknown Tools block.
5. Read-only automatic permission is an explicit, tested allowlist.
6. The approval tuple is `(process, requestId, toolCallId, toolName,
canonicalInputSha256)` and the canonical input is shown or retained with it.
7. RPC responses match one legal union member; callers cannot override the wire
   type or request ID.

Any missing policy, load error, hash drift, unmanaged extension, wrong ordering,
protocol corruption, or lost approval channel fails Runtime readiness or stops
the owning Run. ScopeGuard does not silently fall back to unapproved execution.

## Approval Outcomes

| Host or policy outcome            | Product consequence                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Explicit read-only allowlist      | Execute without a dialog.                                                               |
| Approve exact tuple               | Execute the canonical input approved by the host.                                       |
| Reject, cancel, or timeout        | Block before implementation and persist Pi's identifiable error Tool result.            |
| Unknown or unclassified Tool      | Block without asking and persist the policy reason.                                     |
| Extension error                   | Persist an error result; do not execute the Tool.                                       |
| Host disconnect while pending     | Stop the owning process; no approval exists and no completed blocked result is assumed. |
| Interrupt after execution started | Use `effect_unknown` without a trustworthy effect receipt.                              |

`tool_execution_start` is an observation, not approval. In Pi 0.84.2 it can be
emitted before extension preflight. If an explicitly qualified earlier mutator
exists, the final policy request, not the original model `toolcall_end`, binds
the executable input. Production should omit mutators unless their exact
composition is separately qualified.

## Ownership

Pi owns:

- Agent loop and Provider protocols;
- Tool invocation and Pi Tool result records;
- Session JSONL transcript, opaque locator, and compaction;
- extension loading and ordered handler execution.

ScopeGuard owns:

- approval policy, allowlist, canonicalization, manifest, hashes, and ordering;
- strict RPC response validation and process-bound request correlation;
- process supervision, readiness, UTF-8-byte-bounded redacted diagnostics, and
  code/signal/protocol-error classification;
- one active Pi process per running Conversation;
- `effect_unknown`, Workspace/Agent/Conversation mapping, Artifact, Dispatch,
  version pinning, Session backup, upgrade qualification, and rollback.

ScopeGuard must not copy Pi's transcript into a competing source of truth or
replace Pi compaction with its own summary.

## Qualified Contracts

| Area                  | Result                            | Required production rule                                                                                     |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Process               | lossy                             | Pin CLI, use `get_state` readiness, close stdin, and classify byte-bounded redacted stderr plus code/signal. |
| Streaming             | exact                             | Preserve LF wire order; authoritative completion is `message_end` then `agent_settled`.                      |
| Tool result           | exact                             | Correlate IDs, arguments, execution result, persisted `toolResult`, and effect certainty separately.         |
| Approval policy       | exact for the pinned manifest     | Default block unknown Tools; approve all known side effects; auto-allow only tested read-only entries.       |
| Argument binding      | exact for controlled composition  | Canonicalize and hash the final policy input; bind it to process/request/Tool IDs.                           |
| Extension ordering    | exact startup gate                | Reject unknown/hash-mismatched composition and every extension after the single policy.                      |
| Session create/resume | exact                             | Store Pi path/ID as an opaque locator with pinned Pi version.                                                |
| Four-way concurrency  | exact                             | One running Conversation per isolated Pi process.                                                            |
| Targeted interrupt    | exact, effect projection lossy    | Abort only the owning process; uncertain started effects become `effect_unknown`.                            |
| Compaction            | exact for manual RPC compaction   | Preserve Pi events, entries, and locator-based restart.                                                      |
| Provider/model        | exact at spawn, lossy dynamically | Build isolated profile before spawn; never send credentials over RPC.                                        |
| Compatibility         | lossy                             | Preserve unknown events without success semantics and qualify copied Sessions before upgrade.                |

## Dependency Boundary

The Phase 1 qualification owns an independent `package.json` and frozen
`pnpm-lock.yaml` and is excluded from the root pnpm workspace. Pi and its peer
graph do not change the Desktop Vite snapshot. The root command performs the
prototype frozen install and qualification in one step.

Phase 2 may move the exact Pi dependency into a Runtime-owning product package.
That future lockfile change becomes Desktop-owned and must pass root frozen
install, typecheck, tests, build, qualification, and explicit peer-resolution
review.

## Mandatory Phase 2 Gates

1. Package the policy and manifest; verify their hashes and final ordering as
   part of readiness before enabling any Tool.
2. Persist and reconcile the complete approval tuple; never route only by Tool
   name or call ID.
3. Keep response validation fail-closed and prevent caller-supplied type/ID.
4. Keep one process per running Conversation and stop only its owning Run on
   approval-channel loss.
5. Keep Pi at one exact version; do not fork or vendor it.
6. Re-run qualification before changing Pi, policy, manifest, allowed Tools, or
   process topology.
7. Back up and open-copy test Sessions before upgrade; rollback executable,
   policy, and untouched Session backup together.

## Consequences

- Pi RPC is supportable only behind a small but strict ScopeGuard policy module.
- Arbitrary user extensions cannot join the managed Pi Runtime composition in
  Request Approval mode. User-controlled high-power CLI remains outside this
  managed Runtime as previously decided.
- Real Provider smoke, Windows packaging, automatic threshold compaction,
  production permission mapping, and Session migration remain later gates.
- Executable evidence is in `prototypes/pi-rpc-qualification/RESULT.md`; pinned
  source analysis is in `docs/research/pi-rpc-qualification.md`.
