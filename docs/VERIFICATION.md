# ScopeGuard V1 Verification

Status: Current acceptance entry for the personal multi-Agent reset. Historical
Native Harness and Managed Execution checks remain regression evidence for old
code, not release gates for the new runtime.

## Phase 0: Product Reset

Exit gate:

- `main` is safely pushed without force and the old route has a remote branch
  and annotated tag checkpoint.
- `CONTEXT.md` is a glossary for the personal-first domain.
- ADR 0024 records the Pi RPC ownership boundary and every conflicting ADR links
  to its superseding decision.
- README and architecture entry points describe only the new target and clearly
  identify the implementation gap.
- Historical research is retained as dated input, not current authority.
- One `wayfinder:map` tracks Phase 0 through Phase 5 and all active children.
- `git diff --check` and local Markdown-link validation pass.
- No Runtime or UI product code changes are included.

## Phase 1: Pi RPC Qualification

Use a pinned Pi version and a disposable local Workspace. The prototype must
prove with recorded fixtures:

- supervised process startup, readiness, shutdown, and crash reporting;
- streaming text and structured Tool call/result events;
- targeted interruption without stopping another concurrent session;
- stable session creation, locator persistence, restart, and resume;
- compaction followed by successful continued execution;
- Provider and Model configuration without plaintext credential persistence;
- at least four independent concurrent sessions;
- explicit classification of every unsupported or lossy mapping.

Exit gate: the evidence supports a go/no-go ADR. A missing session, Tool,
Provider, interruption, or compaction contract blocks replacement; ScopeGuard
must not emulate a capability and label it native Pi behavior.

## Phase 2: Runtime And Storage Reset

Exit gate:

- the retired Native Harness path is removed from the active composition root;
- a fresh schema stores Workspace, Agent, Conversation mapping, Artifact, and
  Dispatch metadata without migrating old development databases;
- Pi sessions resume after a real Desktop restart;
- malformed, missing, or incompatible session state fails explicitly;
- repository tests, typecheck, and build pass.

## Phase 3: Parallel Workbench And Dispatch

Exit gate:

- one to four Conversations remain visible with independent composers and Run
  state at supported desktop widths;
- four real Pi sessions can run concurrently and one can be stopped in isolation;
- manual Handoff prompts copy cleanly;
- Agent Dispatch targets an existing Conversation, records source attribution,
  never copies a full transcript, and is visible at both ends;
- restart restores Workspace, pane layout, Conversations, and resumable sessions;
- Playwright screenshots cover desktop and constrained-width layouts without
  overlap or unreadable controls.

## Phase 4: Artifact And Office Tool Pack

Exit gate:

- Artifact versions and Workspace-file changes are distinct and recoverable;
- DOCX, XLSX, PPTX, and PDF fixtures cover inspect, generate or revise, preview,
  and export behavior selected for V1;
- structure and rendered-output checks use representative public or synthetic
  fixtures; private enterprise samples are not a release prerequisite;
- conflicting Workspace writes stop instead of silently overwriting;
- Artifact Review and return to the multi-Conversation workbench preserve state.

## Phase 5: Usable Desktop Milestone

Exit gate:

- clean installation and first-run setup pass on Windows 10/11 x64 and supported
  macOS development hardware;
- a User can configure a Provider, Model, Agent, Skill, and local Workspace
  without editing source files;
- a real programming project and a general office workflow both complete through
  multiple Conversations, Handoff or Dispatch, restart, and Artifact review;
- secrets are absent from logs and product metadata;
- tests, typecheck, build, packaging, restart recovery, and a disposable local
  pilot all pass from documented commands;
- known limitations are visible and no unsupported Pi behavior is presented as
  available.

## Current Commands

Until Phase 2 replaces the runtime, these commands verify repository health but
do not prove the new Pi RPC architecture:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pilot:local
git diff --check
```

Every milestone report must identify the exact commit, platform, Pi version,
fixtures, command results, remaining gaps, and whether evidence comes from the
new runtime or the retired implementation.
