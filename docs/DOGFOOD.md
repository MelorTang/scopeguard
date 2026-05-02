# ScopeGuard Dogfood Guide

## Purpose

Dogfooding means running ScopeGuard on a real external repository to validate practical usability, safety, and workflow quality.

Goals:

- Confirm core commands work outside the ScopeGuard repo itself.
- Find workflow friction early.
- Improve planner/scheduler/safety signal quality with real codebases.
- Capture actionable issues for the next release.

## Recommended Target Repository Criteria

Prefer repositories that are:

- Medium size first (not tiny toy repos, not massive monoliths for first pass).
- Active TypeScript/JavaScript codebase (best current fit for project-map and dependency graph behavior).
- Buildable locally (has repeatable `pnpm`, `npm`, or `yarn` commands).
- Git-based and cleanly clonable.
- Safe to run local tooling against (no production secrets required).

Avoid for first pass:

- Repos requiring privileged infra access.
- Repos with mandatory pre-commit hooks that block local experimentation.
- Repos with very unstable build/test setup.

## Running Local Development CLI From Another Repo (Windows PowerShell)

Assume:

- ScopeGuard source repo path: `<path-to-scopeguard>`
- External target repo path: `<path-to-target-repo>`

In ScopeGuard repo (build once):

```powershell
cd <path-to-scopeguard>
pnpm install
pnpm build
```

In target repo, invoke ScopeGuard CLI via absolute node path:

```powershell
cd <path-to-target-repo>
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js doctor
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js smoke
```

Legacy alias is still available:

```powershell
node <path-to-scopeguard>\apps\cli\bin\agentboard.js doctor
```

## End-to-End Dogfood Command Checklist

Run from the target repository root.

1. `scan`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js scan
```

2. `doctor`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js doctor
```

3. `smoke`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js smoke
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js smoke --json
```

4. `plan`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js plan .\requirements\feature.md
```

5. `validate-plan`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js validate-plan .\plan.json
```

6. `import-plan`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js import-plan .\plan.json
```

7. `tasks`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js tasks
```

8. `next`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js next
```

9. `schedule`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js schedule
```

10. `verify`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js verify T-001
```

11. `fix-scope`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js fix-scope T-001
```

12. `review`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js review T-001
```

13. `approve`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js approve T-001
```

14. `merge`

```powershell
node <path-to-scopeguard>\apps\cli\bin\scopeguard.js merge T-001
```

## Dogfood Notes Template

Use this template for each dogfood session:

```text
Date:
Target repository:
Commit/branch tested:
ScopeGuard version/tag:

Commands run:
- scan:
- doctor:
- smoke:
- plan:
- validate-plan:
- import-plan:
- tasks:
- next:
- schedule:
- verify:
- fix-scope:
- review:
- approve:
- merge:

What worked well:
- ...

Problems observed:
- ...

Severity:
- blocker / high / medium / low

Suggested fix:
- ...

Artifacts:
- logs:
- report paths:
- screenshots:
```

## Issue Categories To Watch

- Planner quality
- lockedFiles quality
- scheduler correctness
- verify false positives / false negatives
- fix-scope safety
- review usefulness
- merge friction
- docs gaps

## Scope and Safety Reminder

Dogfooding should focus on workflow validation, not feature expansion during execution.

- Do not change runtime logic while collecting notes.
- Do not modify `.scopeguard/tasks` manually.
- Do not create manual locks/worktrees outside normal command flow.
- Keep findings reproducible with exact commands and outputs.

## Dogfood Run 001 - typescript-cli-starter

- Date: 2026-05-02
- External repo: khalidx/typescript-cli-starter
- Local clone: <path-to-dogfood-repo>
- ScopeGuard version: v0.3.5
- Scenario: Add CLI version output and minimal docs/test coverage.

### Commands Run

```powershell
scopeguard-dev init
scopeguard-dev scan
scopeguard-dev doctor
scopeguard-dev smoke
scopeguard-dev plan requirements\add-version-command.md
scopeguard-dev validate-plan plan.json
scopeguard-dev import-plan plan.json
scopeguard-dev tasks
scopeguard-dev next
scopeguard-dev schedule
scopeguard-dev smoke
```

## Dogfood Follow-up - Working Tree Verify

- Date: 2026-05-02
- ScopeGuard version: v0.3.7
- External repo: <path-to-dogfood-repo>

### Scenario

Validate the new `--working-tree` mode against the mixed working tree changes from Dogfood Run 001.

### Commands Run

```powershell
scopeguard-dev verify T-001 --working-tree
scopeguard-dev review T-001 --working-tree
scopeguard-dev verify T-002 --working-tree
scopeguard-dev review T-002 --working-tree
```

## Dogfood Follow-up - Manual Workflow and Dependent Task Verification

- Date: 2026-05-02
- ScopeGuard version: v0.3.7
- External repo: <path-to-dogfood-repo>

### Scenario

Continue validating Dogfood Run 001 after adding `verify --working-tree` and `review --working-tree`.

The external repo had three tracked changes:

- `src/cli.ts` for T-001
- `README.md` for T-002
- `src/index.test.ts` for T-002

### Commands Run

```powershell
scopeguard-dev verify T-001 --working-tree
scopeguard-dev review T-001 --working-tree
scopeguard-dev verify T-002 --working-tree
scopeguard-dev review T-002 --working-tree
```

## Dogfood Follow-up - Scope-only Verification

- Date: 2026-05-02
- ScopeGuard version: v0.3.8
- External repo: <path-to-dogfood-repo>

### Scenario

Validate the new `verify --working-tree --scope-only` mode against Dogfood Run 001.

### Commands Run

```powershell
scopeguard-dev verify T-001 --working-tree --scope-only
scopeguard-dev verify T-002 --working-tree --scope-only
```

Mixed Working Tree Result

The external repo had changes from both tasks:

src/cli.ts from T-001
README.md from T-002
src/index.test.ts from T-002

Results:

T-001 correctly failed because README.md and src/index.test.ts were outside T-001 scope.
T-002 correctly failed because src/cli.ts was outside T-002 scope.
Commands were skipped due to --scope-only.
Isolated Scope-only Result

When isolating T-002 by reverting src/cli.ts, verify T-002 --working-tree --scope-only passed because only T-002 files remained changed:

README.md
src/index.test.ts

After restoring src/cli.ts, the external repo returned to the complete dogfood change set and still passed:

npm test
npm run dev -- --version
npm run dev -- version
Follow-up

A future dependency-aware mode may still be useful:

```powershell
scopeguard verify T-002 --working-tree --include-dependencies
```

But --scope-only is sufficient for narrow manual boundary checks.
