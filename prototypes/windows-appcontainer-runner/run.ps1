[CmdletBinding()]
param(
    [ValidateSet("appcontainer", "lpac")]
    [string]$Mode = "appcontainer",
    [switch]$RequireLpacTokenVerification,
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This prototype must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "lifecycle.ps1")

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-$Mode-fixture"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$allPackagesArea = Join-Path $fixtureRoot "all-application-packages"
$resultPath = Join-Path $fixtureRoot "result.json"
$policyResultPath = Join-Path $fixtureRoot "policy-parity.json"
$lifecycleLedgerPath = Join-Path $fixtureRoot "lifecycle-ledger.json"
$cleanupResultPath = Join-Path $fixtureRoot "cleanup-result.json"
$launcherDiagnosticsPath = Join-Path $workspace "launcher-diagnostics.log"
$childOutputPath = "$launcherDiagnosticsPath.child-output.log"
$profileName = "ScopeGuardPrototype_$([guid]::NewGuid().ToString('N'))"
Write-Host "[$Mode] Building native launcher"
$launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()

function Invoke-IcaclsGrant {
    param(
        [string]$Path,
        [string]$Grant,
        [switch]$Recursive
    )

    $arguments = @($Path, "/grant", $Grant, "/C", "/Q")
    if ($Recursive) {
        $arguments += "/T"
    }
    & icacls.exe @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed for $Path with exit code $LASTEXITCODE."
    }
}

function Add-Check {
    param(
        [System.Collections.Generic.List[object]]$Checks,
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )

    $Checks.Add([ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Test-ProcessesGone {
    param([int[]]$ProcessIds)

    Start-Sleep -Milliseconds 750
    foreach ($processId in $ProcessIds) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            return $false
        }
    }
    return $true
}

function Invoke-SandboxCommand {
    param(
        [string[]]$CommandArguments,
        [int]$TimeoutSeconds = 60,
        [int]$KillLauncherAfterMilliseconds = 0
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $launcher
    $startInfo.WorkingDirectory = $workspace
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $false
    $startInfo.RedirectStandardError = $false
    $startInfo.CreateNoWindow = $true
    $launcherArguments = @(
        "run",
        "--name",
        $profileName,
        "--cwd",
        $workspace,
        "--timeout",
        $TimeoutSeconds.ToString(),
        "--diagnostics",
        $launcherDiagnosticsPath
    )
    if ($Mode -eq "lpac") {
        $launcherArguments += "--lpac"
    }
    $launcherArguments += "--"
    foreach ($argument in $launcherArguments + $CommandArguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $startInfo.Environment.Clear()
    foreach ($name in @(
        "ALLUSERSPROFILE",
        "ComSpec",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "Path",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "SystemDrive",
        "SystemRoot",
        "windir"
    )) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) {
            $startInfo.Environment[$name] = $value
        }
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start the AppContainer launcher."
    }
    if ($KillLauncherAfterMilliseconds -gt 0) {
        Start-Sleep -Milliseconds $KillLauncherAfterMilliseconds
        if (-not $process.HasExited) {
            $process.Kill($false)
        }
    }
    $outerTimeoutMilliseconds = ($TimeoutSeconds + 15) * 1000
    if (-not $process.WaitForExit($outerTimeoutMilliseconds)) {
        $process.Kill($true)
        $process.WaitForExit()
        return [ordered]@{
            exitCode = 125
            stdout = ""
            stderr = "launcher exceeded the independent PowerShell timeout"
        }
    }
    return [ordered]@{
        exitCode = $process.ExitCode
        stdout = ""
        stderr = "native output is emitted directly to the job log"
    }
}

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workspace, $outside, $allPackagesArea -Force | Out-Null
foreach ($probeFile in @(
    "boundary-probe.py",
    "cmd-probe.cmd",
    "linger-probe.py",
    "probe.ps1",
    "python-probe.py",
    "worker-probe.js"
)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $probeFile) -Destination $workspace
}
Set-Content -LiteralPath (Join-Path $workspace "input.txt") -Value "workspace-ok" -Encoding utf8

$outsideSecret = Join-Path $outside "outside-secret.txt"
$allPackagesSentinel = Join-Path $allPackagesArea "sentinel.txt"
$hardLinkTarget = Join-Path $outside "hardlink-target.txt"
$hardLinkPath = Join-Path $workspace "outside-hardlink.txt"
Set-Content -LiteralPath $outsideSecret -Value "scopeguard-outside-secret" -Encoding utf8
Set-Content -LiteralPath $outsideSecret -Stream "ScopeGuardSecret" -Value "outside-ads-secret" -Encoding utf8
Set-Content -LiteralPath $allPackagesSentinel -Value "scopeguard-all-application-packages-sentinel" -Encoding utf8
Invoke-IcaclsGrant -Path $allPackagesArea -Grant "*S-1-15-2-1:(RX)"
Invoke-IcaclsGrant -Path $allPackagesSentinel -Grant "*S-1-15-2-1:(R)"
Set-Content -LiteralPath $hardLinkTarget -Value "hardlink-original" -Encoding utf8 -NoNewline

$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$runtimeRoots = @(
    (Split-Path -Parent $pythonPath),
    (Split-Path -Parent $nodePath),
    (Split-Path -Parent $pwshPath)
) | Sort-Object -Unique
Write-Host "[$Mode] Creating AppContainer profile"
$profileSid = (& $launcher profile --name $profileName).Trim()
if ($LASTEXITCODE -ne 0 -or $profileSid -notmatch '^S-1-15-2-') {
    throw "Failed to create the AppContainer profile or resolve its package SID."
}
$profilePath = (& $launcher profile-path --name $profileName).Trim()
if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
    & $launcher delete --name $profileName
    throw "Failed to resolve the AppContainer profile path."
}
$lifecycleInitialized = $false
$cleanupPassed = $false

try {
    New-SandboxLifecycleLedger `
        -Path $lifecycleLedgerPath `
        -ProfileName $profileName `
        -PackageSid $profileSid `
        -ProfilePath $profilePath | Out-Null
    $lifecycleInitialized = $true
    Write-Host "[$Mode] Granting package SID access to workspace and managed runtimes"
    Grant-SandboxAcl `
        -LedgerPath $lifecycleLedgerPath `
        -Path $workspace `
        -Grant "(OI)(CI)(M)" `
        -Recursive
    $workspaceAncestor = [IO.Directory]::GetParent($workspace)
    while ($null -ne $workspaceAncestor) {
        Grant-SandboxAcl `
            -LedgerPath $lifecycleLedgerPath `
            -Path $workspaceAncestor.FullName `
            -Grant "(RX)"
        $workspaceAncestor = $workspaceAncestor.Parent
    }
    foreach ($runtimeRoot in $runtimeRoots) {
        Grant-SandboxAcl `
            -LedgerPath $lifecycleLedgerPath `
            -Path $runtimeRoot `
            -Grant "(OI)(CI)(RX)" `
            -Recursive
    }
    New-Item -ItemType Junction -Path (Join-Path $workspace "junction-outside") -Target $outside | Out-Null
    New-Item -ItemType HardLink -Path $hardLinkPath -Target $hardLinkTarget | Out-Null

    $registryPath = "HKCU:\Software\ScopeGuardPrototype"
    New-Item -Path $registryPath -Force | Out-Null
    Set-ItemProperty -Path $registryPath -Name "Secret" -Value "scopeguard-registry-secret"

    $credentialTarget = "ScopeGuardPrototype-$([guid]::NewGuid().ToString('N'))"
    & cmdkey.exe "/generic:$credentialTarget" "/user:scopeguard" "/pass:scopeguard-credential-secret" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the Credential Manager sentinel."
    }

    $protectedProcess = Start-Process -FilePath "pwsh.exe" -ArgumentList @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Sleep -Seconds 300"
    ) -PassThru -WindowStyle Hidden
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $loopbackPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $pipeName = "ScopeGuardPrototype-$([guid]::NewGuid().ToString('N'))"
    $pipeServer = [IO.Pipes.NamedPipeServerStream]::new(
        $pipeName,
        [IO.Pipes.PipeDirection]::InOut,
        1,
        [IO.Pipes.PipeTransmissionMode]::Byte,
        [IO.Pipes.PipeOptions]::Asynchronous
    )
    $outsideUnc = '\\localhost\{0}${1}\outside-secret.txt' -f $outside.Substring(0, 1), $outside.Substring(2)
    $env:SCOPEGUARD_SECRET_SENTINEL = "must-not-cross-process-boundary"
    $checks = [System.Collections.Generic.List[object]]::new()

    $policySpec = [ordered]@{
        runner = "scopeguard-appcontainer"
        mode = $Mode
        packageSid = $profileSid
        workspace = $workspace
        runtimeRoots = $runtimeRoots
        capabilities = if ($Mode -eq "lpac") {
            @("lpacAppExperience", "registryRead", "lpacInstrumentation")
        }
        else {
            @()
        }
        network = "deny"
        activeProcessLimit = 32
        killOnJobClose = $true
        environment = "allowlist"
    }
    $policyJson = $policySpec | ConvertTo-Json -Depth 6 -Compress
    $policyHash = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($policyJson))
    ).ToLowerInvariant()
    $policyParity = [ordered]@{
        requestApproval = [ordered]@{ reviewer = "user"; sandboxPolicyHash = $policyHash }
        autoApprove = [ordered]@{ reviewer = "system"; sandboxPolicyHash = $policyHash }
    }
    $policyParity | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $policyResultPath -Encoding utf8
    Add-Check -Checks $checks -Name "approval-policy-parity" -Passed (
        $policyParity.requestApproval.sandboxPolicyHash -eq $policyParity.autoApprove.sandboxPolicyHash
    ) -Detail $policyHash

    try {
        Write-Host "[$Mode] Launching boundary probe"
        $boundaryResult = Join-Path $workspace "boundary-result.json"
        $run = Invoke-SandboxCommand -CommandArguments @(
            $pythonPath,
            (Join-Path $workspace "boundary-probe.py"),
            $workspace,
            $outside,
            $outsideSecret,
            $hardLinkPath,
            $credentialTarget,
            $protectedProcess.Id.ToString(),
            $loopbackPort.ToString(),
            $outsideUnc,
            $pipeName,
            $Mode,
            $allPackagesSentinel,
            $boundaryResult
        ) -TimeoutSeconds 15
        Write-Host "[$Mode] Boundary probe launcher exited with $($run.exitCode)"
        $probe = if (Test-Path -LiteralPath $boundaryResult) {
            Get-Content -LiteralPath $boundaryResult -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        Add-Check -Checks $checks -Name "python-os-boundary" -Passed (
            $run.exitCode -eq 0 -and $null -ne $probe -and $probe.passed
        ) -Detail "exit=$($run.exitCode)"
        if ($null -ne $probe) {
            foreach ($probeResult in $probe.results) {
                Add-Check -Checks $checks -Name "boundary/$($probeResult.name)" -Passed $probeResult.passed -Detail $probeResult.detail
            }
        }

        $powershellAllowed = Join-Path $workspace "powershell-script-output.txt"
        $powershellDenied = Join-Path $outside "powershell-script-outside.txt"
        $powershellResultPath = Join-Path $workspace "powershell-result.json"
        $probeScript = (Join-Path $workspace "probe.ps1").Replace("'", "''")
        $allowedLiteral = $powershellAllowed.Replace("'", "''")
        $deniedLiteral = $powershellDenied.Replace("'", "''")
        $resultLiteral = $powershellResultPath.Replace("'", "''")
        $powershellCommand = "& '$probeScript' -AllowedPath '$allowedLiteral' -DeniedPath '$deniedLiteral' -ResultPath '$resultLiteral'"
        $powershellRun = Invoke-SandboxCommand -CommandArguments @(
            $pwshPath,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            $powershellCommand
        ) -TimeoutSeconds 20
        $powershellSummary = if (Test-Path -LiteralPath $powershellResultPath) {
            Get-Content -LiteralPath $powershellResultPath -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        Add-Check -Checks $checks -Name "powershell-script" -Passed (
            $powershellRun.exitCode -eq 0 -and
            $null -ne $powershellSummary -and
            $powershellSummary.passed -and
            (Test-Path -LiteralPath $powershellAllowed) -and
            -not (Test-Path -LiteralPath $powershellDenied)
        ) -Detail "exit=$($powershellRun.exitCode)"

        $requiredAclPaths = @(
            [pscustomobject]@{ path = $workspace; recursive = $true },
            [pscustomobject]@{
                path = [IO.Path]::GetPathRoot($workspace)
                recursive = $false
            }
        ) + @($runtimeRoots | ForEach-Object {
            [pscustomobject]@{ path = $_; recursive = $true }
        })
        $missingRequiredAcls = @($requiredAclPaths | Where-Object {
            Test-SandboxSidAceAbsent `
                -Path $_.path `
                -PackageSid $profileSid `
                -Recursive $_.recursive
        })
        $missingRequiredAclDetail = if ($missingRequiredAcls.Count -eq 0) {
            "all-present"
        }
        else {
            @($missingRequiredAcls | ForEach-Object path) |
                ConvertTo-Json -Compress
        }
        Add-Check -Checks $checks -Name "lifecycle-acls-present-before-runtime-probes" -Passed (
            $missingRequiredAcls.Count -eq 0
        ) -Detail $missingRequiredAclDetail

        $cmdAllowed = Join-Path $workspace "cmd-output.txt"
        $cmdDenied = Join-Path $outside "cmd-outside.txt"
        $cmdResultPath = Join-Path $workspace "cmd-result.txt"
        $cmdRun = Invoke-SandboxCommand -CommandArguments @(
            "cmd.exe",
            "/d",
            "/s",
            "/c",
            (Join-Path $workspace "cmd-probe.cmd"),
            $cmdAllowed,
            $cmdDenied,
            $cmdResultPath
        ) -TimeoutSeconds 15
        Add-Check -Checks $checks -Name "cmd-runtime" -Passed (
            $cmdRun.exitCode -eq 0 -and
            (Test-Path -LiteralPath $cmdAllowed) -and
            -not (Test-Path -LiteralPath $cmdDenied)
        ) -Detail "exit=$($cmdRun.exitCode); result=$(if (Test-Path -LiteralPath $cmdResultPath) { Get-Content -LiteralPath $cmdResultPath -Raw } else { 'missing' })"

        foreach ($kind in @("document-worker", "skill", "stdio-mcp")) {
            $workerResultPath = Join-Path $workspace "$kind-result.json"
            $workerRun = Invoke-SandboxCommand -CommandArguments @(
                $nodePath,
                (Join-Path $workspace "worker-probe.js"),
                $kind,
                $workspace,
                $outside,
                $workerResultPath
            ) -TimeoutSeconds 15
            $workerSummary = if (Test-Path -LiteralPath $workerResultPath) {
                Get-Content -LiteralPath $workerResultPath -Raw | ConvertFrom-Json
            }
            else {
                $null
            }
            Add-Check -Checks $checks -Name $kind -Passed (
                $workerRun.exitCode -eq 0 -and
                $null -ne $workerSummary -and
                $workerSummary.passed
            ) -Detail "exit=$($workerRun.exitCode); result=$($workerSummary | ConvertTo-Json -Compress)"
        }

        $pythonResultPath = Join-Path $workspace "python-result.json"
        $pythonRun = Invoke-SandboxCommand -CommandArguments @(
            $pythonPath,
            (Join-Path $workspace "python-probe.py"),
            $workspace,
            $outside,
            $pythonResultPath
        ) -TimeoutSeconds 15
        $pythonSummary = if (Test-Path -LiteralPath $pythonResultPath) {
            Get-Content -LiteralPath $pythonResultPath -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        Add-Check -Checks $checks -Name "python-runtime" -Passed (
            $pythonRun.exitCode -eq 0 -and
            $null -ne $pythonSummary -and
            $pythonSummary.passed
        ) -Detail "exit=$($pythonRun.exitCode)"

        $timeoutPidResult = Join-Path $workspace "timeout-pids.json"
        $timeoutRun = Invoke-SandboxCommand -CommandArguments @(
            $pythonPath,
            (Join-Path $workspace "linger-probe.py"),
            $timeoutPidResult
        ) -TimeoutSeconds 2
        $timeoutPids = if (Test-Path -LiteralPath $timeoutPidResult) {
            Get-Content -LiteralPath $timeoutPidResult -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        $timeoutTreeGone = $null -ne $timeoutPids -and (Test-ProcessesGone -ProcessIds @(
            [int]$timeoutPids.parentPid,
            [int]$timeoutPids.childPid
        ))
        Add-Check -Checks $checks -Name "timeout-clears-process-tree" -Passed (
            $timeoutRun.exitCode -eq 124 -and $timeoutTreeGone
        ) -Detail "exit=$($timeoutRun.exitCode); pids=$($timeoutPids | ConvertTo-Json -Compress)"

        $closePidResult = Join-Path $workspace "launcher-close-pids.json"
        $closeRun = Invoke-SandboxCommand -CommandArguments @(
            $pythonPath,
            (Join-Path $workspace "linger-probe.py"),
            $closePidResult
        ) -TimeoutSeconds 60 -KillLauncherAfterMilliseconds 2500
        $closePids = if (Test-Path -LiteralPath $closePidResult) {
            Get-Content -LiteralPath $closePidResult -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        $closeTreeGone = $null -ne $closePids -and (Test-ProcessesGone -ProcessIds @(
            [int]$closePids.parentPid,
            [int]$closePids.childPid
        ))
        Add-Check -Checks $checks -Name "launcher-exit-clears-process-tree" -Passed $closeTreeGone -Detail (
            "launcherExit=$($closeRun.exitCode); pids=$($closePids | ConvertTo-Json -Compress)"
        )

        Add-Check -Checks $checks -Name "protected-process-still-running" -Passed (-not $protectedProcess.HasExited) -Detail "pid=$($protectedProcess.Id)"
        Add-Check -Checks $checks -Name "hardlink-target-unchanged" -Passed (
            (Get-Content -LiteralPath $hardLinkTarget -Raw) -eq "hardlink-original"
        ) -Detail $hardLinkTarget

        $launcherDiagnostics = if (Test-Path -LiteralPath $launcherDiagnosticsPath) {
            Get-Content -LiteralPath $launcherDiagnosticsPath -Raw
        }
        else {
            ""
        }
        $lpacTokenVerified = $Mode -ne "lpac" -or $launcherDiagnostics -match "lpac-token-verified"
        $lpacAllApplicationPackagesProof = $Mode -eq "lpac" -and
            $null -ne $probe -and
            @($probe.results | Where-Object {
                $_.name -eq "lpac-ignores-all-application-packages" -and $_.passed
            }).Count -eq 1
        if ($RequireLpacTokenVerification -and $Mode -eq "lpac") {
            $lpacTokenDetail = if ($lpacTokenVerified) {
                "TokenIsLessPrivilegedAppContainer=true"
            }
            else {
                "query unavailable or false"
            }
            Add-Check -Checks $checks -Name "lpac-token-verification" -Passed $lpacTokenVerified -Detail $lpacTokenDetail
        }
        $failedChecks = @($checks | Where-Object { -not $_.passed })
        $matrixPassed = $failedChecks.Count -eq 0
        $summary = [ordered]@{
            passed = $matrixPassed
            productionReady = $false
            lpacTokenVerified = $lpacTokenVerified
            lpacAllApplicationPackagesProof = $lpacAllApplicationPackagesProof
            supportedClientMatrixValidated = $false
            runner = "$Mode-job"
            packageSid = $profileSid
            capabilities = $policySpec.capabilities
            policyHash = $policyHash
            windows = [Environment]::OSVersion.VersionString
            boundaryExitCode = $run.exitCode
            launcherDiagnostics = $launcherDiagnostics
            childOutput = if (Test-Path -LiteralPath $childOutputPath) {
                Get-Content -LiteralPath $childOutputPath -Raw
            }
            else {
                ""
            }
            checks = $checks
        }
        $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
        $summary | ConvertTo-Json -Depth 8
        if (-not $summary.passed) {
            throw "$($failedChecks.Count) AppContainer checks failed. See $resultPath."
        }
    }
    finally {
        Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue
        $listener.Stop()
        $pipeServer.Dispose()
        if (-not $protectedProcess.HasExited) {
            Stop-Process -Id $protectedProcess.Id -Force
        }
        & cmdkey.exe "/delete:$credentialTarget" | Out-Null
        Remove-Item -Path $registryPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}
finally {
    try {
        if ($lifecycleInitialized) {
            $cleanupResult = Invoke-SandboxLifecycleRecovery `
                -LedgerPath $lifecycleLedgerPath `
                -Launcher $launcher
        }
        else {
            & $launcher delete --name $profileName
            $cleanupResult = [ordered]@{
                passed = $LASTEXITCODE -eq 0
                state = if ($LASTEXITCODE -eq 0) { "cleaned" } else { "cleanup-failed" }
                errors = @()
            }
        }
        $cleanupResult | ConvertTo-Json -Depth 12 |
            Set-Content -LiteralPath $cleanupResultPath -Encoding utf8
        $cleanupPassed = $cleanupResult.passed
        if (-not $cleanupPassed) {
            throw "Sandbox lifecycle cleanup failed. See $cleanupResultPath."
        }
    }
    finally {
        if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
            Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
        }
    }
}
