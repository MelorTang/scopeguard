# ScopeGuard V1 Verification

Status: Current acceptance entry for the personal multi-Agent reset. Phases 0,
1, and 2 are accepted. Historical Native Harness and Managed Execution checks
are not release gates for the active Runtime.

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
- a fresh `scopeguard-personal-pi-v1` schema stores product metadata and the
  Conversation-to-Pi locator, but no transcript, Tool result, or compaction;
- old or malformed schemas and missing, corrupt, incompatible, or mismatched Pi
  locators fail explicitly without migration or an empty replacement Session;
- the manifest permits exactly one final hashed Tool policy; Workspace `read`
  is the only automatic allowlist, known side effects require exact-tuple
  approval, and unknown Tools block;
- a real Desktop host completes a Pi turn, exits fully, restarts against the
  same database and opaque Session, continues, and proves the Provider received
  prior context;
- Windows development and staged Runtime trees both pass that restart/resume
  Pilot. These are the Phase 2 real Desktop hard gates;
- the automated Windows Pilot uses a test-only encrypted Vault adapter. Normal
  Desktop startup still uses Electron `safeStorage`. Both Phase 2 Pilot commands
  fail unconditionally on macOS before Electron spawn, with no override. Signed
  macOS installation, `safeStorage`, and real restart recovery use a separate
  future Phase 5 distribution entry and are not Phase 2 restart evidence;
- qualification, frozen install, repository tests, typecheck, build, package
  staging, link checks, secret/temp scans, and `git diff --check` pass.

## Phase 3: Parallel Workbench And Dispatch

Status: candidate implementation under review. Phase 3 is not accepted until
GitHub issue #26 passes the Windows development and staged Pilots plus an
independent Standards and Spec review.

Exit gate:

- one to four Conversations remain present with independent composers and Run
  state; each Workspace owns its open/active/pane IDs and bounded pane widths;
- mouse and keyboard separators resize adjacent panes independently, and narrow
  windows retain every requested pane behind horizontal scrolling instead of
  hiding panes;
- four real Pi sessions can run concurrently and one can be stopped in isolation;
- manual Handoff prompts copy cleanly;
- Agent Dispatch targets an existing Conversation, records source attribution,
  never copies a full transcript, and is visible at both ends;
- restart restores each Workspace's own pane IDs and widths, Conversations, and
  resumable sessions without cross-Workspace debounce or ID leakage;
- every Renderer layout mutation is staged immediately in the Main-owned
  coordinator. Before Agent Host ready reload, BrowserWindow close, or terminal
  app quit suspends Main staging, Main must receive a bounded acknowledgement
  that the real Renderer coordinator has stopped new layout mutations and
  drained every Workspace's latest pending revision. Main then flushes through
  Agent Host and SQLite before preparing the destructive action. Reload and
  close use an abortable preparation that can only return a synchronous commit;
  a timeout aborts preparation and permanently discards any late commit. App
  quit keeps the Renderer alive throughout every recoverable preparation;
  after preparation returns its terminal commit, it synchronously destroys the
  Renderer before the independently bounded Agent Host stop. A failed or timed-out Renderer
  drain acknowledgement, Main flush, or recoverable action preparation resumes
  layout acceptance on both sides, blocks the lifecycle action, and reports the
  failing lifecycle context.
  BrowserWindow close failures remain visible rather than being swallowed.
  Pending revisions, retry timers,
  and drains are isolated per Workspace, while the Renderer accepts only the
  exact runtime-validated stage-result union;
- Playwright screenshots cover desktop and constrained-width layouts without
  overlap or unreadable controls.
- Windows development and staged both pass the real `pilot:phase3` workflow on
  the exact candidate SHA. Each Desktop process creates a real BrowserWindow
  and uses the production preload/IPC API under the deny-all permission policy;
  `createMockDesktopApi` is not part of this gate. The Pilot proves four
  distinct Pi Sessions, targeted cancellation, controlled Handoff clipboard
  write, successful and busy-target Dispatch, full Desktop restart,
  a no-debounce pane-close mutation flushed by app quit, SQLite
  layout/session/Dispatch recovery, disk Vault credential recovery, secret
  absence, and complete process-tree cleanup. The Pilot also records a target
  layout revision through the real Main/preload/Renderer path: it must first be
  rejected while Main is quiescing. The real Renderer coordinator must then
  return a drain-generation receipt naming the exact Workspace, revision, and
  layout that its drain started and Main accepted, followed by Main suspension,
  SQLite flush, synchronous Renderer destruction, and bounded Agent Host stop.
  A normal retry that
  was already in flight when Main requested a drain is excluded from that
  generation; if it accepts the target first, the Pilot fails. The exact
  shutdown sequence remains
  `renderer-layout-drained -> layout-suspended -> layout-flushed ->
  renderer-destroyed -> host-stop-started -> host-stop-complete`; a separate
  delayed Renderer revision must never cross IPC after destruction.
- Unsigned macOS Phase 3 Pilot automation fails before Electron spawn. Signed
  macOS installation, `safeStorage`, and recovery remain Phase 5 gates. Linux
  remains optional engineering evidence and is not a product-support gate.

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

The Phase 2 gate uses the following command set:

```bash
pnpm install --frozen-lockfile
pnpm qualify:pi-rpc
pnpm test
pnpm typecheck
pnpm build
pnpm pilot:pi-runtime
pnpm pilot:pi-runtime:staged
pnpm --filter @scopeguard/desktop package:prepare
git diff --check
```

The Phase 3 candidate adds:

```bash
pnpm --filter @scopeguard/desktop test:renderer
pnpm pilot:phase3
pnpm pilot:phase3:staged
```

Windows Development and Windows staged are the Phase 2 real Desktop hard gates.
Both passed 15/15 at Runtime evidence commit `8554a642`, including same-session
restart/resume, Provider-observed prior context, disk Vault credential recovery,
and complete process-tree cleanup. The two Pilot commands intentionally reject
unsigned macOS before Electron spawn; signed macOS installation, `safeStorage`,
and real recovery remain Phase 5 gates. Linux Development and staged are
optional engineering evidence, do not represent product support, and do not
block Phase 2. The earlier Linux Development failure occurred while preparing
the Electron environment before Desktop or Pi started, so it is not a product
Runtime failure. A real external Provider smoke is optional and must not print
or fixture its credential.

Every milestone report must identify the exact commit, platform, Pi version,
fixtures, command results, remaining gaps, and whether evidence comes from the
new runtime or the retired implementation.
