# Result: reject direct Codex runner reuse

## Decision

Do not use the Codex `0.147.0` Windows sandbox binary or crate as ScopeGuard's production managed-execution boundary.

The underlying runner can enforce explicit filesystem grants when called through its internal wrapper protocol, but the complete ScopeGuard acceptance matrix does not pass. The public `codex sandbox --permission-profile` command is also not a reliable integration surface because its Windows path does not forward resolved deny-read paths in this version.

## Evidence

- [Run 31722407545](https://github.com/MelorTang/scopeguard/actions/runs/31722407545): elevated setup succeeded; first probe exposed AppData runtime-path and PowerShell harness assumptions.
- [Run 31722744983](https://github.com/MelorTang/scopeguard/actions/runs/31722744983): public profile CLI allowed explicit deny-path reads and a hard-link write because deny-read overrides were not forwarded.
- [Run 31723265268](https://github.com/MelorTang/scopeguard/actions/runs/31723265268): direct internal wrapper with explicit read, write, and deny overrides passed 21 of 25 checks. The four failed checks reduce to two independent boundary failures:
  - the sandboxed process terminated a process owned by the parent user;
  - the sandboxed process connected to an arbitrary loopback TCP listener.

The final run did enforce workspace-only file access, external network denial, registry and Credential Manager isolation, environment allowlisting, child-process containment, junction/device/traversal/hard-link defenses, and representative PowerShell, CMD, Python, Node document-worker, executable Skill, and stdio-MCP payloads.

## Consequence

The next candidate is a ScopeGuard-owned LPAC launcher using:

- an AppContainer package SID with no ambient network capabilities;
- explicit workspace and runtime capability/DACL grants;
- `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` for LPAC;
- a Job Object with kill-on-close and process limits;
- an allowlisted environment and inherited-handle allowlist;
- the same escape matrix on Windows Server CI, followed by Windows 10 and Windows 11 client validation.

The Codex source remains useful as a reference for setup lifecycle, helper materialization, logging, cancellation, and test cases. Its hidden wrapper protocol is not a stable dependency contract.
