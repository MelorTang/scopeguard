# Desktop v2 Verification

## Automated Gate

Run from the repository root:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

The test suite covers domain transitions, SQLite migration and recovery,
Provider stream normalization and credential redaction, tool confinement and
process-tree cancellation, optional CLI execution, application concurrency and
approval behavior, IPC payload validation, SecretVault serialization, Project
picker authorization, renderer URL trust, and Agent host supervision.

## Deterministic Desktop Gate

1. Start `pnpm smoke:provider`.
2. Start `pnpm dev`.
3. Open a local Project through the native picker.
4. Add an OpenAI-compatible Provider:
   - Base URL: `http://127.0.0.1:47821/v1`
   - API key: any non-empty test-only value
   - Model: any non-empty value
5. Test and save the Provider.
6. Create two native Agent Threads and place both in a split view.
7. Start both Runs before either finishes; confirm their active intervals
   overlap and their messages remain isolated.
8. Stop one Run and confirm the other completes.
9. Send `[tool:read]` and confirm the Agent reads `package.json`.
10. Send `[tool:write]` or `[tool:command]`; deny once, then retry and allow
    once. Remove the generated `scopeguard-write-smoke.txt` after verification.
11. Publish Project Context and confirm the next Run snapshots that revision.
12. Quit normally during a Run, reopen it, and confirm all emitted partial
    output is interrupted with a Retry action.
13. Force-kill during a Run, reopen it, and confirm the latest checkpoint is
    recovered as interrupted with a Retry action.
14. Create a Local CLI Agent with a harmless command and verify streaming,
    cancellation, and persistence.

## Security Checks

- Search the SQLite database, renderer logs, and repository for the test API
  key; it must not appear.
- Confirm the credential file is user-only and contains encrypted values.
- Attempt to add a Project by invoking IPC without first using the picker; it
  must fail.
- Attempt `read_file`/`write_file` traversal and symlink escapes; they must
  fail.
- Cancel a command that ignores `SIGTERM`; parent and child PIDs must both exit.
- End an SSE response without `[DONE]` or `message_stop`; the Run must fail.

## Visual Gate

- `1024x720`: one usable pane, visible composer, Inspector cannot cover Send.
- `1440x900`: two panes plus Inspector, with no overlap.
- `1600x900`: three panes with Inspector closed.
- `1920x1080`: four panes at no less than 400 px each.
- Keyboard-only: tabs, modal focus trap, approvals, split controls, and
  Inspector are operable.

## Release-External Work

The source MVP is usable without these items, but public distribution still
requires signed/notarized installers, auto-update policy, crash reporting and
privacy decisions, and runtime verification on Windows and Linux.
