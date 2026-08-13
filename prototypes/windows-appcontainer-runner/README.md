# Windows AppContainer runner prototype

This throwaway prototype is the second candidate for [issue #14](https://github.com/MelorTang/scopeguard/issues/14). It tests a ScopeGuard-owned runner built from stable Windows APIs:

- AppContainer or LPAC process creation through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`;
- exact workspace and runtime DACL grants to a unique package SID;
- no network capabilities;
- a nested Job Object with kill-on-close, active-process limits, and UI restrictions;
- an allowlisted process environment;
- fail-closed setup and launch behavior.

The newer `Experimental_CreateProcessInSandbox` API is not used because Microsoft currently documents it as experimental and Windows 11-only. ScopeGuard V1 must support both Windows 10 and Windows 11.

## Run

Use an expendable Windows machine or VM with PowerShell 7 and Visual Studio Build Tools:

```powershell
pwsh -File prototypes/windows-appcontainer-runner/run.ps1
```

The script creates a temporary AppContainer profile and adds temporary ACL entries for that profile SID. The GitHub Actions workflow runs on an ephemeral Windows host.
