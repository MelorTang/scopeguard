# Offer an unmanaged Workspace Terminal

ScopeGuard V1 will manage only its Native Harness and will not integrate Codex,
Kimi Code, or other external Agent Harnesses. Advanced users may instead open a
resizable bottom Workspace Terminal, rooted at the current Workspace, and run
those CLIs themselves in multiple terminal tabs. The Terminal uses the current
operating-system account and sits outside Conversation Execution Profiles;
it is an explicit Member-operated exception to the Managed Execution Sandbox.
ScopeGuard does not parse its output, persist or restore its sessions, dispatch
tasks into it, or provide enterprise Provider or MCP credentials. Handoff
Prompts remain copyable for manual use, and filesystem monitoring invalidates
ScopeGuard's file version hashes when a terminal process changes Workspace
files. Closing a terminal tab or the Desktop terminates its managed process,
while any CLI-level session recovery remains the CLI's responsibility.
