# Security Model

ScopeGuard sends user-selected conversation and Project Context data to the
configured model Provider. It can also read, write, and execute within a
user-selected local Workspace according to the conversation's execution
profile. ScopeGuard is not a defense against arbitrary malware already running
as the desktop user.

## Trust Boundaries

- Electron Renderer is sandboxed, has `contextIsolation` enabled, and has no
  Node.js access.
- Preload exposes a fixed API. Main validates the sender and every IPC payload.
- Opening a local folder requires native picker authorization bound to the
  requesting WebContents.
- Agent host is the only desktop SQLite writer and owns Provider and tool
  orchestration.
- Bounded commands cross a private typed Agent Host/Main channel to the Desktop
  Execution Broker. Renderer and Preload cannot invoke that channel directly.
- Web preview is an in-memory UI fixture and carries no desktop authority.

## Context Isolation

- Each Run receives only its own conversation transcript and the current
  explicit Project Context revision.
- ScopeGuard never loads another conversation's transcript implicitly.
- Project Context updates validate their Workspace, source conversation, and
  source Run relationship before persistence.
- Approval and user-input continuation stay attached to the originating Run.

## Local Files And Commands

- A Workspace with no local folder receives no local tools.
- File paths are resolved beneath the canonical Workspace root; traversal and
  symlink escapes are rejected.
- Writes reject symlink targets, limit content, and use same-directory atomic
  replacement.
- Request Approval shows each mutating tool call. Auto Approve removes the
  prompt but keeps the same bounded command path. Full Access is explicitly
  unsandboxed.
- Bounded Windows execution fails closed when Broker, Provisioner, runtime,
  profile, ACL, process, or cleanup evidence is unavailable or invalid.
- Cancellation is per Run. Desktop shutdown clears managed process trees.
- An unconfirmed non-idempotent effect is reported as unknown, never projected
  as successful or as having no effect.

See [MANAGED_EXECUTION.md](./MANAGED_EXECUTION.md) for the Windows LPAC boundary
and its deployment requirements.

## Credentials

- Provider keys exist in Renderer memory only while entered.
- Saved secrets are encrypted by Electron `safeStorage`; SQLite stores only an
  opaque reference.
- Secrets are not returned in desktop snapshots or written to Run events,
  messages, manifests, usage records, or ordinary logs.
- Provider errors are redacted using actual request credentials before they are
  persisted or published.
- Secret files and desktop SQLite files are restricted to the current OS user
  on POSIX.
- Linux `safeStorage` using the `basic_text` backend is rejected.
- Persisted custom Provider headers remain disabled.

ScopeGuard has no Runtime token or remote-worker credential path. External Agent
CLIs and terminals are outside its execution and credential boundary.

## User Responsibility

Use trusted Provider endpoints, open only trusted local folders, and review the
selected execution profile before starting a conversation. Full Access commands
run with the operating-system permissions of the current desktop user. Bounded
execution is currently Windows-only and requires the installed managed-execution
companion; missing setup is an error, not a reason to elevate automatically.
