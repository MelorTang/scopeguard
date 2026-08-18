# Use an open Skill package

Status: Partially superseded. Only the ADR 0016 principle in [ADR 0024's amendment matrix](./0024-adopt-a-personal-first-pi-rpc-workbench.md#amendment-matrix) remains normative; all conflicting or additional clauses below are historical.

ScopeGuard V1 Skills will use a Codex-compatible directory rooted at `SKILL.md`,
with optional `scripts`, `references`, and `assets` directories and an optional
`scopeguard.json` for version, runtime, and network declarations. Skills may be
built in, published by the Organization, installed by a Member from a local
directory, ZIP, or pinned Git revision, or discovered under a Workspace's
`.scopeguard/skills` directory. Workspace, Member, Organization, and built-in
Skills resolve in that precedence order. Scripts inherit the Conversation
Execution Profile. In Request Approval and Auto Approve, executable Skill code
must run through the Managed Execution Sandbox and must fail closed if that
boundary is unavailable; instructions-only Skills do not require a process
sandbox. Updates are manual and show their changes, and V1 will not build a
Skill marketplace, ratings, automatic updates, or mandatory signing.
