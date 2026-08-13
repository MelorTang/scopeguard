# Windows managed execution sandbox prototype

This throwaway prototype answers one question for [issue #14](https://github.com/MelorTang/scopeguard/issues/14): can ScopeGuard reuse the pinned Codex Windows sandbox as the operating-system boundary for managed local execution?

It deliberately does not integrate the sandbox into the desktop application. It downloads the three signed release artifacts for Codex `0.147.0`, verifies their published SHA-256 digests, provisions the elevated sandbox, and runs ScopeGuard-owned probes.

## Run

Use an expendable Windows machine or VM with PowerShell 7 and an elevated terminal:

```powershell
pwsh -File prototypes/windows-sandbox-runner/run.ps1
```

Provisioning creates the local `CodexSandboxOffline` and `CodexSandboxOnline` users and installs persistent firewall/WFP state. The GitHub Actions workflow uses an ephemeral Windows runner for this reason.

## What is checked

- Workspace reads and writes succeed.
- Reads and writes outside the workspace fail, including traversal, junction, hard-link, and device-path attempts.
- Parent-user registry data and Credential Manager entries are not visible.
- A sandboxed process cannot terminate a process owned by the parent user.
- Direct loopback network access is blocked.
- Child processes remain inside the same boundary.
- A Win32 boundary probe is kept separate from PowerShell script compatibility so a Harness limitation cannot hide an isolation failure.
- PowerShell, CMD, Python, and Node-based document-worker, Skill, and stdio-MCP stand-ins run with the same permission profile.
- The parent environment is allowlisted before launching Codex, so a sentinel secret is not inherited.

The prototype is a feasibility gate, not a production dependency decision. Windows 10 and Windows 11 client validation, cancellation/job cleanup, enterprise policy behavior, installer lifecycle, and desktop integration remain required before adopting the runner.
