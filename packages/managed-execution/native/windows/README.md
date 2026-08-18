# Windows LPAC Managed Execution native components

> Status: Historical Native Harness snapshot. The LPAC product-adapter and
> release-gate claims below apply only to the checkpointed enterprise route and
> are not current V1 requirements. See [ADR 0024](../../../../docs/adr/0024-adopt-a-personal-first-pi-rpc-workbench.md)
> and the current [verification gates](../../../../docs/VERIFICATION.md).

This directory preserves the source and hostile-input matrices that selected
the ScopeGuard-owned LPAC runner for [issue #14](https://github.com/MelorTang/scopeguard/issues/14).
The launcher, lifetime Broker, and installed Provisioner service are now called
by the product adapter in `packages/managed-execution`; the broader scripts
remain regression and release-gate evidence rather than application runtime code.

The native implementation uses stable Windows APIs for:

- AppContainer or LPAC process creation through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`;
- exact workspace and runtime DACL grants to a unique package SID;
- non-inheriting read/execute grants on workspace ancestors required by CMD and Node path resolution;
- no network capabilities;
- a nested Job Object with kill-on-close, active-process limits, and UI restrictions;
- an allowlisted process environment and explicit standard-handle list;
- a durable lifecycle ledger with exact Package SID ACL removal, profile
  deletion retries, and standalone crash recovery;
- fail-closed setup and launch behavior.

The matrix includes a differential `ALL APPLICATION PACKAGES` sentinel outside
the workspace. The sentinel grants read access to `S-1-15-2-1` but not to the
runner package SID. A regular AppContainer must read it, while LPAC mode must
be denied. This proves that the opt-out changes the effective access boundary;
it does not silently replace the direct LPAC token query.

The full LPAC regression profile declares `lpacAppExperience`, `registryRead`,
and `lpacInstrumentation`, but it is not the production default. The minimization
matrix currently selects only `registryRead` for CMD, Node, and Python, and
`registryRead` plus `lpacInstrumentation` for PowerShell. The full denial matrix
is rerun after every Capability change.

The newer `Experimental_CreateProcessInSandbox` API is not used because Microsoft currently documents it as experimental and Windows 11-only. ScopeGuard V1 must support both Windows 10 and Windows 11.

## Run

Use an expendable Windows machine or VM with PowerShell 7 and Visual Studio Build Tools:

```powershell
pwsh -File packages/managed-execution/native/windows/run.ps1
pwsh -File packages/managed-execution/native/windows/run.ps1 -Mode lpac
pwsh -File packages/managed-execution/native/windows/run.ps1 -Mode lpac -RequireLpacTokenVerification
```

The script creates a temporary AppContainer profile and records every ACL
mutation before applying it. Normal shutdown invokes the same recovery path as
crash recovery: remove only grant ACEs for the unique Package SID, verify their
absence, and then delete the AppContainer profile. A failed cleanup retains the
ledger and fixture for another recovery attempt.

Provisioning access to volume ancestors and managed runtimes commonly requires
an elevated token because those paths are not owned by a standard desktop
process. Production integration therefore needs a narrow elevated provisioner
or broker for profile and DACL lifecycle operations. Conversation and Agent
processes remain unprivileged AppContainer children and never receive that
token. The provisioner must verify every requested ACE after `icacls`; command
exit code alone is insufficient because `/C` can continue past denied paths.

Run the standalone crash-recovery matrix with:

```powershell
pwsh -File packages/managed-execution/native/windows/lifecycle-recovery-test.ps1
```

Run the Desktop parent/Broker lifecycle matrix with:

```powershell
pwsh -File packages/managed-execution/native/windows/desktop-broker-integration-test.ps1
```

Minimize the explicit Capability manifest for each representative Runtime with:

```powershell
pwsh -File packages/managed-execution/native/windows/runtime-capability-matrix.ps1
```

The launcher accepts only repeated `--capability` values from the prototype
allowlist. An LPAC launch with no values receives no declared Capability. Before
resume, the launcher requires the child token's `TokenCapabilities` SID set to
match the requested manifest exactly. The result also records each tested
runtime executable's path, file version, product version, and SHA-256 digest.

All 32 runtime/manifest combinations and the three invalid-manifest rejection
checks passed on Windows 11 build `26200.9168` and Windows Server 2022 build
`20348`. Both selected the same minimum manifests. `lpacAppExperience` was not
required by any representative runtime.

Validate the integrity and LPAC behavior of a copied, ScopeGuard-owned Node
runtime pack with:

```powershell
pwsh -File packages/managed-execution/native/windows/runtime-pack-integration-test.ps1
```

The prototype requires a caller-pinned manifest SHA-256, an exact schema and
file inventory, relative non-reparse paths, canonical Capability ordering, and
matching file sizes and SHA-256 digests before creating an AppContainer profile.
Named alternate streams and payloads with multiple hard links are rejected.
It then runs all eight Capability subsets from freshly verified descriptors.
The fixture copies the machine's Node executable into an isolated pack root; it
does not claim to be the final signed distribution artifact.

The runtime-pack fixture passed 17/17 descriptor and payload validation checks
and all eight exact-token Capability combinations on Windows 11 build
`26200.9168` and Windows Server 2022 build `20348`. Both selected
`registryRead` as the minimum runnable manifest and denied writes to the runtime
pack and outside the Workspace.

Production must obtain the expected manifest digest from signed application or
installer metadata and install payloads below an administrator-owned location
that the Desktop user cannot modify. Hash verification in a user-writable root
does not by itself close the validation-to-launch race.

Validate the narrow elevated Provisioner request and lifecycle contract with:

```powershell
pwsh -File packages/managed-execution/native/windows/provisioner-integration-test.ps1
```

The caller submits an authenticated envelope containing only registered
Workspace and Runtime IDs plus an execution identity. Raw paths, Package SIDs,
Capabilities, ACL strings, runtime roots, and manifest digests are not request
fields. The Provisioner requires an elevated administrator token, resolves its
own strict registry, re-verifies the pinned runtime pack, derives the profile
name and exact ACL plan, and makes identical prepare/cleanup requests
idempotent. Conflicting or post-cleanup replay fails closed.

The Windows 11 and Windows Server 2022 checkpoints passed 20/20 request,
registry, path, link, freshness, and tamper checks plus 7/7 real
Profile/ACL/LPAC lifecycle checks. The ephemeral in-memory HMAC key demonstrates
envelope integrity only. A production service still needs an OS-authenticated
Broker channel and key/bootstrap design, administrator-owned registry and state
roots, and a signed runtime package.

Validate crashes before and immediately after Profile creation with:

```powershell
pwsh -File packages/managed-execution/native/windows/provisioner-startup-recovery-test.ps1
```

Prepare writes a `profile-creation-planned` intent atomically before creating a
Profile, updates it with the created Profile identity, persists the lifecycle
ledger, and only then removes the intent. The installed service must run
`Invoke-ProvisionerStartupRecovery` against its administrator-owned state root
before accepting any request. Recovery derives Profile names from execution
IDs, rejects malformed or unexpected state without deleting it, writes a
tombstone for intent-only recovery, and leaves cleaned ledgers and tombstones
idempotent. The Windows 11 checkpoint passed all 9 hard-exit, recovery, replay,
and fail-closed checks across four windows: after intent, after unrecorded
Profile creation, after recording the Profile, and after ledger persistence.
Windows Server 2022 CI produced the same 9/9 result while retaining the original
20/20 request validation and 7/7 Profile/ACL lifecycle result.

Validate the installed SCM service and authenticated local transport with:

```powershell
pwsh -File packages/managed-execution/native/windows/provisioner-service-integration-test.ps1
```

The native ACL service runs as LocalSystem and completes service-ledger recovery
before it reports `SERVICE_RUNNING` or opens its local named pipe. Pipe access
is limited to LocalSystem and one registered Desktop user SID. Every connection
is also bound to an administrator-installed Broker image by canonical path and
SHA-256.
The service re-verifies pinned PowerShell, Worker, Provisioner, lifecycle,
runtime verifier, registry, and launcher files before each dispatch. It passes
only a bounded raw Provisioner payload to a LocalSystem Worker through a
service-owned request spool. The Broker owns its per-user AppContainer Profile;
the service independently derives the same Package SID from the execution ID and
only applies or removes exact ACLs. No command, arbitrary path, environment,
prompt, document, provider key, or MCP credential is accepted by this interface.

The integration fixture installs the service and runtime under a protected
`ProgramData` root, exercises Broker-owned Profile launch, service ACL
prepare/cleanup and restart recovery, rejects a copied client image and malformed
request, and proves pinned Worker tampering fails before dispatch. This remains
a prototype. The Windows Server 2022 fixture passed all 13 checks in
[GitHub Actions run 31864779339](https://github.com/MelorTang/scopeguard/actions/runs/31864779339).
The image pin does not stop another same-user process from launching the
legitimate installed client, so production still requires a Broker-only session
or handle bootstrap, signed service/Broker/runtime distribution, a real
installer and upgrade model, the Desktop Broker adapter, and Windows 10 x64
validation.

## Build the machine companion payload

Build the closed Windows x64 distribution input with:

```powershell
pnpm package:managed:win
```

The build compiles the Provisioner service/client, LPAC launcher, and lifetime
Broker, then packages the Provisioner scripts, Node runtime, and complete
PowerShell runtime used by the LocalSystem Worker. The generated manifest fixes
the machine-owned Program Files/ProgramData layout and binds every payload path,
size, and SHA-256 into one content digest. It deliberately excludes generated
service configuration, Workspace registrations, state, request spools,
diagnostics, and user Profile intents.

Verify a staged or freshly extracted package with:

```powershell
pwsh -File packages/managed-execution/native/windows/verify-managed-companion.ps1 `
  -PackageRoot packages/managed-execution/native/windows/release/ScopeGuard-ManagedExecution-0.5.0-dev-windows-x64

pwsh -File packages/managed-execution/native/windows/managed-companion-package-test.ps1 `
  -PackageRoot packages/managed-execution/native/windows/release/ScopeGuard-ManagedExecution-0.5.0-dev-windows-x64
```

The matrix accepts the valid package and rejects eight unsafe variants:
unsigned release verification, an extra file, payload tampering, schema drift,
duplicate JSON properties, an NTFS alternate data stream, an external hard
link, and a junction. Use `-RequireTrustedSignature` only for a release
candidate; the current native ScopeGuard binaries are intentionally unsigned
development artifacts.

[Windows Server 2022 run 31890924391](https://github.com/MelorTang/scopeguard/actions/runs/31890924391)
passed the complete 9/9 package matrix and a fresh archive extraction. Windows
11 25H2 x64 build `26200.9168` reproduced the same contract. This package is not
yet an installer and must not be copied into the per-user Desktop installation
root.

The Desktop Broker matrix starts two concurrent Conversation identities under a native Broker-held
outer Job. It cancels one launcher without disturbing the other, terminates the
Desktop parent probe, verifies the Broker detects parent exit and clears every
remaining managed process, then recovers both ACL/profile ledgers. The proposed
production seam and conditional capability threat decision are recorded in
[`BROKER-SPEC.md`](BROKER-SPEC.md).

The Broker matrix passed 6/6 on Windows 11 25H2 x64 build `26200.9168` and in
[Windows Server 2022 CI](https://github.com/MelorTang/scopeguard/actions/runs/31824339077).
Neither result substitutes for the remaining Windows 10 x64 release gate.

## Product adapter integration

`product-adapter-probe.mjs` runs the compiled
`WindowsLpacManagedExecutionAdapter` against the installed fixture service. It
verifies the real private-Broker lifecycle, streamed stdout, confirmed process
termination, Service ACL cleanup, and Broker Profile cleanup. The Provisioner
service integration matrix runs this probe before its service restart and
tamper checks.

Packaged Desktop builds require the exact installation metadata shown in
`broker-config.example.json`. Workspace paths are registered ahead of execution;
ordinary managed-execution requests contain only the registered Workspace ID,
Runtime ID, and execution identity at the elevated boundary.

Recover an interrupted execution from its ledger with:

```powershell
pwsh -File packages/managed-execution/native/windows/recover.ps1 `
  -LedgerPath C:\path\to\lifecycle-ledger.json
```

Use `-RequireLpacTokenVerification` for the mandatory Windows 10/11 client runs. Windows Server 2022 returned `ERROR_INVALID_PARAMETER` for that token information query even though the documented LPAC creation attribute and semantic boundary checks succeeded.
