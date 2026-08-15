# Result: provisionally select the ScopeGuard LPAC runner

## Decision

Use the ScopeGuard-owned LPAC launcher as the implementation candidate for managed execution. Do not enable production execution yet. Windows 10 and Windows 11 x64 client validation remains a release gate.

The regular AppContainer mode also passes the current matrix, but LPAC is preferred because it opts out of ambient `ALL_APPLICATION_PACKAGES` access and requires explicit runtime capabilities.

## Windows 11 client checkpoint

On 2026-08-14, the boundary prototype was run locally on a Windows 11
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

## Desktop Broker lifecycle checkpoint

The prototype now separates an unprivileged lifetime Broker from the narrow
elevated profile/DACL Provisioner described in
[`BROKER-SPEC.md`](BROKER-SPEC.md). The Broker holds an outer kill-on-close Job,
opens a synchronization handle to the Desktop parent, and launches the Agent
Host inside that Job. Each concurrent LPAC launcher continues to own its own
inner kill-on-close Job.

On the Windows 11 25H2 x64 client, build `26200.9168`, the Desktop integration
matrix passed all six checks:

- two concurrent Conversations received different Package SIDs;
- each could write its own Workspace and was denied peer Workspace reads and
  writes;
- cancelling launcher A cleared only A's process tree while B remained alive;
- terminating the Desktop parent was detected by the Broker and cleared the
  Broker, Agent Host, launcher B, and B's complete process tree;
- standalone recovery cleaned both exact-SID ACL manifests and deleted both
  AppContainer profiles;
- no cross-Workspace output was created.

All nine recorded parent, Broker, host, launcher, and sandbox process IDs were
independently checked after the run and no longer existed. Both lifecycle
ledgers reported `state=cleaned`, one cleanup attempt, no cleanup errors, and no
remaining profile path. The one-time scheduled task and fixture were removed.

## Runtime Capability minimization checkpoint

Commit `b4777b8` replaced the launcher's implicit three-Capability LPAC profile
with an explicit allowlisted manifest. Unsupported names, duplicates, and any
Capability request without LPAC are rejected. Before resume, the launcher reads
`TokenCapabilities` and requires the exact enabled SID set requested by the
manifest.

The 8-subset matrix ran against CMD, Node, Python, and PowerShell on Windows 11
build `26200.9168` and Windows Server 2022 build `20348`. Both systems produced
the same minimum manifests:

| Runtime | Minimum passing manifest |
| --- | --- |
| CMD | `registryRead` |
| Node | `registryRead` |
| Python | `registryRead` |
| PowerShell | `registryRead`, `lpacInstrumentation` |

All 32 runtime/manifest combinations produced exact Token Capability evidence,
including combinations where runtime startup later failed. All three malformed
manifest checks were rejected with exit code 126. `lpacAppExperience` was not
required by any tested runtime. The full three-Capability profile remains only a
regression superset for the 36-check LPAC boundary matrix.

This is a conditional threat decision, not capability-by-name trust.
`registryRead` explicitly exposes read access to HKLM registry hives, so the
current system runtimes still carry meaningful machine-metadata exposure. The
matrix now records each executable path, file/product version, and SHA-256;
production must repeat it against ScopeGuard-bundled immutable runtimes and try
to remove `registryRead`. Ancestor metadata exposure remains limited to
canonical path resolution; content outside the Workspace stays denied.

## Bundled Node runtime-pack checkpoint

The runtime-pack prototype copies the installed Node executable into an isolated
ScopeGuard-owned payload root, generates an external descriptor manifest, and
requires a caller-pinned manifest SHA-256 before parsing any descriptor field.
The strict resolver rejects duplicate or extra JSON properties, path traversal,
absolute paths, unlisted executables, unsupported/duplicate/noncanonical
Capabilities, payload additions/removal/tampering, named alternate streams,
multiple hard links, and reparse roots. It verifies an exact file inventory,
sizes, SHA-256 digests, executable path, and Capability manifest before any
AppContainer profile is created.

On Windows 11 build `26200.9168`, Node `24.19.0` passed:

- 17 of 17 valid/invalid runtime-pack checks;
- exact Token Capability evidence for all eight Capability subsets;
- the same minimum manifest, `registryRead`;
- Workspace write, outside-write denial, runtime-pack-write denial, and parent
  secret exclusion for every passing subset;
- one-attempt ACL/Profile cleanup with no remaining error or profile path.

The same matrix passed on Windows Server 2022 build `20348` with Node
`22.23.2` (`SHA-256
0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4`).
The CI artifact records 17/17 validation checks, exact token evidence for all
eight subsets, `registryRead` as the minimum runnable manifest, runtime and
outside write denial, parent-secret exclusion, and a cleaned lifecycle ledger
after one cleanup attempt.

This checkpoint does not approve a production package. The test payload is a
copy of the machine runtime, not a signed ScopeGuard artifact. Production must
pin the expected manifest digest through signed application/installer metadata,
install the complete pack in an administrator-owned location that the Desktop
user cannot modify, and verify signatures plus descriptor/file identity. Hashing
inside a user-writable root does not close a validation-to-launch race.

## Narrow Provisioner protocol checkpoint

The elevated Provisioner prototype now accepts only a bounded authenticated
envelope. Its prepare payload contains `workspaceId`, `runtimeId`, and a
caller-assigned execution identity; it cannot carry raw paths, Package SIDs,
Capabilities, ACLs, runtime roots, or manifest digests. The Provisioner derives
the profile name and independently resolves a
strict registered policy, verifies canonical non-reparse paths and single-link
metadata, verifies the complete runtime pack, derives the AppContainer profile
and exact ACL plan, and persists the lifecycle ledger.

On Windows 11 build `26200.9168`, Node `24.19.0` passed:

- 20 of 20 authentication, schema, freshness, identifier, registry, reparse,
  hard-link, runtime-tamper, and unknown-lifecycle checks;
- 7 of 7 Profile/ACL/LPAC lifecycle checks;
- exact `registryRead` token evidence, Workspace write, outside/runtime write
  denial, and parent-secret exclusion;
- idempotent identical prepare and cleanup, conflict rejection, and rejection
  of prepare replay after cleanup;
- one cleanup attempt, no cleanup errors, no profile path, and no remaining
  Package SID ACE on the Workspace or runtime pack.

The check ran in an elevated one-time task, not an installed Windows service.
The fixture's HMAC key was generated in memory and zeroed; it does not settle
Broker identity, named-pipe ACLs, key/handle bootstrap, or same-user renderer
isolation. Registry and state roots were also test directories rather than
administrator-owned installation paths. The protocol is therefore a candidate
service contract, not a production privilege boundary.

The same matrix passed on Windows Server 2022 build `20348` with Node
`22.23.2` (`SHA-256
0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4`).
The downloaded artifact records 20/20 validation checks, 7/7 lifecycle checks,
exact token evidence, all six ACL ledger entries removed, one cleanup attempt,
no cleanup errors, and no remaining Profile path.

## Provisioner startup-recovery checkpoint

Prepare now persists a strict `profile-creation-planned` intent before Profile
creation, updates that intent after Profile creation, writes the lifecycle
ledger, and removes the intent before the first ACL mutation. Startup recovery
scans only execution-derived directories and known state filenames. It validates
intent, tombstone, and ledger identity before acting; malformed or unexpected
state fails closed and is preserved for operator review.

An elevated hard-exit fixture terminates child PowerShell processes with
`Environment.Exit` after intent, after unrecorded Profile creation, after
recording the Profile identity, and after ledger persistence.
On Windows 11 25H2 build `26200.9168`, all 9 checks passed:

- every crash point returned its distinct hard-exit code and left an
  unambiguous durable state;
- intent-only and intent-plus-ledger states removed the Profile and converged
  to a tombstone or cleaned ledger;
- a second startup scan was idempotent and did not increase cleanup attempts;
- recovered execution IDs could not be prepared again; and
- malformed intent identity and invalid state directories failed closed without
  deleting the deliberately retained Profile.

The same machine reran the existing Provisioner matrix after this change and
retained its 20/20 request/registry and 7/7 real lifecycle result. Production
still requires an installed service to invoke recovery before accepting
requests, an administrator-owned state root, and an OS-authenticated Broker
channel. The prototype does not make user-writable lifecycle state trustworthy.

## Passing evidence

[GitHub Actions run 31861864156](https://github.com/MelorTang/scopeguard/actions/runs/31861864156)
passed the complete Windows Server 2022 matrix from commit `8275fa0`. The new
Provisioner startup-recovery result records 9/9 checks across all four hard-exit
windows, four recovered states on both startup scans, and no recovery errors.
Downloaded evidence contains three strict recovery tombstones plus one cleaned
ledger with one cleanup attempt and no cleanup error. The same run retained the
Provisioner's 20/20 request validation and 7/7 real lifecycle result, as well as
all earlier AppContainer, LPAC, Capability, runtime-pack, lifecycle, and Desktop
Broker matrices.

[GitHub Actions run 31824339077](https://github.com/MelorTang/scopeguard/actions/runs/31824339077)
passed the complete Windows Server 2022 matrix from commit `d4317b1`, including
the new narrow Provisioner's 20 request/registry checks and 7 real lifecycle
checks. The same run retained all earlier AppContainer, LPAC, Capability,
runtime-pack, crash-recovery, and Desktop Broker results. Downloaded
Provisioner evidence reports `state=cleaned`, one cleanup attempt, no cleanup
error, and every exact-SID ACL entry removed.

[GitHub Actions run 31820442840](https://github.com/MelorTang/scopeguard/actions/runs/31820442840)
passed the complete Windows Server 2022 matrix from commit `c06671d`: 36
AppContainer checks, 36 LPAC checks, all 32 representative-runtime Capability
combinations plus three malformed-manifest rejections, the bundled Node runtime
pack's 17 integrity checks and eight Capability subsets, four crash-recovery
checks, and six Desktop Broker lifecycle checks. The runtime-pack and Capability
ledgers both finished `state=cleaned` after one cleanup attempt with no cleanup
error.

[GitHub Actions run 31817961995](https://github.com/MelorTang/scopeguard/actions/runs/31817961995)
passed 36 AppContainer checks, 36 LPAC checks, all 32 Capability combinations,
three malformed-manifest rejection checks, four crash-recovery checks, and all
six Desktop Broker lifecycle checks on Windows Server 2022 from commit
`7453f77`. The downloaded result bound each runtime path/version to its SHA-256;
the Capability ledger reported `state=cleaned`, one cleanup attempt, and no
cleanup error.

[GitHub Actions run 31814542432](https://github.com/MelorTang/scopeguard/actions/runs/31814542432)
passed 36 AppContainer checks, 36 LPAC checks, four crash-recovery checks,
and all six Desktop Broker lifecycle checks on Windows Server 2022 from commit
`a191064`.

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
- For LPAC, set `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` and resolve an explicit Capability manifest from a pinned runtime descriptor. The current representative minima are `registryRead` for CMD/Node/Python and `registryRead` plus `lpacInstrumentation` for PowerShell.
- Grant the package SID modify access to the workspace, read/execute access to managed runtime roots, and non-inheriting read/execute access to workspace ancestors.
- Grant no network capability by default.
- Pass only explicit stdin/stdout/stderr handles via `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
- Validate the AppContainer package SID and exact `TokenCapabilities` SID set before resume; require LPAC token validation on supported client builds.
- Assign the suspended process to a kill-on-close Job Object before resume. Apply active-process and UI limits.
- Build the process environment from an allowlist. Never inherit provider keys or unrelated parent variables.
- Fail closed on profile, DACL, capability, token, Job, handle-list, launch, timeout, or cleanup verification failure.

## Remaining gates

1. Run both modes and the differential `ALL APPLICATION PACKAGES` proof on Windows 10 x64, then fix the supported-build verification contract for systems where the direct token query is unavailable.
2. Bundle immutable ScopeGuard-owned runtimes, repeat the 8-subset matrix for
   their recorded versions/digests, signatures, installer ACLs, and pinned
   manifests. The copied-Node checkpoint still requires documented
   `registryRead` exposure and is not a production distribution artifact.
3. Move the passing Provisioner request/state contract behind an installed
   Windows service with an OS-authenticated Broker channel, protected
   registry/state roots, and signed identities. Wire the now-passing pre-profile
   intent/startup-recovery protocol into service startup before accepting
   requests. The in-memory HMAC fixture is not the production trust boundary.
4. Adapt the passing Broker lifecycle matrix to the eventual Desktop module
   interface. The native prototype proves parent-exit and concurrent-Run Job
   behavior, but product code remains disabled while Wayfinder decisions are
   open.

Until these gates pass, Request Approval and Auto Approve must reject arbitrary local execution rather than fall back to a normal process.
