# Security Model

Status: Current Phase 2 candidate boundary. See
[ADR 0025](./adr/0025-adopt-pi-rpc-with-an-extension-approval-bridge.md) and
[ADR 0026](./adr/0026-replace-the-native-harness-with-pi-runtime.md).

ScopeGuard sends the selected Conversation prompt and Pi-owned Session context
to the configured model Provider. A Workspace may expose a user-selected local
folder to Pi Tools. ScopeGuard is local-first, but it is not a defense against
malware already running as the desktop user.

## Desktop Boundaries

- Electron Renderer is sandboxed, uses context isolation, and has no Node access.
- Preload exposes a fixed API; Main validates the sender and IPC payload shape.
- The Agent Host utility process is the only SQLite writer and Pi supervisor.
- Provider secrets cross only the private Main/Agent Host secret channel.
- Web preview is an in-memory UI fixture and has no local execution authority.

## Managed Pi Runtime

- Pi is pinned to `@earendil-works/pi-coding-agent@0.84.2`.
- Automatic extension, Skill, prompt-template, theme, and context discovery is
  disabled for the managed process.
- Readiness checks the CLI version and SHA-256 manifest before enabling Tools.
- Exactly one final ScopeGuard Tool-policy extension is permitted.
- `read` is confined to a resolvable path inside the canonical Workspace; Agent
  permission can allow, ask, or deny it.
- `bash`, `write`, and `edit` require approval bound to process ID, RPC request
  ID, Tool call ID, Tool name, canonical input, and SHA-256.
- Unknown Tools, paths outside the Workspace, manifest drift, invalid RPC
  responses, extension failure, and approval-channel loss fail closed.
- A Conversation has at most one active Run; different Conversations use
  separate supervised Pi processes.

Approval is not a sandbox. An approved `bash`, `write`, or `edit` runs with the
operating-system permissions of the Desktop user and can target locations shown
in its exact canonical input. Request Approval waits for the user. Auto Approve
answers exact tuples automatically unless Agent policy denies that Tool. Full
Access answers exact tuples for known Tools and allows Workspace reads, but
unknown Tools still block and no unmanaged extension is loaded.

## Runtime Truth And Effects

Pi Session JSONL is the only transcript, Tool-result, and compaction truth.
ScopeGuard stores only product metadata and an opaque, versioned locator. Startup
rejects missing, malformed, incompatible, mismatched, or unopenable Sessions and
never substitutes an empty Session.

Approval does not prove completion. After an exact side-effect tuple is
approved, ScopeGuard persists `effect_unknown` until Pi supplies enough evidence
to classify the result. Crash, cancellation, shutdown, or a lost response keeps
that uncertainty. A Run interrupted before any approved effect remains `none`.

## Credentials And Diagnostics

- Saved Provider secrets use Electron `safeStorage`; SQLite stores an opaque
  reference only.
- Secrets are injected through an isolated temporary Pi profile and environment,
  never sent as RPC fields or written to Session fixtures.
- Temporary profiles are removed after each process.
- stderr is UTF-8-byte bounded and configured secrets are redacted before an
  error can enter product state.
- Product SQLite files are restricted to the current OS user on POSIX.
- Persisted custom Provider headers remain disabled.

## User Responsibility

Use trusted Provider endpoints and inspect side-effect approval input before
allowing it. User-opened terminals and external Agent CLIs are outside the
managed Pi lifecycle and retain the user's full operating-system authority.
The retired Windows LPAC prototype is historical evidence only; it is not part
of the current Runtime or a claim made by the Phase 2 candidate.
