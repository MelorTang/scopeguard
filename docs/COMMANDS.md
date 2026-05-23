# ScopeGuard Commands Reference

Compatibility note: `scopeguard` is the primary CLI. `agentboard` is a legacy alias.
Compatibility note: `.scopeguard` is primary storage. `.agentboard` is legacy compatibility only.

When using commands through pnpm, expected failures may show `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`. Read the ScopeGuard message above it for the real reason.

## Before Using These Commands

**If you are running ScopeGuard against a target project (not developing ScopeGuard itself):**

1. You must first build the source: `pnpm install && pnpm -r build` in the scopeguard checkout.
2. Define a helper: `function scopeguard-dev { node <path-to-scopeguard>\apps\cli\bin\scopeguard.js @args }`
3. **Always run `init` first** in the target project directory. Without a `.scopeguard` data directory, commands like `doctor` and `smoke` will report missing configuration — that is expected, not a bug.
4. Typical first-run sequence: `init → scan → doctor --json → smoke --json`.

See `docs/QUICKSTART.md` for the full setup guide.

## Local Usage Forms

Primary:

- `pnpm --filter @scopeguard/cli dev -- doctor`
- `pnpm --filter @scopeguard/cli dev -- smoke`
- `node apps\cli\bin\scopeguard.js doctor`
- `node apps\cli\bin\scopeguard.js smoke`

Legacy alias:

- `node apps\cli\bin\agentboard.js doctor`
- `node apps\cli\bin\agentboard.js smoke`

## init

- Purpose: initialize ScopeGuard storage in git root.
- Example: `pnpm --filter @scopeguard/cli dev -- init`
- Notes: defaults to `.scopeguard`; if only `.agentboard` exists, it stays in compatibility mode.

## migrate

- Purpose: migrate legacy `.agentboard/` data to `.scopeguard/`.
- Example: `node apps\cli\bin\scopeguard.js migrate --dry-run`
- Notes: default mode is copy (keeps `.agentboard`), `--move` renames legacy dir to `.agentboard.backup-*`, `--force` overwrites existing `.scopeguard`.

## scan

- Purpose: build project map from repository structure and imports.
- Example: `pnpm --filter @scopeguard/cli dev -- scan`
- Notes: writes `project-map.json` under active data directory.

## doctor

- Purpose: run environment and repository health checks.
- Example: `pnpm --filter @scopeguard/cli dev -- doctor --json`
- Notes: fails with exit code 1 when failed checks > 0.

## smoke

- Purpose: run read-only MVP smoke checks.
- Examples:
  - `pnpm --filter @scopeguard/cli dev -- smoke`
  - `pnpm --filter @scopeguard/cli dev -- smoke --json`
- Notes: verifies doctor/data-directory/tasks/next/schedule/locks/worktrees/agent-branches checks. Must not modify files, tasks, locks, worktrees, or branches.

## plan

- Purpose: generate planner prompt from requirement + project map.
- Example: `pnpm --filter @scopeguard/cli dev -- plan requirements/feature.md`
- Notes: writes prompt under `.scopeguard/plans/` (legacy `.agentboard` supported).

## validate-plan

- Purpose: validate plan JSON structure and safety constraints.
- Example: `pnpm --filter @scopeguard/cli dev -- validate-plan plan.json`
- Notes: errors block import; warnings are allowed.

## import-plan

- Purpose: import tasks into `.scopeguard/tasks/` (legacy path supported).
- Example: `pnpm --filter @scopeguard/cli dev -- import-plan plan.json`
- Notes: skips existing task IDs.

## tasks

- Purpose: list tasks and status.
- Example: `pnpm --filter @scopeguard/cli dev -- tasks`

## next

- Purpose: show safe-to-run tasks and blocked reasons.
- Example: `pnpm --filter @scopeguard/cli dev -- next --json`

## schedule

- Purpose: build parallel-safe execution batches.
- Example: `pnpm --filter @scopeguard/cli dev -- schedule --json`

## run

- Purpose: execute a task in isolated worktree via runner.
- Example: `pnpm --filter @scopeguard/cli dev -- run T-001 --runner codex`
- Notes: pre-run guard enforces state/dependency/lock safety.

## verify

- Purpose: verify scope changes and optionally run task commands.
- Examples:
  - `scopeguard verify T-001`
  - `scopeguard verify T-001 --working-tree`
  - `scopeguard verify T-001 --scope-only`
  - `scopeguard verify T-001 --working-tree --scope-only`
  - `scopeguard verify T-002 --working-tree --include-dependencies`
  - `scopeguard verify T-002 --working-tree --include-dependencies --scope-only`
- Notes:
  - `--working-tree` validates current repo diff instead of task worktree.
  - `--scope-only` skips command execution.
  - `--include-dependencies` allows direct dependency-owned files during working-tree scope checks.

## fix-scope

- Purpose: revert out-of-scope/generated/forbidden file changes.
- Example: `pnpm --filter @scopeguard/cli dev -- fix-scope T-001`

## review

- Purpose: generate human-readable review markdown.
- Examples:
  - `scopeguard review T-001`
  - `scopeguard review T-001 --working-tree`

## approve

- Purpose: mark a verified reviewable task as approved.
- Example: `pnpm --filter @scopeguard/cli dev -- approve T-001`

## merge

- Purpose: merge approved task branch into target branch.
- Examples:
  - `pnpm --filter @scopeguard/cli dev -- merge T-001`
  - `pnpm --filter @scopeguard/cli dev -- merge --continue T-001`

## discard

- Purpose: rollback task execution artifacts and reset task state.
- Example: `pnpm --filter @scopeguard/cli dev -- discard T-001 --to ready`

## close

- Purpose: close task for scheduling hygiene.
- Example: `pnpm --filter @scopeguard/cli dev -- close T-002 --reason duplicate`

## reopen

- Purpose: reopen a closed task to `ready`.
- Example: `pnpm --filter @scopeguard/cli dev -- reopen T-002`

## board

- Purpose: start local web board.
- Example: `pnpm --filter @scopeguard/cli dev -- board --port 3737`

## tui

- Purpose: open terminal board and safe action shortcuts.
- Example: `pnpm --filter @scopeguard/cli dev -- tui`

## locks

- Purpose: list active file locks.
- Example: `pnpm --filter @scopeguard/cli dev -- locks`

## unlock

- Purpose: release active locks for one task.
- Example: `pnpm --filter @scopeguard/cli dev -- unlock T-001`
