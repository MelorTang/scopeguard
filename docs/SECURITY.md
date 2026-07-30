# Security Model

ScopeGuard runs trusted local tools on behalf of the user. It reduces
accidental authority and credential exposure; it is not a container or hostile
code sandbox.

## Trust Boundaries

- The Electron renderer is sandboxed and has no Node.js access.
- Preload exposes a fixed typed API. There is no generic IPC invoke surface.
- Main validates sender URL, payload shape, and one-time Project picker
  authorization.
- The Agent host owns SQLite, Provider requests, Agent loops, and tools.
- Provider secrets stay in the main-process SecretVault and are transferred to
  the Agent host only when needed for a request.

## Local Files And Commands

- `read_file` and `write_file` resolve canonical paths beneath the Project
  root and reject escapes.
- `write_file` rejects symlink targets, limits content to 1 MiB, and replaces
  files through a same-directory temporary file.
- `run_command` displays the exact shell command and requires approval by
  default.
- Cancellation and shutdown terminate complete process groups, escalating from
  `SIGTERM` to `SIGKILL` after a bounded grace period.
- Child processes receive a minimal environment that excludes common Provider
  and cloud credentials.

## Credentials

- API keys exist transiently in the sandboxed renderer while the user types or
  tests them. The form clears the value after save or close.
- Saved API keys never enter SQLite, Run events, logs, or renderer snapshots,
  and are never returned to the renderer.
- SQLite stores only an opaque SecretVault reference.
- On POSIX systems the local data directory is mode `0700`; SQLite database,
  journal, WAL, and shared-memory files are tightened to mode `0600`.
- SecretVault writes are serialized and atomically replace a mode-0600 file.
- Linux `safeStorage` using the `basic_text` backend is rejected.
- Provider errors and model-controlled output are redacted using the actual
  request credential values before persistence.
- Custom Provider headers and persisted CLI environment variables are disabled
  until they can use the same encrypted boundary.

## User Responsibility

Only open Projects that you trust. Read command approvals before accepting
them. An approved shell command or configured Local CLI Agent has the operating
system permissions of the current user.
