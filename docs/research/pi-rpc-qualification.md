# Pi RPC upstream qualification research

Status: Phase 1 source research; runtime behavior remains subject to the qualification prototype.

Research date: 2026-08-18

## Scope and classification

This note evaluates the official Pi subprocess RPC surface as a candidate runtime boundary for ScopeGuard. It uses only the official repository, release, npm package metadata, source code, and license. It does not treat previous ScopeGuard research as evidence and does not vendor Pi source.

Classifications used below:

- **exact**: the pinned upstream type or implementation exposes the required data and semantics directly.
- **lossy**: an upstream operation exists, but information ScopeGuard needs is absent or inferred.
- **unsupported**: the pinned protocol has no corresponding operation or semantic field.
- **prototype-required**: source inspection suggests a viable mapping, but process, provider, timing, persistence, or concurrency behavior must be demonstrated against the published package before acceptance.

These classifications describe the pinned source contract. They are not test results.

## Fixed upstream

| Item | Pinned value | Primary evidence |
| --- | --- | --- |
| Canonical repository | `earendil-works/pi` | The former `badlogic/pi-mono` repository redirects to the [official repository](https://github.com/earendil-works/pi). The package also names that repository in its [package metadata](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json#L76-L81). |
| Release | [`v0.84.2`](https://github.com/earendil-works/pi/releases/tag/v0.84.2), published 2026-08-14 | Latest official GitHub release at the research date. |
| Git commit | [`914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718) | The `v0.84.2` tag resolves directly to this commit. |
| npm package | [`@earendil-works/pi-coding-agent@0.84.2`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.84.2) | [Pinned package.json](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json#L1-L6). The previous `@mariozechner/pi-coding-agent` scope is not the Phase 1 target. |
| npm integrity | `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==` | [npm registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.84.2) for version `0.84.2`; tarball SHA-1 is `e4d4c1e769963c816959f5cea02a0a10ccc0495a`. |
| Runtime requirement | Node.js `>=22.19.0` | [Package engines](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json#L82-L84). |
| License | MIT, copyright 2025 Mario Zechner | [Pinned LICENSE](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/LICENSE). |

The npm package publishes one `pi` executable backed by `dist/cli.js`; RPC is a CLI mode, not a separate public binary. The package also exports an `rpc-entry` module, but it is not listed as an npm `bin` ([package metadata](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json#L8-L22)).

### Reproducible installation and launch

For a repository-local qualification harness:

```bash
npm install --save-exact --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
./node_modules/.bin/pi --version
```

The pinned integrity must also be retained in the lockfile. Upstream recommends npm installation with `--ignore-scripts` because normal use requires no dependency lifecycle scripts ([official README](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/README.md#L69-L77)).

A qualification process should isolate Pi's profile and session storage:

```bash
PI_CODING_AGENT_DIR="$PROFILE_DIR" \
PI_CODING_AGENT_SESSION_DIR="$SESSION_DIR" \
./node_modules/.bin/pi \
  --mode rpc \
  --offline \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --session-dir "$SESSION_DIR"
```

`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are official configuration hooks ([config source](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/config.ts#L487-L520)); `--offline` disables startup network operations and `--session-dir` controls storage ([CLI arguments](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/cli/args.ts#L264-L306)). A deterministic local fake provider still requires an isolated `models.json` and a supported API implementation; that is prototype work, not established by this note.

## Wire protocol

Pi calls this RPC mode, but the wire format is **not JSON-RPC 2.0**. It is Pi-specific JSONL: one object per LF-delimited line on stdin and stdout. Commands have a `type` and optional `id`; responses have `type: "response"`, `command`, `success`, and optional `data` or `error`; asynchronous events share stdout ([RPC documentation](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L20-L37), [wire types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L1-L25)).

Framing is strict:

- Split only on LF (`\n`).
- Strip an optional preceding CR for CRLF input.
- Do not use a line reader that treats Unicode `U+2028` or `U+2029` as delimiters.
- Responses can be correlated by `id`; most events cannot. Direct `bash_execution_update` is the exception and can carry its originating command `id`.

The official implementation takes exclusive control of stdout and serializes every response/event as JSONL ([RPC mode](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L50-L76)). Diagnostics and startup failures use stderr in the CLI startup path ([main](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/main.ts#L609-L648)).

## Qualification matrix

| ScopeGuard requirement | Classification | Pinned upstream finding | Phase 1 implication |
| --- | --- | --- | --- |
| Spawn a pinned process | **prototype-required** | The package exposes `pi`; `pi --mode rpc` selects RPC. The official client spawns Node with `--mode rpc` and three pipes ([client](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-client.ts#L71-L100)). | Verify macOS/Windows spawn, inherited environment, startup timeout, and cleanup against the published npm package. |
| Protocol version handshake | **unsupported** | `RpcCommand` contains no handshake or version command, and `RpcResponse` contains no protocol version ([command union](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L73)). `pi --version` is a separate one-shot CLI path ([main](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/main.ts#L621-L624)). | ScopeGuard must pin and preflight the executable version outside RPC. It cannot negotiate a wire version after spawn. |
| Ready signal | **lossy** | There is no `ready` event. The official client waits 100 ms and checks whether the child exited ([client](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-client.ts#L127-L140)). Input handling is attached only after runtime/session setup ([RPC mode](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L800-L816)). | Treat a correlated successful `get_state` as an application-level readiness probe and prove its timeout/error behavior. This is ScopeGuard policy, not an upstream handshake. |
| Graceful shutdown | **lossy** | EOF on stdin calls shutdown with exit 0. SIGTERM triggers disposal and exit 143; SIGHUP uses 129 on non-Windows. SIGTERM intentionally does not flush raw stdout ([RPC mode](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L366-L379), [shutdown](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L724-L741), [EOF](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L800-L803)). There is no shutdown command or acknowledgement. | Prefer closing stdin and waiting for exit 0; verify timeout then escalation. Do not interpret SIGTERM 143 as an unexpected crash without knowing who sent it. |
| Unexpected crash and stderr/exit classification | **lossy** | The official client only combines child `code`, `signal`, and accumulated stderr into an error; there is no typed crash event ([client](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-client.ts#L101-L125), [exit error](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-client.ts#L529-L537)). | ScopeGuard must own lifecycle classification and preserve bounded stderr plus code/signal. Test startup error, clean EOF, SIGTERM, SIGKILL, and unhandled failure separately. |
| Prompt acceptance | **exact** | `prompt` emits one correlated response after preflight accepts/queues/handles it; later failures are events/messages, not a second response ([docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L43-L78), [implementation](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L415)). | Separate command acceptance from Run success. Completion must wait for `agent_settled`, not only `agent_end`. |
| Streaming text order | **exact** | `message_start`, indexed `text_start`/`text_delta`/`text_end`, and authoritative `message_end` are defined. Incremental events omit cumulative message snapshots ([JSON event conversion](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/json-event.ts#L17-L45), [RPC stream contract](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L890-L969)). | Assemble by `contentIndex`; treat `message_end.message` as truth. Preserve wire order because events have no sequence number. |
| Tool call streaming | **exact** | Assistant deltas provide `toolcall_start`, argument `toolcall_delta`, and authoritative `toolcall_end.toolCall` ([RPC docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L915-L969)). | Correlate the completed call by its tool call ID; never execute partial argument text. |
| Tool execution result/error | **exact** | `tool_execution_start/update/end` carry `toolCallId`, name, args, result and `isError`; a persisted `toolResult` message also carries ID, name, content/details and `isError` ([RPC docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L983-L1026), [agent loop](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/agent-loop.ts#L767-L790)). | Map transport/result errors exactly, but keep business effect certainty separate. |
| Host-side tool approval | **unsupported** | Stock RPC exposes tool events but no command that pauses and approves/rejects a pending built-in tool. Extension UI requests can ask questions, but that requires an extension-mediated policy path rather than a stock RPC approval primitive ([extension UI types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L233-L283)). | If V1 requires ScopeGuard-owned approval, prototype an official extension boundary or classify Pi RPC as no-go; do not infer approval from observation events. |
| Abort active Run | **exact** | `abort` targets the current session operation and returns a correlated success response ([RPC types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L27), [handler](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L428-L431)). | Verify final event sequence and persisted assistant/tool results for abort during provider streaming and during each built-in tool. |
| `effect_unknown` after interrupted side effects | **unsupported** | Pi passes an `AbortSignal` to tool execution and turns thrown/aborted operations into an error result, but the tool result and event types contain no effect-certainty field ([execution](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/agent-loop.ts#L670-L710), [result event](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/agent-loop.ts#L767-L790)). | ScopeGuard must conservatively assign `effect_unknown` when a non-idempotent tool started but no trustworthy effect receipt exists. Pi's `isError` or `aborted` does not prove rollback. |
| Create a Session | **exact** | `new_session` replaces the active session and returns `{cancelled}`; optional `parentSession` records lineage ([types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L27), [handler](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L433-L440)). | Record state only after `cancelled: false` and a follow-up `get_state`. |
| Session locator and storage | **exact** | `get_state` returns `sessionFile` and `sessionId` ([state type](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L95-L108)). Persistent sessions are Pi-owned JSONL under the configured session directory; defaults are under `~/.pi/agent/sessions/` ([session docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/sessions.md#L5-L18)). | Store Pi's returned path/ID as an opaque locator plus pinned Pi version; do not copy the transcript into a competing source of truth. |
| Resume after process restart | **prototype-required** | There is no literal `resume` RPC command. Startup supports `--session <path|id>` and live RPC supports `switch_session` by path ([session docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/sessions.md#L5-L18), [switch handler](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L601-L607)). `get_entries` offers stable entry IDs as restart cursors ([RPC docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L694-L723)). | Prove create, close, restart with the opaque locator, continue, and cursor reconciliation using the published package. |
| Session version compatibility | **lossy** | Current session format version is 3. Loading v1/v2 mutates entries and rewrites the file; any header version `>=3` bypasses migration, with no explicit supported-max check ([migration](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L230-L295), [load rewrite](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L895-L927)). | Pin Pi with each locator, backup before opening under a newer Pi, and qualification-test upgrades. Do not promise downgrade compatibility. |
| Four concurrent Sessions | **prototype-required** | One RPC runtime holds one mutable `session`; `new_session` and `switch_session` replace it and rebind subscriptions ([RPC mode](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L54-L58), [rebind](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L313-L364)). | A single process is not a four-Session executor. Prototype at least four isolated RPC processes, one active Conversation per process, and prove targeted abort does not affect peers. |
| Manual compaction command and events | **exact** | `compact` returns `CompactionResult`; `compaction_start/end` report reason, result, aborted state, retry and error ([types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L45-L48), [events](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session.ts#L140-L165)). | Preserve the returned Pi compaction entry/result rather than substituting a ScopeGuard summary. |
| Actual compaction trigger and post-resume continuity | **prototype-required** | Auto-compaction depends on context usage, configurable reserve/keep thresholds, and an LLM-generated summary ([compaction docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/compaction.md#L25-L45)). | Use a deterministic provider to trigger manual and threshold compaction, restart, resume, and continue. Failure to observe stable events and persisted continuation is a no-go blocker. |
| Provider/model selection | **exact** | Startup accepts provider/model flags. RPC exposes `set_model`, `cycle_model`, and `get_available_models`; `set_model` rejects a pair absent from the available snapshot ([types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts#L31-L39), [handler](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L468-L489)). | Treat provider/model IDs as Pi-owned identifiers. Model changes within one Agent can map directly if product policy allows them. |
| Dynamic provider/auth configuration over RPC | **unsupported** | Provider definitions come from built-ins, `models.json`, extensions, and startup/runtime credential sources. RPC has no add-provider or set-credential command. Credential precedence is CLI `--api-key`, `auth.json`, environment, then `models.json` ([provider docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/providers.md#L304-L318)). | Build an isolated profile before spawn or restart after configuration changes. Never send or log secrets on the JSONL channel. Avoid command-line keys because process arguments may be observable. |
| Provider/protocol failure | **exact** | A command rejected before acceptance gets `success: false`. A provider failure after prompt acceptance is represented in the assistant/event stream; terminal assistant messages use `stopReason: "error"` or `"aborted"` plus optional `errorMessage` ([RPC prompt contract](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L68-L78), [agent stream contract](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/types.ts#L18-L32)). | Qualification must distinguish protocol rejection, provider terminal error, automatic retry, process exit, and timeout. |
| Unknown command | **exact** | Unknown command types receive a correlated `success: false` response naming the unknown command ([handler](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L711-L714)). Malformed JSON receives a `command: "parse"` error and the process remains alive ([parser](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L748-L761)). | Test both and require continued service afterward. |
| Unknown event compatibility | **unsupported** | There is no event schema/version negotiation. The official client treats every non-response JSON object as `JsonAgentSessionEvent` via a type assertion and ignores non-JSON lines ([client](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-client.ts#L508-L526)). Source event types already include `entry_appended`, `session_info_changed`, and `thinking_level_changed`, which the narrative event table can lag ([event union](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session.ts#L140-L183)). | ScopeGuard must tolerate, preserve for diagnostics, and ignore unknown event types without crashing or marking success. Pinning and contract tests are mandatory for upgrades. |

## Event and truth model

The stable completion boundary is `agent_settled`, not `agent_end`. `agent_end` describes one low-level run and can be followed by automatic retry, compaction retry, or a queued continuation; `agent_settled` means those continuations are exhausted ([RPC events](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L832-L889)).

For transcript truth:

1. Use live events for rendering and progress.
2. Use `message_end.message` and tool result messages as authoritative completed records.
3. Reconcile durable state through `get_entries`, whose append-order IDs are restart cursors.
4. Keep Pi's JSONL file and compaction entries authoritative. ScopeGuard may index or project them but must not fabricate replacement transcript or compaction history.
5. Treat unknown events and entries as forward-compatible opaque data, not successful known operations.

## Provider and credential boundary

Pi stores OAuth tokens and API keys in `auth.json`; the official documentation states that this file is created with mode `0600`, and auth-file credentials outrank process environment variables ([provider docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/providers.md#L107-L141)). Custom OpenAI-, Anthropic-, or Google-compatible providers can be declared in `models.json`; models without resolved auth remain unavailable ([model docs](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/models.md#L121-L172)).

For the qualification harness:

- Use a temporary `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`.
- Put only a dummy local-provider credential in the temporary profile.
- Do not pass real secrets in RPC messages, fixtures, command output, or committed files.
- If a real-provider smoke test is possible, inherit its credential at process launch and redact stderr/event fixtures. Its absence does not invalidate deterministic protocol tests.
- Remove the entire temporary profile, workspace, and session directory after the run and assert their deletion.

## Candidate blockers for the runtime qualification

The source review does **not** establish a go decision. The following must be resolved by the real package prototype:

1. **No protocol handshake or ready event.** ScopeGuard must prove a bounded `--version` preflight plus correlated `get_state` readiness strategy.
2. **One active Session per RPC process.** Four visible, concurrently running Conversations require at least four isolated processes or another explicitly proven topology.
3. **No stock host approval primitive.** If ScopeGuard must approve Pi tool calls before execution, an official extension-based bridge must be proven; observation-only events are insufficient.
4. **No effect-certainty semantics.** ScopeGuard must add conservative `effect_unknown` classification without claiming Pi rolled back interrupted side effects.
5. **No wire/session compatibility negotiation.** Pi upgrades can add events and can rewrite older session files. Upgrade, backup, rollback, and unknown-event behavior require tests.
6. **Shutdown is not acknowledged.** EOF, SIGTERM, timeout escalation, stderr capture, and output truncation must be classified by the host.
7. **Compaction remains provider-backed behavior.** Manual and automatic compaction must be observed, persisted, resumed, and followed by another successful turn; a ScopeGuard-generated summary cannot satisfy this gate.

Until those behaviors pass the Phase 1 qualification harness, the source-based result is **prototype-required**, not go.

## Fixed source index

- [RPC documentation](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md)
- [RPC command and response types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [RPC mode implementation](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [Official subprocess client](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [JSON event projection](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/json-event.ts)
- [Session event contract](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session.ts)
- [Session manager and migrations](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts)
- [Agent tool execution](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/agent-loop.ts)
- [Provider configuration](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/providers.md)
- [Model configuration](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/models.md)
- [Session storage and CLI resume](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/sessions.md)
- [Session file format](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/session-format.md)
- [Compaction behavior](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/compaction.md)
- [Package metadata](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json)
- [MIT license](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/LICENSE)
