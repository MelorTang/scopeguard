# ScopeGuard MVP Workflow

This document describes the end-to-end ScopeGuard MVP lifecycle.

Compatibility note: this MVP still uses the `agentboard` CLI and `.agentboard` directory internally.

## Flow

Requirement
-> Planner prompt
-> Plan JSON
-> Validate plan
-> Import tasks
-> Next/Schedule
-> Run
-> Verify
-> Fix Scope (if needed)
-> Review
-> Approve
-> Merge
-> Close/Reopen/Discard (as needed)

## Commands (PowerShell)

```powershell
pnpm --filter @scopeguard/cli dev -- init
pnpm --filter @scopeguard/cli dev -- scan
pnpm --filter @scopeguard/cli dev -- plan requirements/feature.md
pnpm --filter @scopeguard/cli dev -- validate-plan plan.json
pnpm --filter @scopeguard/cli dev -- import-plan plan.json
pnpm --filter @scopeguard/cli dev -- next
pnpm --filter @scopeguard/cli dev -- schedule
pnpm --filter @scopeguard/cli dev -- run T-001 --runner codex
pnpm --filter @scopeguard/cli dev -- verify T-001
pnpm --filter @scopeguard/cli dev -- fix-scope T-001
pnpm --filter @scopeguard/cli dev -- review T-001
pnpm --filter @scopeguard/cli dev -- approve T-001
pnpm --filter @scopeguard/cli dev -- merge T-001
```

## Task States

- `ready`: eligible to run if dependencies/locks allow
- `in_progress`: currently being executed
- `needs_review`: run/verify artifacts ready for human review
- `test_failed`: verify/commands failed
- `approved`: explicitly approved and waiting merge
- `merged`: merged into target branch
- `closed`: intentionally removed from scheduling
- `conflict`: merge conflict or conflict continuation needed

## Recovery and Hygiene Commands

### `discard`

Use when a task run should be rolled back safely (cleanup worktree/branch and archive artifacts).

```powershell
pnpm --filter @scopeguard/cli dev -- discard T-001
```

### `close`

Use when a task is duplicate/obsolete and should be excluded from scheduling without deleting files.

```powershell
pnpm --filter @scopeguard/cli dev -- close T-002 --reason duplicate
```

### `reopen`

Use when a closed task should return to active scheduling (`ready`).

```powershell
pnpm --filter @scopeguard/cli dev -- reopen T-002
```

### `merge --continue`

Use after manual conflict resolution and commit.

```powershell
pnpm --filter @scopeguard/cli dev -- merge --continue T-001
# or
pnpm --filter @scopeguard/cli dev -- merge T-001 --continue
```
