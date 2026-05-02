# Dependency-Aware Working-Tree Verification Design

## Purpose
This document proposes a future verification mode for dependency-aware working-tree validation:

`scopeguard verify <task-id> --working-tree --include-dependencies`

This is a design-only document. It does not change current runtime behavior.

## Problem Statement
In dogfood usage, tasks were implemented manually in the main working tree instead of isolated worktrees.

ScopeGuard v0.3.8 supports:
- `verify --working-tree`
- `review --working-tree`
- `verify --scope-only`

A remaining gap appears when a task depends on another task and tests need both changes present.

## Concrete Dogfood Example
- `T-001` changed `src/cli.ts`
- `T-002` changed `README.md` and `src/index.test.ts`
- `T-002` depends on `T-001`

Observed behavior:
1. Isolate only T-002 files:
- scope check passes
- commands fail because `T-001` implementation is missing

2. Keep both T-001 and T-002 files:
- commands can pass
- scope check fails because `src/cli.ts` is out of T-002 scope

## Current Modes vs Proposed Mode

### `verify --working-tree`
- Uses current working-tree diff
- Runs scope + command checks
- Fails if dependency files appear outside current task scope

### `verify --working-tree --scope-only`
- Uses current working-tree diff
- Runs only scope checks
- Skips commands
- Useful for strict file-boundary checks, but does not prove runnable integration

### Proposed: `verify --working-tree --include-dependencies`
- Uses current working-tree diff
- Runs command checks
- Allows dependency-owned files to exist in diff when validating current task
- Still blocks unrelated out-of-scope files

## Proposed Semantics
1. Current task changed files are validated against current task scope as today.
2. Dependency task changed files may be present in the working tree.
3. Dependency files are not counted as out-of-scope only if they belong to declared dependencies that are eligible.
4. Unknown files still fail scope checks.
5. `forbiddenFiles` and generated artifact patterns still fail scope checks.
6. Commands run against the combined working tree.

## Safety Rules
- Do not loosen scope for unrelated files.
- Do not allow arbitrary dependency files unless the dependency task explicitly owns them.
- Do not auto-approve or auto-merge from this mode.
- Prefer requiring dependency tasks to be verified or merged before they can be included.

## Eligibility for Dependency Files
Dependency file allowance should be gated by task metadata and status checks.

Baseline recommendation:
- Dependency must be explicitly listed in `task.dependencies`.
- Dependency task must exist.
- Dependency task should be at least verified, and preferably merged.

## Scope Classification Proposal
During `--include-dependencies`, classify changed files into:
- Current task files
- Dependency task files
- Unknown files
- Forbidden/generated files

Verification passes scope only when:
- Unknown files = empty
- Forbidden/generated files = empty

## Reporting Proposal
Extend verify report output to clearly separate file groups:
- `currentTaskFiles`
- `dependencyFiles`
- `unknownFiles`
- `forbiddenFilesChanged`
- `generatedArtifactsChanged`

The summary should state whether pass/fail was due to:
- current-task scope
- dependency allowance
- forbidden/generated changes
- command failures

## Open Questions
1. Required dependency status:
- verified?
- approved?
- merged?

2. Dependency depth:
- direct only?
- transitive allowed?

3. Conflict handling:
- if the same file is owned by multiple dependency tasks, how should ownership be resolved?

4. Report format:
- how to present current-task vs dependency files clearly in CLI and JSON?

5. Review integration:
- should `review --working-tree --include-dependencies` also be supported?

## Suggested Future CLI
Primary candidate:
- `scopeguard verify T-002 --working-tree --include-dependencies`

Optional future extension:
- `scopeguard review T-002 --working-tree --include-dependencies`

## Non-Goals for This Design
- No runtime implementation in this change.
- No scheduler changes.
- No planner schema changes.
- No automatic approvals or merges.
