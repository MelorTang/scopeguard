# ScopeGuard Safety Model

ScopeGuard is a local safety orchestration layer around AI coding agents.

Compatibility note: this MVP still uses the `agentboard` CLI and `.agentboard` directory internally.

## Threat Model

AI coding agents may:

- Edit too many files
- Edit generated artifacts directly
- Modify files outside assigned scope
- Run with stale context
- Collide with another task
- Produce broken code
- Leave dirty worktrees
- Create merge conflicts

## Safety Layers

- Planner task scope
- `allowedFiles` / `forbiddenFiles` / `lockedFiles`
- Generated artifact forbidden patterns
- Git worktree isolation
- Pre-run guard
- Active file locks
- Verifier
- Fix-scope
- Review report
- Approve gate
- Conservative merge
- Discard rollback
- Close/reopen for task hygiene

## Generated Artifacts (Default Forbidden)

- `**/dist/**`
- `**/build/**`
- `**/.next/**`
- `**/coverage/**`
- `**/*.map`
- `**/*.tsbuildinfo`

## Locked Files Overlap (MVP)

Current overlap checks are conservative and include:

- Exact pattern match
- Directory `/**` containment (parent-child path overlap)
- Concrete file path inside a locked directory pattern

Examples:

- `apps/server/**` overlaps `apps/server/src/**`
- `packages/**` overlaps `packages/core/src/index.ts`

Current MVP does not implement a full glob solver for complex wildcard expressions.

## Merge Safety

- Merge only from `approved` + verified tasks
- Require clean main workspace (non-`.scopeguard/**` changes blocked; legacy `.agentboard/**` still supported)
- No auto conflict resolution
- On conflict: set `conflict` and require manual resolution + `merge --continue`
