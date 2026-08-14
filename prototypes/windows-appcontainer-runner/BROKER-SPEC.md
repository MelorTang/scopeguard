# Managed Execution Broker prototype specification

## Status

This specification records the production seam demonstrated by the issue #14
LPAC prototype. It does not enable managed execution in the Desktop product.
Windows 10 x64 validation and a production implementation remain release gates.

## Trust split

The production design uses two modules rather than one elevated Agent host.

1. The unprivileged **Execution Broker** compiles an immutable Run policy,
   launches verified LPAC processes, owns their Job Objects, streams bounded
   output, cancels executions, and confirms process-tree termination.
2. The narrow elevated **Sandbox Provisioner** creates and deletes AppContainer
   profiles and applies or removes verified ACL entries through a durable
   lifecycle ledger. It never executes Agent commands and never receives
   prompts, document contents, provider keys, MCP credentials, or arbitrary
   environment variables.

The Desktop renderer, Agent Runtime, Skills, document workers, and local stdio
MCP processes never receive the provisioner's token. The renderer cannot submit
raw ACL operations, runtime roots, capabilities, package names, or policy hashes.

## Process topology

```text
Desktop main (current user)
  | starts and is monitored by
  +-- Execution Broker (current user; owns outer kill-on-close Job)
        +-- Agent Host
              +-- LPAC launcher A (Conversation Run A)
              |     +-- inner kill-on-close Job A
              |           +-- command and descendants
              +-- LPAC launcher B (Conversation Run B)
                    +-- inner kill-on-close Job B
                          +-- command and descendants

Sandbox Provisioner (narrow elevated process)
  +-- profile and exact-SID ACL lifecycle only
```

The Broker opens a synchronization handle to Desktop main. Parent exit is an OS
signal, not an IPC promise: the Broker terminates the outer Job and exits. Each
launcher then closes its inner Job, so a Desktop crash clears all managed trees.
Cancelling one Run terminates only that launcher's inner Job.

## External interface

Keep the module interface small. Product callers need only:

```ts
interface ManagedExecutionBroker {
  execute(request: ManagedExecutionRequest, signal: AbortSignal): ManagedExecution;
  recover(): Promise<RecoveryReport>;
  shutdown(): Promise<ShutdownReport>;
}
```

`ManagedExecution` exposes output events and one final result. The Broker hides
profile creation, capability SID derivation, DACL mutation, process attributes,
Job handles, recovery retries, and platform diagnostics.

`ManagedExecutionRequest` is immutable after acceptance and contains:

- a unique execution ID, Conversation ID, Run ID, and canonical Workspace ID;
- a Workspace-relative working directory;
- an argv array and a registered runtime descriptor ID, never a shell string
  plus caller-selected executable/runtime roots;
- explicitly permitted non-secret environment values and standard streams;
- timeout and output limits;
- a Conversation Execution Profile and requested typed effects.

The Broker resolves canonical paths and registered runtime descriptors itself,
compiles the policy, persists its manifest before provisioning, and returns the
compiled policy hash. Request Approval and Auto Approve must compile to the same
sandbox manifest; reviewer metadata is not an input to policy compilation. Full
Access bypasses this module through an explicit current-user executor.

## Lifecycle and result contract

The durable state machine is:

```text
accepted -> provisioning -> prepared -> launching -> running
         -> stopping -> process-tree-cleared -> cleaning -> cleaned
```

Every ACL mutation is recorded before application. Cleanup removes only ACEs
for the recorded Package SID, verifies absence, then deletes and verifies the
profile. Startup calls `recover()` before accepting new bounded executions.

A final result includes exit status, timeout/cancellation reason, policy hash,
output-spill reference, process-tree termination confirmation, cleanup status,
and effect status. If the Broker loses contact after a command may have started,
the result is `effect_unknown`; approval, retry, or a missing response must not
be presented as proof that no effect occurred. Keyless automatic replay is not
allowed for effectful requests.

Any profile, ACL, capability, token, Job, handle-list, launch, parent-monitor,
termination, output, or cleanup verification failure is fail-closed. It never
falls back to a normal current-user process.

## Provisioner request constraints

The privileged interface accepts a Broker-authenticated execution manifest, not
general-purpose commands. It must enforce all of these constraints itself:

- Package profile names are generated from the execution ID.
- Workspace paths must match a Desktop-authorized canonical Workspace root.
- Runtime roots come from an installed, versioned runtime descriptor registry.
- Workspace grants are exact Package SID grants; runtime/ancestor grants cannot
  be widened by the request.
- Reparse points, UNC paths, device paths, alternate data streams, and missing
  canonical ancestors are rejected before any mutation.
- Every `icacls` result is verified from the resulting DACL. Exit code zero is
  insufficient.
- The ledger and recovery directory are writable only by the Desktop user,
  provisioner identity, and administrators.

Production should bundle managed runtimes under a fixed ScopeGuard-owned root
and provision its traversal/read-execute ACL at install time. Recursively
granting a new Package SID across arbitrary system Python, Node, or PowerShell
installations for every Run is prototype behavior, not the production design.

The Broker resolves a runtime descriptor ID through installer-owned metadata;
the caller never supplies a runtime root, executable path, Capability list, or
manifest digest. Before provisioning and again immediately before launch, the
resolver must verify:

- the expected manifest digest from signed application/installer metadata;
- an exact versioned schema with no duplicate or unknown properties;
- a relative executable path and complete case-insensitive payload inventory;
- no traversal, absolute/device path, alternate stream, reparse point, or
  multiply linked payload;
- every payload size and SHA-256 digest;
- the descriptor's canonical allowlisted Capability manifest.

The runtime root must be installed under an administrator-owned, versioned
location that is not writable by the Desktop user or LPAC identity. Validation
inside a user-writable directory is not an atomic defense against replacement
between hashing and process creation. The manifest digest is a trust binding,
not a substitute for installer ACLs, package signing, or launch-time identity
verification.

## Capability and metadata threat decision

LPAC remains preferred because it disregards ambient `ALL APPLICATION
PACKAGES` access. No network capability is granted in the V1 bounded profile.

The full regression profile uses three compatibility capabilities. The 8-way
subset matrix on Windows 11 build `26200.9168` and Windows Server 2022 build
`20348` selected smaller manifests, so the superset is not a production default:

| Exposure | Decision |
| --- | --- |
| `registryRead` | Conditional acceptance. Microsoft documents it as read access to HKLM registry hives. The tested system CMD, Node, Python, and PowerShell executables all required it, so machine software/configuration metadata is explicitly exposed. A bundled runtime must still retry the no-capability profile before requesting it. HKCU credentials remain outside the profile. |
| `lpacAppExperience` | Excluded from every currently selected runtime manifest. Public semantics are not precise enough to infer safety from the name. Reintroduce it only for a pinned runtime that fails without it and passes the complete denial matrix on every supported build. |
| `lpacInstrumentation` | Conditional acceptance for the pinned PowerShell worker only. CMD, Node, and Python omit it. PowerShell receives the same exact-token and per-build denial-matrix gate. |
| Workspace ancestors | Accept non-inheriting read/execute on canonical ancestors because CMD and Node require path resolution. Ancestor names and directory metadata may be visible; descendant content outside the Workspace must remain denied. |
| Managed runtime roots | Accept read/execute only under the ScopeGuard-owned, versioned runtime root. Runtime files are immutable to the LPAC identity. |

[Microsoft's AppContainer documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
states that LPAC requires explicit capabilities for resources regular
AppContainers can access. The newer sandbox API documentation describes
[`registryRead` as HKLM read access](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox).
All 32 runtime/manifest combinations verified that the suspended child token's
Capability SID set exactly matched the requested manifest. The empirical matrix
therefore complements the documented capability model; it does not replace an
undocumented capability with a broad trust assumption. Its result binds the
selection evidence to each executable's file version and SHA-256 digest.

## Verification obligations

Before enabling Request Approval or Auto Approve arbitrary local execution:

1. Pass the full boundary and LPAC differential matrix on supported Windows 10
   and Windows 11 x64 builds.
2. Repeat minimization against the actual bundled runtime descriptors, pin each
   executable digest and selected manifest, then rerun the full denial matrix
   for every supported build.
3. Install signed runtime packs and their pinned manifests below an
   administrator-owned location that the Desktop user cannot modify, then prove
   descriptor verification and launch cannot be raced through replacement,
   hard links, reparse points, or alternate data streams.
4. Prove two concurrent Runs have unique Package SIDs and cannot read or write
   each other's Workspace.
5. Prove cancelling Run A leaves Run B alive.
6. Prove Desktop parent exit clears the Broker, Agent Host, every launcher, and
   every managed descendant.
7. Recover both ledgers and prove no stale exact-SID ACE or profile remains.
8. Exercise the same module interface from Desktop integration tests; do not
   substitute mocks for Job and profile lifecycle assertions.
