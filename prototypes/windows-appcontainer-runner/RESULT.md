# Result: provisionally select the ScopeGuard LPAC runner

## Decision

Use the ScopeGuard-owned LPAC launcher as the implementation candidate for managed execution. Do not enable production execution yet. Windows 10 and Windows 11 x64 client validation remains a release gate.

The regular AppContainer mode also passes the current matrix, but LPAC is preferred because it opts out of ambient `ALL_APPLICATION_PACKAGES` access and requires explicit runtime capabilities.

## Windows 11 client checkpoint

On 2026-08-14, the final prototype commit was run locally on a Windows 11
25H2 x64 client, build `26200.9168`, using an interactive user token. The
interactive token is required because Windows Credential Manager rejects
sentinel creation from an OpenSSH logon session.

- Regular AppContainer passed all 34 checks.
- LPAC passed 34 of 35 checks. Every behavioral boundary passed, including
  workspace containment, parent-state isolation, network denial, child-process
  containment, runtime compatibility, and process-tree cleanup.
- The only LPAC failure was `lpac-token-verification`:
  `GetTokenInformation(TokenIsLessPrivilegedAppContainer)` returned
  `ERROR_INVALID_PARAMETER`, recorded as `lpac-token-query-unavailable`.

This client result strengthens the semantic isolation evidence but does not
satisfy the mandatory LPAC token identity gate. `productionReady` and
`supportedClientMatrixValidated` therefore remain false.

## Passing evidence

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

1. Complete strict LPAC token verification on Windows 11 x64 and run both modes on Windows 10 x64. LPAC runs must include `-RequireLpacTokenVerification`.
2. Confirm that the three LPAC capabilities and ancestor directory metadata exposure are acceptable in the product threat model.
3. Specify transactional ACL cleanup and crash recovery. The prototype relies on ephemeral runners.
4. Add Desktop integration tests proving application exit closes the broker-held Job handle and leaves no managed process or stale package profile.

Until these gates pass, Request Approval and Auto Approve must reject arbitrary local execution rather than fall back to a normal process.
