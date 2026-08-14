# Windows AppContainer runner prototype

This throwaway prototype is the second candidate for [issue #14](https://github.com/MelorTang/scopeguard/issues/14). It tests a ScopeGuard-owned runner built from stable Windows APIs:

- AppContainer or LPAC process creation through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`;
- exact workspace and runtime DACL grants to a unique package SID;
- non-inheriting read/execute grants on workspace ancestors required by CMD and Node path resolution;
- no network capabilities;
- a nested Job Object with kill-on-close, active-process limits, and UI restrictions;
- an allowlisted process environment and explicit standard-handle list;
- fail-closed setup and launch behavior.

The matrix includes a differential `ALL APPLICATION PACKAGES` sentinel outside
the workspace. The sentinel grants read access to `S-1-15-2-1` but not to the
runner package SID. A regular AppContainer must read it, while LPAC mode must
be denied. This proves that the opt-out changes the effective access boundary;
it does not silently replace the direct LPAC token query.

The LPAC mode grants only `lpacAppExperience`, `registryRead`, and `lpacInstrumentation`. They are required by Python and PowerShell startup on the tested Windows Server image; the full denial matrix is rerun after every capability change.

The newer `Experimental_CreateProcessInSandbox` API is not used because Microsoft currently documents it as experimental and Windows 11-only. ScopeGuard V1 must support both Windows 10 and Windows 11.

## Run

Use an expendable Windows machine or VM with PowerShell 7 and Visual Studio Build Tools:

```powershell
pwsh -File prototypes/windows-appcontainer-runner/run.ps1
pwsh -File prototypes/windows-appcontainer-runner/run.ps1 -Mode lpac
pwsh -File prototypes/windows-appcontainer-runner/run.ps1 -Mode lpac -RequireLpacTokenVerification
```

The script creates a temporary AppContainer profile and adds temporary ACL entries for that profile SID. The GitHub Actions workflow runs on an ephemeral Windows host.

Use `-RequireLpacTokenVerification` for the mandatory Windows 10/11 client runs. Windows Server 2022 returned `ERROR_INVALID_PARAMETER` for that token information query even though the documented LPAC creation attribute and semantic boundary checks succeeded.
