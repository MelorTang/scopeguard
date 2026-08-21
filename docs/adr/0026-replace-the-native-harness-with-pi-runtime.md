# Replace the Native Harness with the pinned Pi Runtime

Status: Accepted on 2026-08-20.

Phase 4 extends this schema to version 2 under
[ADR 0027](./0027-use-agent-tools-for-file-editing.md). The version-1 statements
below remain the accepted Phase 2 evidence boundary; the active implementation
allows only its exact Phase 3 candidate shape to migrate to the Artifact schema.
The rejection of retired, unknown, partial, or malformed databases remains
unchanged.

Implements the Runtime ownership chosen by ADR 0024 and the constrained Pi RPC
Go accepted by ADR 0025. This decision does not authorize Phase 3 workbench or
Dispatch UX, Phase 4 Agent file-editing behavior, or migration of retired
development data.

## Context

The active Desktop composition still owned a ScopeGuard Agent loop, transcript,
Tool lifecycle, compaction, and Native Harness fallback. Keeping those paths
beside Pi would create two Runtime truths and make Session recovery ambiguous.
The retired enterprise implementation is already recoverable from its branch
and annotated tag checkpoint, so V1 does not need a compatibility track.

Pi extension loading is dynamic. A single-file CLI bundle can pass `--version`
yet fail only when `jiti` loads the approval extension because dynamically
required packages are absent. Runtime packaging therefore has to preserve the
fixed upstream production dependency graph, not infer it from static bundling.

## Decision

The Phase 2 implementation replaces the active Native Harness composition root with
`@scopeguard/pi-runtime`, which owns an exact dependency on
`@earendil-works/pi-coding-agent@0.84.2` and starts the upstream RPC CLI.
There is no Native Harness fallback.

The managed Pi process starts with automatic discovery disabled. Readiness
requires the exact CLI version and a SHA-256 manifest containing exactly one
final ScopeGuard Tool-policy extension. The policy confines `read` to the active
Workspace and applies Agent allow/ask/deny permission, sends `bash`, `write`,
and `edit` through the exact approval tuple required by ADR 0025, and blocks
unknown Tools. Request Approval waits for the User, Auto Approve responds only
when Agent policy does not deny the Tool, and Full Access responds for known
Tools without admitting unknown extensions. Any
version, hash, composition, protocol, startup, or approval-channel failure stops
the owning Run without enabling Tools.

ScopeGuard creates schema family `scopeguard-personal-pi-v1`, version 1. It owns:

- Workspace, Provider reference, Agent, Conversation, Run, and context metadata;
- the complete opaque Pi Session locator and fixed Pi/Session versions;
- exact approval tuples and Tool effect certainty;
- reserved Artifact, Dispatch, and layout metadata tables for later phases.

Pi owns the Session JSONL transcript, Tool calls and results, compaction, and
resume truth. ScopeGuard has no competing message, Tool-result, or compaction
tables. At most one nonterminal Run may exist per Conversation.

Existing databases must match the family/version, complete table and column
shape, and SQLite integrity. Existing locators must be complete and openable and
must match the pinned Pi version, Session format, Session ID, and Workspace.
Old, partial, corrupt, incompatible, missing, or mismatched state is rejected.
There is no migration, compatibility interpretation, or silent empty Session.

Desktop package staging uses a minimal Pi-only packaging manifest and independent
frozen lock to create a temporary hoisted production dependency tree, then
launches the original upstream CLI from that tree. The product package, packaging
manifest, staged package, and policy manifest must all name Pi 0.84.2. The
generated executable bundle does not vendor or fork Pi source. Package readiness
repeats the same version and policy checks used in development.

## Effect Certainty

Approval alone does not prove a side effect completed. Once an exact tuple is
approved, the Run is persisted as `effect_unknown` until Pi returns enough
evidence to classify it as `confirmed` or no effect. A crash, interruption, or
lost response preserves that uncertainty. A Run interrupted before any approved
side effect retains `none`; restart does not manufacture uncertainty merely
because a Run was active.

## Verification Contract

The accepted implementation must keep all of these machine-verifiable:

1. fresh schema creation and explicit rejection of old or malformed families;
2. policy allow/block/approve behavior, exact response union, manifest drift,
   protocol corruption, bounded redacted diagnostics, and Pi crash behavior;
3. missing, corrupt, version-incompatible, ID-mismatched, and Workspace-mismatched
   Session rejection;
4. real Desktop-host first turn, full host exit, same-locator restart/resume,
   second turn, and Provider-observed prior context;
5. the same restart/resume proof against the packaged Runtime deployment tree;
6. the independent Phase 1 qualification plus root install, tests, typecheck,
   build, package verification, links, secret/temp scans, and diff checks.

The automated Desktop Pilot uses an explicit test-only authenticated-encryption
adapter for the production `EncryptedSecretVault`. Its two fresh Desktop
processes share only an ephemeral Pilot key, so the second process must decrypt
the credential from disk without invoking a real OS credential store. Linux also
uses `--password-store=basic`. The production startup path supplies no Pilot
configuration and dynamically loads Electron `safeStorage` only outside Pilot
mode.

An unsigned macOS development Electron presented a Keychain authorization dialog
despite Chromium's mock-keychain switch on 2026-08-19. Both Phase 2 Pilot commands
therefore reject macOS unconditionally before spawning Electron; there is no
environment-variable assertion that can bypass this gate. Desktop `main.ts`
repeats the platform rejection before creating the test Vault, AgentHostClient,
or Pi Runtime. Signed macOS installation, `safeStorage`, and real recovery use a
separate future Phase 5 entry point.

This decision is accepted from Runtime evidence commit
`8554a642d52d35f6eb62062f83729501157d418f`. Windows is the Phase 2 acceptance
platform. Its development and staged Pilots each passed 15/15, including two
fresh Desktop processes, the same Pi Session across restart, Provider-observed
first-turn and second-turn context, credential recovery from the disk Vault, and
complete process-tree cleanup. Repository tests passed 83/83; Pi qualification
passed 26/26; typecheck, build, package verification, links, secret scan, and
diff checks also passed.

Linux is not a product target platform. Its Development and staged Pilots are
optional engineering evidence and create no support commitment or Phase 2 gate.
The earlier Linux Development failure occurred during Electron environment
preparation before Desktop or Pi started and is not a product Runtime failure.

## Consequences

- Pi upgrades require qualification and product-lock review before Runtime use.
- Runtime package size includes Pi's production dependency graph; correctness of
  dynamic extension loading takes priority over a misleading single-file CLI.
- User-installed Skills and unmanaged high-power CLIs remain outside this
  controlled Tool-policy composition until their later product boundary exists.
- Windows installer and macOS distribution evidence remain Phase 5 gates; Phase
  2 proves development and staged package Runtime behavior, not final installers.
