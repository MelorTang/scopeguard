# Managed Execution Desktop Slice

## Status

The V1 Desktop slice supports three immutable Conversation execution profiles:

| Profile | Approval | Command authority |
| --- | --- | --- |
| Request Approval | Every mutating tool call requires the user | Windows LPAC sandbox |
| Auto Approve | ScopeGuard approves allowed tool calls | The same Windows LPAC sandbox |
| Full Access | No per-call approval | Current desktop user, without sandboxing |

Request Approval and Auto Approve route through one bounded adapter. If the
Windows service, installation manifest, registered Workspace, runtime pack,
Profile intent recovery, ACL lifecycle, launcher policy, Job cleanup, or final
Profile deletion cannot be verified, the command fails closed. It never falls
back to Full Access.

Local CLI Agents remain explicit Full Access integrations outside this managed
native-Agent command path. The user-opened Workspace terminal is also outside
the Agent execution boundary.

## Process Boundary

```text
Renderer (sandboxed, no Node)
  -> fixed Preload API
  -> Electron Main
       -> private utilityProcess channel
       -> Agent Host
            -> typed managed-execution request
            -> Electron Main Desktop Execution Broker
                 -> pinned Provisioner service client
                 -> LocalSystem ACL Provisioner service
                 -> per-execution lifetime Broker outer Job
                 -> LPAC launcher inner Job
                 -> bundled Node -> CMD command worker
```

The managed-execution request/event/response/cancel messages exist only on the
Electron Main to Agent Host utility-process channel. They are not Preload or
Renderer IPC methods. The Provisioner accepts registered Workspace and Runtime
IDs, not command text, prompts, documents, Provider keys, arbitrary paths,
Capabilities, Package SIDs, or ACL strings.

The threat claim is intentionally narrow: the Renderer and LPAC Agent cannot
directly invoke the Broker/Provisioner channel. ScopeGuard does not claim to
defend this local current-user service from arbitrary unrelated malware already
running as the same desktop user.

## Lifecycle

1. Persist a current-user Profile intent before Profile creation.
2. Create the execution-derived AppContainer Profile.
3. Send a bounded prepare request to the installed service.
4. Require exact execution, Workspace, Runtime, Profile, Package SID, and
   `registryRead` Capability evidence.
5. Launch through the parent-monitoring lifetime Broker and LPAC launcher.
6. Stream stdout/stderr over private typed IPC.
7. On exit, timeout, cancellation, or shutdown, request ACL cleanup and delete
   the Broker-owned Profile independently.
8. Remove the Profile intent only after deletion is confirmed.

Service startup recovers protected ACL ledgers. Desktop Broker startup scans
only strict Profile intent filenames, deletes derived Profiles, and fails closed
on malformed or unknown state. A lost prepare response still triggers cleanup.
Unconfirmed termination or cleanup returns `effect=unknown`; it is never shown
as a successful zero-effect result.

## Installation Contract

Packaged Windows builds read
`resources/managed-execution/windows/broker-config.json`. The exact manifest
schema is represented by
`packages/managed-execution/native/windows/broker-config.example.json`.
Binaries must be regular files beneath the protected installation root. The
service independently pins the client, worker, registry, runtime verifier, and
launcher identities.

Workspace registration is installer/administrator managed in this slice.
Unregistered local folders can still be opened and used for ordinary UI and
Full Access work, but bounded `run_command` fails closed until registration is
present in both the service registry and Broker manifest.

## Remaining Release Gates

- Signed ScopeGuard service, Broker, launcher, and immutable Node runtime pack.
- Installer-owned roots plus upgrade, rollback, repair, and uninstall recovery.
- A clean packaged Windows 11 Desktop end-to-end run after signing.
- Windows 10 x64 compatibility matrix.
- Productized dynamic Workspace registration without broadening execution requests.

These are release gates. They do not permit an unsandboxed fallback in either
bounded profile.
