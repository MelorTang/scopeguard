# Changelog

ScopeGuard, formerly AgentBoard during MVP development.

Compatibility note: the legacy `agentboard` CLI alias and `.agentboard` directory remain supported during migration.

## v0.4.0-preview (pre-release)

### Documentation and Preview Readiness

- Productized README for public developer preview context.
- Added `docs/QUICKSTART.md` with source-run and external repo dogfood flow.
- Added `docs/PREVIEW_LIMITATIONS.md` with explicit preview constraints.
- Refreshed command and workflow docs for current CLI usage.

## v0.3.9

### Added

- Dependency-aware working-tree verification:
  - `scopeguard verify <task-id> --working-tree --include-dependencies`
  - Supports direct dependency task file ownership during scope checks.
- Combined mode support:
  - `scopeguard verify <task-id> --working-tree --include-dependencies --scope-only`

## v0.3.8

### Added

- Scope-only verification mode:
  - `scopeguard verify <task-id> --scope-only`
  - `scopeguard verify <task-id> --working-tree --scope-only`
- Scope checks can be run without command execution.

## v0.3.7

### Added

- Manual working-tree verification:
  - `scopeguard verify <task-id> --working-tree`
- Manual working-tree review generation:
  - `scopeguard review <task-id> --working-tree`

## v0.3.6

### Changed

- Planner prompt and CLI user-facing wording updated to prefer `scopeguard` command examples over legacy `agentboard` examples.

## v0.3.5

### Fixed

- Smoke behavior in external repositories:
  - doctor failures now fail smoke doctor check correctly.
  - missing data directory now fails smoke data-directory check correctly.
  - external repos no longer fail smoke due to missing local source bin files.
- Doctor wording cleanup continued for ScopeGuard naming consistency.

## v0.3.4

### Changed

- Cleaned legacy AgentBoard wording in doctor output:
  - scopeguard-first user-facing messages.

## v0.3.3

### Added

- `docs/DOGFOOD.md` with guidance for running ScopeGuard against external repositories.

## v0.3.2

### Added

- Local CLI usage and link/install documentation updates.
- Handoff summary refresh for ongoing development continuity.

## v0.3.1

### Added

- `scopeguard smoke` read-only MVP smoke test command.
- `scopeguard smoke --json` structured output mode.

## v0.3.0

### Baseline

- ScopeGuard rename baseline after AgentBoard MVP:
  - Display rename to ScopeGuard.
  - Primary CLI set to `scopeguard` with `agentboard` legacy alias retained.
  - `.scopeguard` primary data directory with `.agentboard` legacy compatibility.

## v0.1.0-mvp

### Added

#### Planning

- Project scan (`agentboard scan`) and project map generation.
- Planner prompt generation (`agentboard plan`).
- Plan validation (`agentboard validate-plan`).
- Plan import into task records (`agentboard import-plan`).

#### Scheduling

- Next-task recommendation (`agentboard next`).
- Parallel-safe batching (`agentboard schedule`).
- `lockedFiles` overlap handling with conservative path containment.
- Pre-run scheduling guard for task state/dependency/lock checks.

#### Execution

- Codex runner (`agentboard run <task-id> --runner codex`).
- Per-task git worktree isolation.
- File lock service and lock management.
- Generated task prompt/context output for agent execution.

#### Safety

- Task verifier (`agentboard verify`).
- Generated artifact detection in verification.
- Scope repair command (`agentboard fix-scope`).
- Safe rollback/discard (`agentboard discard`).
- Task close/reopen hygiene (`agentboard close`, `agentboard reopen`).
- Environment and repository health check (`agentboard doctor`).

#### Review and Merge

- Human review report (`agentboard review`).
- Approval gate (`agentboard approve`).
- Conservative merge flow (`agentboard merge`).
- Conflict continuation flow (`agentboard merge --continue`).

#### Interfaces

- CLI command suite for full MVP workflow.
- Local Web UI board with safe operations and scheduling visibility.
- Local TUI board with task/scheduler views and safe actions.

#### Documentation

- `README.md`
- `docs/MVP_WORKFLOW.md`
- `docs/SAFETY_MODEL.md`
- `docs/COMMANDS.md`
- `docs/DEMO_SCRIPT.md`
- `docs/RELEASE_CHECKLIST.md`

### Known Limitations

- local-only
- no auth
- no GitHub PR integration
- no automatic LLM planner API
- limited glob overlap solver
- Web UI exposes only safe operations
- run/approve/merge remain CLI-first
- Codex CLI optional and environment-dependent
