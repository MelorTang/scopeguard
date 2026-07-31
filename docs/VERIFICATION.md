# ScopeGuard First-Stage Verification

This gate separates deterministic code checks, Renderer-only visual checks, and
real Electron behavior. Web preview results never substitute for Desktop,
SecretVault, SQLite, Provider, tool, or remote Runtime evidence.

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

- Workspace/Agent/Task/Artifact/Handoff/Inbox transitions and schema v1-v6 migration.
- two concurrent Runs with independent cancellation.
- three-Agent transcript isolation and explicit Context/Handoff sharing.
- Context and Artifact provenance rejection for forged source relationships.
- tool path confinement, approval denial, process-tree cancellation, and partial recovery.
- explicit Agent input requests that pause and resume the same Run through Inbox.
- successful `write_file` execution registered as a provenance-rich file Artifact.
- Provider and Runtime credential redaction plus SecretVault rollback behavior.
- Runtime HTTP authentication, idempotent submission, cancellation, event cursor,
  non-loopback HTTPS enforcement, and database secret scan.
- Desktop shutdown/restart reconnection to a still-running remote Run.
- IPC payload validation, sender trust, picker authorization, Renderer navigation,
  and Agent-host supervision.

## 2. Deterministic Services

Start the test Provider in terminal A:

```bash
pnpm smoke:provider
```

Expected URL and key:

```text
URL: http://127.0.0.1:47821/v1
API Key: sg-fake-desktop-validation-key
Model: smoke-model
```

Build and start the persistent Runtime in terminal B:

```bash
pnpm runtime:build
SCOPEGUARD_RUNTIME_TOKEN='sg-runtime-smoke-token' \
SCOPEGUARD_RUNTIME_HOST='127.0.0.1' \
SCOPEGUARD_RUNTIME_PORT='47822' \
SCOPEGUARD_RUNTIME_DB='/tmp/scopeguard-runtime-smoke/runtime.sqlite' \
pnpm runtime:start
```

The remote Runtime URL is `http://127.0.0.1:47822`. Keep both services alive
through the Desktop exit/reopen test.

## 3. Fresh Electron Gate

Build and launch with isolated user data in terminal C. This avoids touching a
normal ScopeGuard profile:

```bash
pnpm build
SCOPEGUARD_SMOKE_DATA="$(mktemp -d /tmp/scopeguard-desktop-smoke.XXXXXX)"
pnpm --filter @scopeguard/desktop exec electron . \
  --user-data-dir="$SCOPEGUARD_SMOKE_DATA"
```

Verify the first-run path without editing source or SQLite:

1. Create a Workspace named `行业简报`; do not select a local folder.
2. Add the test Provider above, run connection test, and save it.
3. Add Runtime `常驻节点` with URL `http://127.0.0.1:47822` and token
   `sg-runtime-smoke-token`; test connection and confirm `已连接`.
4. Create three API Agents from `调研`, `核验`, and `文档` templates. Bind each
   to `常驻节点`. Confirm Local CLI is unavailable because the Workspace has no folder.
5. Confirm each Agent has its own initial Task and can be opened in an independent pane.

## 4. Concurrent Isolation Gate

1. Show the 调研 and 核验 tasks in two panes.
2. Start both Runs before either completes.
3. Confirm both display running/streaming state at the same time.
4. Stop one Run and confirm only that Task is cancelled; the other completes.
5. Retry the cancelled Task and confirm it can complete independently.
6. Confirm completion creates a Markdown Artifact and a completion Inbox item.

The automated test additionally asserts that private transcript markers from
Agent A are absent from Agent B and C Provider requests.

## 5. Remote Exit And Reconnect Gate

1. In any Agent task, send `[slow] 生成一份远端续跑验证报告`.
2. Wait until the Run is shown as running on `常驻节点`.
3. Quit ScopeGuard completely with `Cmd+Q`; do not stop terminal A or B.
4. Wait at least 7 seconds.
5. Re-run the same Electron command with the same `SCOPEGUARD_SMOKE_DATA` value.
6. Confirm the original Run is completed, its events/messages are restored, and
   exactly one final Artifact is visible with the correct Agent, Task, Run, and time.

Stopping only Desktop must not cancel the remote job. Stopping the Runtime
process itself is outside first-stage continuity because Provider credentials
are intentionally not persisted remotely.

## 6. Non-coding Three-Agent Gate

1. Run 调研 Agent with `整理某行业本周三条值得关注的变化，区分事实与假设`.
2. Open its Artifact, inspect provenance, and choose `发布` to create a new Context revision.
3. In Context, send a Handoff to 核验 Agent with a concrete verification brief.
4. Run 核验 Agent. Confirm the Handoff moves from `等待接收` to `已接收`, and
   that its Run records the published Context version.
5. Publish the核验 Artifact, then send a Handoff to 文档 Agent.
6. Run 文档 Agent to generate the final Markdown brief.
7. Confirm the final Artifact is previewable and traces to the 文档 Agent,
   its Task, Assignment, Run, version, and creation time.
8. Confirm no UI action exposes the source Agent's full private Thread as shared context.

## 7. Local Tool And Approval Gate

Use a separate Workspace opened from a disposable local folder:

1. Create a native local Agent with read `允许`, write `每次询问`, command `每次询问`.
2. Send `[tool:read]`; confirm `package.json` is read only inside the selected root.
3. Send `[tool:write]`; deny once and confirm no file is created.
4. Retry and allow once; confirm `scopeguard-write-smoke.txt` is created only after approval.
5. Confirm the successful write appears in Artifacts with Agent, Task, Run, MIME type,
   absolute file path, version, and generation time.
6. Send `[tool:input]`; confirm the Run and Task change to `等待输入`, an Inbox item
   displays the exact question, and the composer remains available.
7. Reply in the same conversation and confirm the same Run resumes, the Inbox item
   resolves, and the reply is returned to the Agent without entering another Thread.
8. Send `[tool:command]`; verify the exact command appears in Inbox before execution.
9. Remove the disposable folder after the test.

## 8. Restart And Recovery Gate

1. Enter unsent message and Context drafts, configure a multi-pane layout, then quit/reopen.
2. Confirm Workspace, Agents, Tasks, Threads, messages, Context, Inbox, Artifacts,
   drafts, active panes, inspector state, and split count return.
3. Quit during a local Run and confirm it returns as interrupted with partial output and retry.
4. Confirm a remote-bound Run is not falsely converted to interrupted and instead reconciles.

## 9. Security Checks

- Search desktop SQLite, remote SQLite, normal logs, and repository output for
  `sg-fake-desktop-validation-key` and `sg-runtime-smoke-token`; neither may appear.
- Confirm stored secret inputs are blank when dialogs reopen and snapshots expose
  only `hasCredential`, never a secret or SecretVault reference.
- Attempt directory registration over IPC without the native picker; it must fail.
- Attempt file traversal and symlink escapes; they must fail.
- Deny a command approval and confirm execution count remains zero.
- Test an invalid Runtime token: node becomes offline, affected Agent gets one
  deduplicated Inbox item, and the token is absent from the error.
- Confirm BrowserWindow has `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, blocked webviews, denied popups, and restricted navigation.

## 10. Visual And Accessibility Gate

- `1024x720`: one pane, composer reachable, inspector scrolls without covering actions.
- `1280x800`: two-pane layout remains usable without horizontal overflow.
- `1440x900`: two panes plus inspector, no overlaps.
- `1600x900`: three panes with inspector closed, no text clipping.
- Keyboard-only: Workspace/Task navigation, dialogs, pane controls, Inbox,
  approval decisions, Artifact publish, and Handoff are reachable with visible focus.
- Reduced-motion mode removes non-essential animation.
- A fresh console contains no current Renderer errors or React hook-order warnings.

## 11. Latest Local Evidence

Verified on macOS on 2026-08-01 from an isolated Electron user-data directory:

- `pnpm test`: 119 tests passed across 10 packages.
- `pnpm typecheck`, `pnpm build`, and `git diff --check`: passed.
- Fresh production Electron created one no-folder Workspace, one Provider, one
  authenticated remote Runtime, and three remote Agents without source or database edits.
- A `[slow]` remote Run completed while Desktop was fully exited. Before reopen,
  remote SQLite showed `completed`, 11 events, and one Artifact; Desktop then
  reconciled the Run and imported exactly one Artifact.
- Real Electron completed 调研 -> 核验 -> 文档 with two explicit Context
  publications, two Handoffs moving from pending to accepted, and three
  Agent-attributed Artifacts.
- Two additional remote Runs overlapped for about 4.7 seconds. UTC intervals
  were `17:50:18.581-17:50:24.051` and `17:50:19.291-17:50:24.756`.
- A real local `run_command` proposal appeared in both the Thread and Inbox.
  Denial persisted `tool_status=denied` and `approval_status=denied`.
- Application integration verified that `request_user_input` moves the Run,
  Task, and Assignment to waiting-input, creates a durable Inbox question, and
  resumes the same Run after a reply. The Web preview completed the matching
  `/ask-input` flow through the visible composer and task locator.
- A successful `write_file` integration registered a separate file Artifact
  with Agent, Task, Assignment, Run, absolute path, MIME type, and version provenance.
- Restart restored the selected Workspace, two-pane layout, Threads, messages,
  Inbox, Artifacts, and an unsent draft.
- Plaintext scan across desktop and remote test data found neither test credential;
  desktop data directory, SQLite, encrypted secret file, and Runtime SQLite had
  owner-only permissions.
- Web layout checks at 1024, 1280, 1440, and 1600 px found no document overflow,
  off-viewport controls, or clipped buttons. Fresh console had 0 errors and 0
  warnings; reduced-motion removed animation and keyboard focus had a visible 2 px outline.

## 12. Release-External Work

Source MVP verification does not cover signed/notarized installers, auto-update,
crash reporting, privacy policy, Windows/Linux packaging, production TLS
operations, or public Runtime hardening. Those are release engineering work,
not evidence for the first-stage product loop.
