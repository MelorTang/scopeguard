# Govern local access per Conversation

ScopeGuard will replace the fixed office-tool allowlist with a Member-selected
Conversation Execution Profile inherited by every local tool and Skill. Request
Approval and Auto Approve use the same OS-enforced Managed Execution Sandbox for
every Agent-triggered executable, command, script, executable Skill, and local
stdio MCP process. Request Approval asks the Member before eligible writes,
network uses, or boundary escalations; Auto Approve changes who reviews eligible
requests but never widens or bypasses the sandbox. Full Access explicitly runs
with the current operating-system user's ambient authority and without the
Managed Execution Sandbox or per-action approval; it is not elevation. A
Workspace supplies the default, a Conversation may override or change it,
downgrades apply immediately, and only the Member may approve an upgrade.
Server-held Provider or MCP credentials, enterprise permissions, and other
Members' data remain outside all three local profiles.
