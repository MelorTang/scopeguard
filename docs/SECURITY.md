# Security Model

ScopeGuard sends user-selected context to model services and offers explicit
local execution profiles. On Windows, the two bounded profiles use a selected
LPAC sandbox. Full Access and Local CLI are not sandboxed. ScopeGuard is not a
general defense against arbitrary malware already running as the desktop user.

## Trust Boundaries

- Electron Renderer is sandboxed, has `contextIsolation` enabled, and has no Node.js access.
- Preload exposes a fixed API. Main validates sender URL and every IPC payload.
- Opening a local folder requires a one-time native picker authorization bound
  to the requesting WebContents.
- Agent host is the only desktop SQLite writer and owns Provider/tool orchestration.
- Bounded commands cross a private typed Agent Host/Main channel to the Desktop
  Execution Broker. No matching method exists in Preload or Renderer IPC.
- Remote Runtime is a separate execution boundary authenticated with a Bearer token.

## Context Boundary

- Each Agent Run receives only its Thread transcript and selected ContextRevision.
- Other Agent transcripts are never loaded implicitly.
- Context publishing and Handoffs validate Workspace, Task, Thread, Run, Agent,
  and Artifact provenance before persistence.
- Artifacts and Context revisions expose their source IDs in the UI for auditability.

## Local Files And Commands

- A Workspace may have no local folder; in that state all local tools are denied.
- `read_file` and `write_file` resolve canonical paths beneath `localRootPath`
  and reject traversal and symlink escapes.
- `write_file` rejects symlink targets, limits content, and uses same-directory atomic replacement.
- Request Approval shows the exact mutating tool call. Auto Approve removes the
  prompt but uses the same Windows LPAC policy. Full Access is explicitly unsandboxed.
- Bounded `run_command` fails closed when any Broker, Provisioner, Runtime,
  Profile, ACL, Job, identity, or cleanup check is unavailable or invalid.
- Each bounded execution has an outer parent-monitoring Job and inner LPAC Job.
  Cancellation is per execution; Desktop exit clears all managed process trees.
- Durable Profile intents and service ACL ledgers recover interrupted lifecycle
  work. Unconfirmed cleanup or termination is reported as an unknown effect.
- Local CLI Agents require a local folder, use argument arrays rather than shell
  interpolation, receive a minimal environment, and cannot bind to remote Runtime nodes.

## Credentials

- Provider keys and Runtime tokens exist transiently in Renderer only while typed.
- Saved secrets are encrypted by Electron `safeStorage`; SQLite stores only opaque references.
- Secrets are never returned in Renderer snapshots or written to Run events,
  Activity summaries, Artifacts, ordinary logs, or remote Runtime SQLite.
- Provider and Runtime errors are redacted using actual request credential values before persistence.
- Secret files and desktop SQLite files are restricted to the current OS user on POSIX.
- Linux `safeStorage` using the `basic_text` backend is rejected.
- Custom Provider headers and persisted CLI environment variables remain disabled.

## Remote Runtime

- Non-loopback URLs must use HTTPS; loopback HTTP is accepted only for local testing.
- Health, submit, poll, and cancel endpoints require the configured Bearer token.
- Remote jobs persist events and Artifacts, allowing Desktop to disconnect and reconnect.
- Provider credentials submitted for a Run are held in process memory only. Because
  first stage has no remote secret escrow, the Runtime process itself must remain
  alive for an active Run to finish.
- Deploy behind an authenticated TLS reverse proxy and restrict network access.

## User Responsibility

Use trusted Provider and Runtime endpoints and open only trusted local folders.
Full Access commands and Local CLI Agents have the operating-system permissions
of the current user. Bounded execution is currently Windows-only and requires a
properly installed and registered sandbox service; missing setup is an error.
