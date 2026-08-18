# Allow offline access to local work

Status: Active in principle; amended by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

After one successful online login, the Desktop will bind its local profile to
the Organization, Member, and current operating-system account using credentials
protected by Windows Credential Manager or macOS Keychain. That locally verified
identity may unlock Conversation Transcripts, Workspace Context, Artifacts, and
document caches while the enterprise server is unavailable; a plain username is
not an authentication mechanism. Model execution and enterprise knowledge MCP
remain unavailable offline and resume only after server authentication. Source
Workspace Files retain their existing filesystem protection, while ScopeGuard's
local conversation data and parse caches use a key bound to the OS account.
