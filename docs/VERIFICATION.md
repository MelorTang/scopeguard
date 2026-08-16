# ScopeGuard Core Verification

This gate separates deterministic code checks, Renderer-only visual checks, and
real Electron behavior. Web preview never substitutes for Desktop, SecretVault,
SQLite, Provider, file-tool, or managed-execution evidence.

## 1. Automated Gate

Run from the repository root:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Required coverage includes:

- schema migration and non-destructive retention of legacy database history;
- native Agent profile creation and rejection of legacy execution kinds;
- independent concurrent Runs and per-Run cancellation;
- conversation transcript isolation and explicit Project Context use;
- immutable request manifests, settings snapshots, and usage persistence;
- approval denial, automatic approval, and cancellation while waiting;
- user-input continuation in the same Run and conversation;
- path confinement, command routing, partial-output recovery, and unknown effects;
- Provider credential redaction and SecretVault rollback;
- Agent-host shutdown interruption, IPC validation, sender trust, native picker
  authorization, navigation restrictions, and host supervision.

The Windows managed-execution matrix remains defined in
`.github/workflows/managed-execution-windows.yml`.

## 2. Deterministic Provider

Start the local test Provider:

```bash
pnpm smoke:provider
```

Use:

```text
URL: http://127.0.0.1:47821/v1
API Key: sg-fake-desktop-validation-key
Model: smoke-model
```

## 3. Fresh Electron Gate

Launch with isolated user data so a normal ScopeGuard profile is untouched:

```bash
pnpm build
SCOPEGUARD_SMOKE_DATA="$(mktemp -d /tmp/scopeguard-desktop-smoke.XXXXXX)"
pnpm --filter @scopeguard/desktop exec electron . \
  --user-data-dir="$SCOPEGUARD_SMOKE_DATA"
```

Verify:

1. Create one Workspace without a folder and configure the test Provider.
2. Create two native Agents with different instructions.
3. Create two conversations and display them in parallel panes.
4. Start both before either finishes; cancel one and confirm the other completes.
5. Restart the cancelled conversation and confirm it can complete independently.
6. Confirm no Runtime, Task, Artifact, Handoff, Inbox, or external CLI setup is
   required by the workflow.

## 4. Conversation And Context Gate

1. Confirm the conversation's Agent cannot be changed.
2. Change its model override and execution profile, then confirm the next Run
   snapshot records both values without changing the Agent.
3. Put a private marker in conversation A and run conversation B; Provider input
   for B must not contain A's transcript.
4. Publish a short Project Context revision from A, then run B; B may receive the
   explicit revision while A's remaining transcript stays private.
5. Trigger a user-input request, answer in the same composer, and confirm the
   same Run resumes instead of creating another Run.

## 5. Local Tool Gate

Use a disposable folder in a separate Workspace:

1. Confirm `read_file` cannot escape the selected root.
2. Deny a write once and confirm no file is created.
3. Retry and approve; confirm the file appears only after approval.
4. Cancel one command while another conversation runs; the unrelated Run must
   remain active.
5. On Windows, run a command under Request Approval, Auto Approve, and Full
   Access. The first two must use the bounded path; Full Access must be labeled
   as current-user execution.
6. Make the bounded adapter unavailable and confirm execution fails closed.

## 6. Restart And Recovery Gate

1. Save an unsent draft and multi-pane layout, then quit and reopen.
2. Confirm Workspace, Agents, conversations, messages, layout, and draft return.
3. Quit during a native Run; on restart it must be `interrupted`, retain partial
   output, and allow retry.
4. Seed a non-terminal legacy remote-bound Run in a migration fixture; startup
   must interrupt it rather than wait for the removed remote owner.
5. Recover an unfinished non-idempotent tool call and confirm its effect remains
   unknown.

## 7. Security Gate

- Search desktop SQLite, logs, and build output for the test API key; it must not
  appear.
- Reopened Provider dialogs expose only credential presence, never the key or
  SecretVault reference.
- Attempt directory registration without the native picker; it must fail.
- Attempt traversal and symlink escapes; they must fail.
- Confirm BrowserWindow uses `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, blocks webviews and popups, and restricts navigation.

## 8. Visual Gate

- Check 1024x720, 1280x800, 1440x900, and 1600x900.
- One to four panes must preserve reachable composers and independent Run states.
- Sidebar selection must not duplicate the pane hierarchy.
- Keyboard focus is visible; dialogs and approval actions are keyboard reachable.
- Reduced-motion mode removes non-essential animation.
- A fresh console has no Renderer errors or React hook-order warnings.

Record current evidence only after all applicable gates pass. Historical remote
Runtime and control-plane demonstrations are not evidence for this core.
