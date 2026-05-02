# ScopeGuard

Local-first safety orchestration for AI coding agents.

ScopeGuard is not a coding model.
It does not replace Codex, Claude Code, Cursor, or other coding assistants.
It wraps agent work with planning, scope boundaries, file locks, verification, review, and safer merge workflows.

## Developer Preview Status

ScopeGuard is in Developer Preview.
Interfaces and workflows are usable for dogfooding, but still evolving.
Expect iterative changes driven by real repository usage.

## Quick Start

```powershell
pnpm install
pnpm build
pnpm --filter @scopeguard/cli dev -- init
pnpm --filter @scopeguard/cli dev -- scan
pnpm --filter @scopeguard/cli dev -- doctor
pnpm --filter @scopeguard/cli dev -- smoke
```

## Core Workflow

```powershell
scopeguard plan requirements/feature.md
scopeguard validate-plan plan.json
scopeguard import-plan plan.json
scopeguard tasks
scopeguard next
scopeguard schedule
scopeguard verify T-001
scopeguard review T-001
```

Source-run mode note:
Replace `scopeguard ...` with either:
- `pnpm --filter @scopeguard/cli dev -- ...`
- `node apps\cli\bin\scopeguard.js ...`

## Manual Working-Tree Workflow

Use this when changes are made directly in the current repository working tree instead of task worktrees.

```powershell
scopeguard verify T-001 --working-tree
scopeguard review T-001 --working-tree
scopeguard verify T-001 --working-tree --scope-only
scopeguard verify T-002 --working-tree --include-dependencies
```

## Compatibility

- `scopeguard` is the primary CLI.
- `agentboard` remains a legacy alias.
- `.scopeguard` is the primary data directory.
- `.agentboard` is legacy compatibility only.

## Local CLI Usage

```powershell
pnpm --filter @scopeguard/cli dev -- doctor
pnpm --filter @scopeguard/cli dev -- smoke
node apps\cli\bin\scopeguard.js doctor
node apps\cli\bin\scopeguard.js smoke
node apps\cli\bin\agentboard.js doctor
node apps\cli\bin\agentboard.js smoke
```

## Web and TUI

```powershell
pnpm --filter @scopeguard/cli dev -- board
pnpm --filter @scopeguard/cli dev -- tui
```

## More Docs

- `docs/QUICKSTART.md`
- `docs/COMMANDS.md`
- `docs/MVP_WORKFLOW.md`
- `docs/SAFETY_MODEL.md`
- `docs/DOGFOOD.md`
- `docs/PREVIEW_LIMITATIONS.md`
