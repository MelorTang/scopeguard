# ScopeGuard Demo Script (PowerShell)

This script demonstrates the ScopeGuard MVP workflow end-to-end.

Compatibility note: this MVP still uses the `agentboard` CLI and `.agentboard` directory internally.

## 1. Setup

```powershell
pnpm install
pnpm build
git init
pnpm --filter @scopeguard/cli dev -- init
pnpm --filter @scopeguard/cli dev -- scan
```

## 2. Generate Planner Prompt

```powershell
pnpm --filter @scopeguard/cli dev -- plan requirements/health.md
```

Open generated prompt under `.scopeguard/plans/` (or legacy `.agentboard/plans/`), paste into Codex/Claude/Gemini, save returned JSON as `plan.json`.

## 3. Validate and Import Plan

```powershell
pnpm --filter @scopeguard/cli dev -- validate-plan plan.json
pnpm --filter @scopeguard/cli dev -- import-plan plan.json
pnpm --filter @scopeguard/cli dev -- tasks
```

## 4. Check Scheduling

```powershell
pnpm --filter @scopeguard/cli dev -- next
pnpm --filter @scopeguard/cli dev -- schedule
```

## 5. Run One Task with Codex

```powershell
$env:CODEX_BIN="C:\Users\<user>\AppData\Roaming\npm\codex.cmd"
pnpm --filter @scopeguard/cli dev -- run T-001 --runner codex
```

## 6. Verify and Fix Scope if Needed

```powershell
pnpm --filter @scopeguard/cli dev -- verify T-001
```

If verify fails because generated artifacts changed, run:

```powershell
pnpm --filter @scopeguard/cli dev -- fix-scope T-001
pnpm --filter @scopeguard/cli dev -- verify T-001
```

## 7. Review, Approve, Merge

```powershell
pnpm --filter @scopeguard/cli dev -- review T-001
pnpm --filter @scopeguard/cli dev -- approve T-001
pnpm --filter @scopeguard/cli dev -- merge T-001
```

If merge reports conflict and you resolve manually:

```powershell
git status
git add <resolved-files>
git commit
pnpm --filter @scopeguard/cli dev -- merge --continue T-001
```

## 8. Show UI

```powershell
pnpm --filter @scopeguard/cli dev -- board
pnpm --filter @scopeguard/cli dev -- tui
```

## 9. Close Duplicate Tasks

```powershell
pnpm --filter @scopeguard/cli dev -- close T-002 --reason duplicate
pnpm --filter @scopeguard/cli dev -- close T-003 --reason duplicate
pnpm --filter @scopeguard/cli dev -- tasks
pnpm --filter @scopeguard/cli dev -- schedule
```

## Notes

- ScopeGuard is local-first and file-based in MVP.
- Display name is ScopeGuard, while technical naming remains `agentboard` for compatibility in this phase.
- Web UI currently focuses on safe operations; high-risk operations remain CLI-first.
