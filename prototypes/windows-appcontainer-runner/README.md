# Windows AppContainer runner prototype

This throwaway prototype is the second candidate for [issue #14](https://github.com/MelorTang/scopeguard/issues/14). It tests a ScopeGuard-owned runner built from stable Windows APIs:

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
pwsh -File prototypes/windows-appcontainer-runner/run.ps1
pwsh -File prototypes/windows-appcontainer-runner/run.ps1 -Mode lpac
pwsh -File prototypes/windows-appcontainer-runner/run.ps1 -Mode lpac -RequireLpacTokenVerification
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
pwsh -File prototypes/windows-appcontainer-runner/lifecycle-recovery-test.ps1
```

Run the Desktop parent/Broker lifecycle matrix with:

```powershell
pwsh -File prototypes/windows-appcontainer-runner/desktop-broker-integration-test.ps1
```

Minimize the explicit Capability manifest for each representative Runtime with:

```powershell
pwsh -File prototypes/windows-appcontainer-runner/runtime-capability-matrix.ps1
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
pwsh -File prototypes/windows-appcontainer-runner/runtime-pack-integration-test.ps1
```

The prototype requires a caller-pinned manifest SHA-256, an exact schema and
file inventory, relative non-reparse paths, canonical Capability ordering, and
matching file sizes and SHA-256 digests before creating an AppContainer profile.
Named alternate streams and payloads with multiple hard links are rejected.
It then runs all eight Capability subsets from freshly verified descriptors.
The fixture copies the machine's Node executable into an isolated pack root; it
does not claim to be the final signed distribution artifact.

Production must obtain the expected manifest digest from signed application or
installer metadata and install payloads below an administrator-owned location
that the Desktop user cannot modify. Hash verification in a user-writable root
does not by itself close the validation-to-launch race.

The Desktop Broker matrix starts two concurrent Conversation identities under a native Broker-held
outer Job. It cancels one launcher without disturbing the other, terminates the
Desktop parent probe, verifies the Broker detects parent exit and clears every
remaining managed process, then recovers both ACL/profile ledgers. The proposed
production seam and conditional capability threat decision are recorded in
[`BROKER-SPEC.md`](BROKER-SPEC.md).

The Broker matrix passed 6/6 on Windows 11 25H2 x64 build `26200.9168` and in
[Windows Server 2022 CI](https://github.com/MelorTang/scopeguard/actions/runs/31817961995).
Neither result substitutes for the remaining Windows 10 x64 release gate.

Recover an interrupted execution from its ledger with:

```powershell
pwsh -File prototypes/windows-appcontainer-runner/recover.ps1 `
  -LedgerPath C:\path\to\lifecycle-ledger.json
```

Use `-RequireLpacTokenVerification` for the mandatory Windows 10/11 client runs. Windows Server 2022 returned `ERROR_INVALID_PARAMETER` for that token information query even though the documented LPAC creation attribute and semantic boundary checks succeeded.
