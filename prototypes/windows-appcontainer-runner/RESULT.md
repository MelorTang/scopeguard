# Result: provisionally select the ScopeGuard LPAC runner

## Decision

Use the ScopeGuard-owned LPAC launcher as the implementation candidate for managed execution. Do not enable production execution yet. Windows 10 and Windows 11 x64 client validation remains a release gate.

The regular AppContainer mode also passes the current matrix, but LPAC is preferred because it opts out of ambient `ALL_APPLICATION_PACKAGES` access and requires explicit runtime capabilities.

## Windows 11 client checkpoint

On 2026-08-14, the final prototype commit was run locally on a Windows 11
25H2 x64 client, build `26200.9168`, using an interactive user token. The
interactive token is required because Windows Credential Manager rejects
sentinel creation from an OpenSSH logon session.

- Regular AppContainer passed all 35 checks. Its process could read a sentinel
  whose only AppContainer grant was `ALL APPLICATION PACKAGES`.
- LPAC passed 35 of 36 checks. The same sentinel was denied, proving that the
  LPAC process disregarded `ALL APPLICATION PACKAGES`. Every other behavioral
  boundary passed, including
  workspace containment, parent-state isolation, network denial, child-process
  containment, runtime compatibility, and process-tree cleanup.
- The only LPAC failure was `lpac-token-verification`:
  `GetTokenInformation(TokenIsLessPrivilegedAppContainer)` returned
  `ERROR_INVALID_PARAMETER` (`information-class=46`, `error=87`,
  `returned=0`), recorded as `lpac-token-query-unavailable`.

[Microsoft defines LPAC](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)
by its disregard of `ALL APPLICATION PACKAGES` and
[documents the process-creation opt-out attribute](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
used by this launcher. The
differential sentinel therefore resolves whether that security behavior is
active on this Windows 11 client even though the convenience token query is
unavailable. Production integration must still define a fail-closed verifier:
use the direct token flag when available and require a qualified differential
self-test when Windows returns `ERROR_INVALID_PARAMETER`.

This result does not complete the supported client matrix. `productionReady`
and `supportedClientMatrixValidated` therefore remain false.

## Lifecycle recovery checkpoint

Commit `3f9b06b` adds a durable lifecycle ledger shared by normal shutdown and
standalone crash recovery. Every Package SID ACL mutation is recorded before it
is attempted, verified from the resulting DACL, removed by exact SID, and
verified absent before the AppContainer profile is deleted. Profile deletion is
retryable, and repeating recovery is idempotent.

On the Windows 11 client:

- regular AppContainer passed 36 of 36 checks from a clean ACL baseline;
- LPAC passed all 36 behavioral checks, or 36 of 37 in strict mode with only
  the known unavailable LPAC token-information query failing;
- the crash-recovery matrix passed 4 of 4 checks: forced host exit, durable
  recovery evidence, ACL/Profile removal, and idempotent replay;
- five Package SIDs left by older prototype runs were identified across the
  exact ScopeGuard ancestor/runtime grant set and removed. A subsequent run
  left no Package SID ACE on those roots.

A limited-token provisioning attempt was rejected by DACL verification even
though `icacls /C` returned success after skipping protected paths. Production
must therefore place profile and DACL lifecycle operations behind a narrow
elevated provisioner or broker. Agent children remain unprivileged and never
receive that token.

## Passing evidence

[GitHub Actions run 31811224029](https://github.com/MelorTang/scopeguard/actions/runs/31811224029)
passed 36 AppContainer checks, 36 LPAC checks, and all four crash-recovery
checks on Windows Server 2022. Downloaded cleanup artifacts report
`state=cleaned`, no remaining ACL grants, and no profile path for both modes.

[GitHub Actions run 31804862628](https://github.com/MelorTang/scopeguard/actions/runs/31804862628)
passed the differential `ALL APPLICATION PACKAGES` matrix in both AppContainer
and LPAC modes on Windows Server 2022 from commit `349405e`.

[GitHub Actions run 31763241724](https://github.com/MelorTang/scopeguard/actions/runs/31763241724) passed both AppContainer and LPAC modes on Windows Server 2022 from the final prototype commit.

The run verified:

- exact workspace read/write and workspace alternate data streams;
- denial of outside file read/write, outside ADS, parent traversal, junction, hard-link, device-path and UNC escapes;
- isolation from the parent HKCU sentinel, Credential Manager entry, process, named pipe, localhost listener and external network;
- inherited containment for child processes;
- representative CMD, PowerShell, Python, Node document-worker, executable Skill and local stdio-MCP payloads;
- timeout cleanup and kill-on-launcher-exit cleanup for a nested process tree;
- environment allowlisting and an explicit inherited-handle list;
- identical sandbox policy hashes for Request Approval and Auto Approve, with only the reviewer changed.

## Candidate implementation specification

- Create a unique AppContainer profile per managed execution identity.
- Launch suspended with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
- For LPAC, set `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` and grant only `lpacAppExperience`, `registryRead`, and `lpacInstrumentation`.
- Grant the package SID modify access to the workspace, read/execute access to managed runtime roots, and non-inheriting read/execute access to workspace ancestors.
- Grant no network capability by default.
- Pass only explicit stdin/stdout/stderr handles via `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
- Validate the AppContainer token before resume; require LPAC token validation on supported client builds.
- Assign the suspended process to a kill-on-close Job Object before resume. Apply active-process and UI limits.
- Build the process environment from an allowlist. Never inherit provider keys or unrelated parent variables.
- Fail closed on profile, DACL, capability, token, Job, handle-list, launch, timeout, or cleanup verification failure.

## Remaining gates

1. Run both modes and the differential `ALL APPLICATION PACKAGES` proof on Windows 10 x64, then fix the supported-build verification contract for systems where the direct token query is unavailable.
2. Confirm that the three LPAC capabilities and ancestor directory metadata exposure are acceptable in the product threat model.
3. Define the production trust boundary for the narrow elevated profile/DACL
   provisioner. A standard desktop token cannot reliably grant Package SID
   access to volume ancestors or managed runtimes; partial `icacls /C` success
   must fail verification.
4. Add Desktop integration tests proving application exit closes the broker-held Job handle and leaves no managed process, stale ACL grant, or stale package profile.

Until these gates pass, Request Approval and Auto Approve must reject arbitrary local execution rather than fall back to a normal process.
