# Require a Managed Execution Sandbox for Agent-triggered code

ScopeGuard V1 requires an OS-enforced Managed Execution Sandbox before the
Native Harness may run any Agent-triggered executable, command, script,
executable Skill, document worker, or local stdio MCP process in Request
Approval or Auto Approve. Both profiles use the same sandbox policy; approvals
decide whether an eligible escalation may proceed and never substitute for or
weaken containment. The sandbox must restrict host file, registry, credential,
process, IPC, and network authority according to an immutable per-run policy,
own the complete process tree, and fail closed when setup or verification is
unavailable. Full Access is the explicit current-user, unsandboxed profile, and
the Member-operated Workspace Terminal remains outside Agent execution. V1 may
ship brokered typed tools without the runner, but it may not expose arbitrary
Agent-triggered local execution in the two bounded profiles until the Windows
sandbox compatibility and escape-resistance prototype passes.
