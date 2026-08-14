[CmdletBinding()]
param(
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This Capability matrix must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "lifecycle.ps1")

function Invoke-LpacRuntime {
    param(
        [string]$Launcher,
        [string]$ProfileName,
        [string]$Workspace,
        [string]$DiagnosticsPath,
        [string[]]$Capabilities,
        [string[]]$CommandArguments,
        [int]$TimeoutSeconds = 20
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Launcher
    $startInfo.WorkingDirectory = $Workspace
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $arguments = @(
        "run",
        "--name", $ProfileName,
        "--cwd", $Workspace,
        "--timeout", $TimeoutSeconds.ToString(),
        "--lpac",
        "--diagnostics", $DiagnosticsPath
    )
    foreach ($capability in $Capabilities) {
        $arguments += @("--capability", $capability)
    }
    $arguments += "--"
    foreach ($argument in $arguments + $CommandArguments) {
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
        throw "Failed to start LPAC runtime probe."
    }
    if (-not $process.WaitForExit(($TimeoutSeconds + 10) * 1000)) {
        $process.Kill($true)
        $process.WaitForExit()
        return 125
    }
    return $process.ExitCode
}

function Read-JsonIfPresent {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Test-TokenManifestDiagnostic {
    param(
        [string]$Path,
        [string[]]$Capabilities
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $expected = if ($Capabilities.Count -eq 0) {
        "none"
    }
    else {
        $Capabilities -join ","
    }
    return (Get-Content -LiteralPath $Path -Raw) -match (
        [regex]::Escape("token-capabilities-verified=$expected")
    )
}

function Test-LauncherRejectsArguments {
    param(
        [string]$Launcher,
        [string[]]$Arguments,
        [string]$ExpectedError
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Launcher
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start launcher argument validation."
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject][ordered]@{
        passed = $process.ExitCode -ne 0 -and $stderr -match [regex]::Escape($ExpectedError)
        exitCode = $process.ExitCode
        stdout = $stdout
        stderr = $stderr
    }
}

function Invoke-RuntimeProbe {
    param(
        [string]$Runtime,
        [string]$ManifestName,
        [string[]]$Capabilities,
        [string]$Launcher,
        [string]$ProfileName,
        [string]$Workspace,
        [string]$Outside,
        [string]$DiagnosticsRoot,
        [string]$CmdPath,
        [string]$NodePath,
        [string]$PythonPath,
        [string]$PwshPath
    )

    $diagnosticsPath = Join-Path $DiagnosticsRoot "$Runtime-$ManifestName.log"
    $safeName = "$Runtime-$ManifestName"
    $resultPath = Join-Path $Workspace "$safeName-result.json"
    $allowedPath = Join-Path $Workspace "$safeName-output.txt"
    $deniedPath = Join-Path $Outside "$safeName-outside.txt"
    if ($Runtime -eq "cmd") {
        $resultPath = Join-Path $Workspace "$safeName-result.txt"
    }
    elseif ($Runtime -eq "python") {
        $allowedPath = Join-Path $Workspace "python-runtime-output.txt"
        $deniedPath = Join-Path $Outside "python-runtime-outside.txt"
    }
    foreach ($path in @($resultPath, $allowedPath, $deniedPath)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    $command = switch ($Runtime) {
        "cmd" {
            @(
                $CmdPath,
                "/d",
                "/s",
                "/c",
                (Join-Path $Workspace "cmd-probe.cmd"),
                $allowedPath,
                $deniedPath,
                $resultPath
            )
        }
        "node" {
            @(
                $NodePath,
                (Join-Path $Workspace "worker-probe.js"),
                $safeName,
                $Workspace,
                $Outside,
                $resultPath
            )
        }
        "python" {
            @(
                $PythonPath,
                (Join-Path $Workspace "python-probe.py"),
                $Workspace,
                $Outside,
                $resultPath
            )
        }
        "powershell" {
            $script = (Join-Path $Workspace "probe.ps1").Replace("'", "''")
            $allowed = $allowedPath.Replace("'", "''")
            $denied = $deniedPath.Replace("'", "''")
            $result = $resultPath.Replace("'", "''")
            @(
                $PwshPath,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& '$script' -AllowedPath '$allowed' -DeniedPath '$denied' -ResultPath '$result'"
            )
        }
        default {
            throw "Unknown runtime: $Runtime"
        }
    }

    $exitCode = Invoke-LpacRuntime `
        -Launcher $Launcher `
        -ProfileName $ProfileName `
        -Workspace $Workspace `
        -DiagnosticsPath $diagnosticsPath `
        -Capabilities $Capabilities `
        -CommandArguments $command
    $tokenVerified = Test-TokenManifestDiagnostic `
        -Path $diagnosticsPath `
        -Capabilities $Capabilities
    $probeResult = if ($Runtime -eq "cmd") {
        $text = if (Test-Path -LiteralPath $resultPath) {
            Get-Content -LiteralPath $resultPath -Raw
        }
        else {
            ""
        }
        [pscustomobject]@{
            passed = $text -match "passed"
            detail = $text.Trim()
        }
    }
    else {
        Read-JsonIfPresent -Path $resultPath
    }
    $passed = $exitCode -eq 0 -and
        $tokenVerified -and
        $null -ne $probeResult -and
        $probeResult.passed -and
        -not (Test-Path -LiteralPath $deniedPath)

    return [pscustomobject][ordered]@{
        runtime = $Runtime
        manifest = $ManifestName
        capabilities = @($Capabilities)
        capabilityCount = $Capabilities.Count
        exitCode = $exitCode
        tokenManifestVerified = $tokenVerified
        passed = $passed
        probe = $probeResult
        diagnosticsPath = $diagnosticsPath
    }
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-runtime-capability-fixture"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$diagnosticsRoot = Join-Path $fixtureRoot "diagnostics"
$resultPath = Join-Path $fixtureRoot "result.json"
$ledgerPath = Join-Path $fixtureRoot "lifecycle-ledger.json"
$cleanupResultPath = Join-Path $fixtureRoot "cleanup-result.json"
$profileName = "ScopeGuardCapabilities_$([guid]::NewGuid().ToString('N'))"
$launcher = $null
$cleanupPassed = $false

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workspace, $outside, $diagnosticsRoot -Force | Out-Null
foreach ($probeFile in @(
    "cmd-probe.cmd",
    "probe.ps1",
    "python-probe.py",
    "worker-probe.js"
)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $probeFile) -Destination $workspace
}
$env:SCOPEGUARD_SECRET_SENTINEL = "must-not-cross-process-boundary"

$manifests = @(
    [pscustomobject]@{ name = "none"; capabilities = @() },
    [pscustomobject]@{ name = "app"; capabilities = @("lpacAppExperience") },
    [pscustomobject]@{ name = "registry"; capabilities = @("registryRead") },
    [pscustomobject]@{ name = "instrumentation"; capabilities = @("lpacInstrumentation") },
    [pscustomobject]@{ name = "app-registry"; capabilities = @("lpacAppExperience", "registryRead") },
    [pscustomobject]@{ name = "app-instrumentation"; capabilities = @("lpacAppExperience", "lpacInstrumentation") },
    [pscustomobject]@{ name = "registry-instrumentation"; capabilities = @("registryRead", "lpacInstrumentation") },
    [pscustomobject]@{ name = "all"; capabilities = @("lpacAppExperience", "registryRead", "lpacInstrumentation") }
)
$runtimes = @("cmd", "node", "python", "powershell")

try {
    Write-Host "[capabilities] Building native launcher"
    $launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()
    $cmdPath = (Get-Command cmd.exe -ErrorAction Stop).Source
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
    $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $runtimeRoots = @(
        (Split-Path -Parent $nodePath),
        (Split-Path -Parent $pythonPath),
        (Split-Path -Parent $pwshPath)
    ) | Sort-Object -Unique

    $validationCases = @(
        [pscustomobject]@{
            name = "unsupported-capability-rejected"
            expectedError = "unsupported capability name"
            arguments = @(
                "run", "--name", $profileName, "--cwd", $workspace,
                "--lpac", "--capability", "internetClient", "--",
                $cmdPath, "/d", "/c", "exit /b 0"
            )
        },
        [pscustomobject]@{
            name = "duplicate-capability-rejected"
            expectedError = "duplicate capability name"
            arguments = @(
                "run", "--name", $profileName, "--cwd", $workspace,
                "--lpac", "--capability", "registryRead",
                "--capability", "registryRead", "--",
                $cmdPath, "/d", "/c", "exit /b 0"
            )
        },
        [pscustomobject]@{
            name = "capability-without-lpac-rejected"
            expectedError = "capabilities require --lpac"
            arguments = @(
                "run", "--name", $profileName, "--cwd", $workspace,
                "--capability", "registryRead", "--",
                $cmdPath, "/d", "/c", "exit /b 0"
            )
        }
    )
    $validationChecks = foreach ($validationCase in $validationCases) {
        $validationResult = Test-LauncherRejectsArguments `
            -Launcher $launcher `
            -Arguments $validationCase.arguments `
            -ExpectedError $validationCase.expectedError
        [pscustomobject][ordered]@{
            name = $validationCase.name
            passed = $validationResult.passed
            exitCode = $validationResult.exitCode
            stderr = $validationResult.stderr.Trim()
        }
    }

    $packageSid = (& $launcher profile --name $profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
        throw "Failed to create the Capability-matrix AppContainer profile."
    }
    $profilePath = (& $launcher profile-path --name $profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
        & $launcher delete --name $profileName
        throw "Failed to resolve the Capability-matrix profile path."
    }
    New-SandboxLifecycleLedger `
        -Path $ledgerPath `
        -ProfileName $profileName `
        -PackageSid $packageSid `
        -ProfilePath $profilePath | Out-Null
    Grant-SandboxAcl `
        -LedgerPath $ledgerPath `
        -Path $workspace `
        -Grant "(OI)(CI)(M)" `
        -Recursive
    $ancestor = [IO.Directory]::GetParent($workspace)
    while ($null -ne $ancestor) {
        Grant-SandboxAcl `
            -LedgerPath $ledgerPath `
            -Path $ancestor.FullName `
            -Grant "(RX)"
        $ancestor = $ancestor.Parent
    }
    foreach ($runtimeRoot in $runtimeRoots) {
        Grant-SandboxAcl `
            -LedgerPath $ledgerPath `
            -Path $runtimeRoot `
            -Grant "(OI)(CI)(RX)" `
            -Recursive
    }

    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($runtime in $runtimes) {
        foreach ($manifest in $manifests) {
            Write-Host "[capabilities] $runtime / $($manifest.name)"
            $results.Add((Invoke-RuntimeProbe `
                -Runtime $runtime `
                -ManifestName $manifest.name `
                -Capabilities @($manifest.capabilities) `
                -Launcher $launcher `
                -ProfileName $profileName `
                -Workspace $workspace `
                -Outside $outside `
                -DiagnosticsRoot $diagnosticsRoot `
                -CmdPath $cmdPath `
                -NodePath $nodePath `
                -PythonPath $pythonPath `
                -PwshPath $pwshPath))
        }
    }

    $selected = foreach ($runtime in $runtimes) {
        $minimum = @($results | Where-Object {
            $_.runtime -eq $runtime -and $_.passed
        } | Sort-Object capabilityCount, manifest)[0]
        if ($null -eq $minimum) {
            [pscustomobject]@{
                runtime = $runtime
                found = $false
                manifest = $null
                capabilities = @()
            }
        }
        else {
            [pscustomobject]@{
                runtime = $runtime
                found = $true
                manifest = $minimum.manifest
                capabilities = @($minimum.capabilities)
            }
        }
    }
    $missingTokenProof = @($results | Where-Object {
        -not $_.tokenManifestVerified
    })
    $summary = [ordered]@{
        passed = @($selected | Where-Object { -not $_.found }).Count -eq 0 -and
            @($validationChecks | Where-Object { -not $_.passed }).Count -eq 0 -and
            $missingTokenProof.Count -eq 0
        productionReady = $false
        windows = [Environment]::OSVersion.VersionString
        packageSid = $packageSid
        supersetManifest = @(
            "lpacAppExperience",
            "registryRead",
            "lpacInstrumentation"
        )
        validationChecks = $validationChecks
        selected = $selected
        results = $results
    }
    $summary | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath $resultPath -Encoding utf8
    $summary | ConvertTo-Json -Depth 12
    if (-not $summary.passed) {
        throw "Runtime Capability matrix failed. See $resultPath."
    }
}
finally {
    Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue
    if ($null -ne $launcher -and (Test-Path -LiteralPath $ledgerPath)) {
        $cleanup = Invoke-SandboxLifecycleRecovery `
            -LedgerPath $ledgerPath `
            -Launcher $launcher
        $cleanup | ConvertTo-Json -Depth 12 |
            Set-Content -LiteralPath $cleanupResultPath -Encoding utf8
        $cleanupPassed = $cleanup.passed
        if (-not $cleanupPassed) {
            throw "Capability-matrix cleanup failed. See $cleanupResultPath."
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
