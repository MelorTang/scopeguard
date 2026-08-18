# Allow offline access to local work

Status: Partially superseded. Only the ADR 0011 principle in [ADR 0024's amendment matrix](./0024-adopt-a-personal-first-pi-rpc-workbench.md#amendment-matrix) remains normative; all conflicting or additional clauses below are historical.

After one successful online login, the Desktop will bind its local profile to
the Organization, Member, and current operating-system account using credentials
protected by Windows Credential Manager or macOS Keychain. That locally verified
identity may unlock Conversation Transcripts, Workspace Context, Artifacts, and
document caches while the enterprise server is unavailable; a plain username is
not an authentication mechanism. Model execution and enterprise knowledge MCP
remain unavailable offline and resume only after server authentication. Source
Workspace Files retain their existing filesystem protection, while ScopeGuard's
local conversation data and parse caches use a key bound to the OS account.
