# ScopeGuard Preview Release Checklist

This checklist is for releasing ScopeGuard Developer Preview (`v0.4.0-preview`).

Compatibility note: this preview supports both `scopeguard` and legacy `agentboard` CLI commands.
Legacy `.agentboard` data can be migrated to `.scopeguard` with `scopeguard migrate`.

## Environment

1. Install dependencies:

```powershell
pnpm install
```

2. Build workspace:

```powershell
pnpm build
```

3. Run health check:

```powershell
pnpm --filter @scopeguard/cli dev -- doctor
```

4. Codex CLI is optional but recommended.
5. Git working tree should be clean before tagging.

## Core CLI Smoke Test

```powershell
pnpm --filter @scopeguard/cli dev -- doctor
pnpm --filter @scopeguard/cli dev -- tasks
pnpm --filter @scopeguard/cli dev -- next
pnpm --filter @scopeguard/cli dev -- schedule
pnpm --filter @scopeguard/cli dev -- plan requirements/health.md
node apps/cli/bin/scopeguard.js migrate --dry-run
```

## Plan Validation Smoke Test

```powershell
pnpm --filter @scopeguard/cli dev -- validate-plan <plan.json>
pnpm --filter @scopeguard/cli dev -- import-plan <plan.json>
```

## Execution Smoke Test (Optional)

```powershell
$env:CODEX_BIN="C:\Users\<user>\AppData\Roaming\npm\codex.cmd"
pnpm --filter @scopeguard/cli dev -- run T-XXX --runner codex
pnpm --filter @scopeguard/cli dev -- verify T-XXX
pnpm --filter @scopeguard/cli dev -- fix-scope T-XXX
pnpm --filter @scopeguard/cli dev -- review T-XXX
pnpm --filter @scopeguard/cli dev -- approve T-XXX
pnpm --filter @scopeguard/cli dev -- merge T-XXX
```

## UI Smoke Test

```powershell
pnpm --filter @scopeguard/cli dev -- board
pnpm --filter @scopeguard/cli dev -- tui
```

Check:

- Web loads
- Scheduling panel loads
- Review / Open Review works
- Close / Reopen works
- TUI opens
- TUI `n` / `s` scheduling views work
- TUI `c` / `u` close/reopen work

## Git Hygiene

```powershell
git status --porcelain
git worktree list
git branch
git ls-files | Select-String "node_modules|dist"
```

Expected:

- clean working tree
- no ScopeGuard/AgentBoard worktrees unless tasks are running
- no `agent/*` branches unless tasks are running
- no tracked `node_modules` / `dist`

## Tagging

```powershell
git status --porcelain
git tag v0.4.0-preview
git tag
```

If remote exists:

```powershell
git push origin master
git push origin v0.4.0-preview
```
