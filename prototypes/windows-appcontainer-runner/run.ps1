[CmdletBinding()]
param(
    [ValidateSet("appcontainer", "lpac")]
    [string]$Mode = "appcontainer",
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This prototype must run on Windows with PowerShell 7."
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-$Mode-fixture"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$resultPath = Join-Path $fixtureRoot "result.json"
$profileName = "ScopeGuardPrototype_$([guid]::NewGuid().ToString('N'))"
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

function Invoke-SandboxCommand {
    param(
        [string[]]$CommandArguments,
        [int]$TimeoutSeconds = 60
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $launcher
    $startInfo.WorkingDirectory = $workspace
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $launcherArguments = @(
        "run",
        "--name",
        $profileName,
        "--cwd",
        $workspace,
        "--timeout",
        $TimeoutSeconds.ToString()
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
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [ordered]@{
        exitCode = $process.ExitCode
        stdout = $stdoutTask.GetAwaiter().GetResult()
        stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workspace, $outside -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "boundary-probe.py") -Destination $workspace
Set-Content -LiteralPath (Join-Path $workspace "input.txt") -Value "workspace-ok" -Encoding utf8

$outsideSecret = Join-Path $outside "outside-secret.txt"
$hardLinkTarget = Join-Path $outside "hardlink-target.txt"
$hardLinkPath = Join-Path $workspace "outside-hardlink.txt"
Set-Content -LiteralPath $outsideSecret -Value "scopeguard-outside-secret" -Encoding utf8
Set-Content -LiteralPath $hardLinkTarget -Value "hardlink-original" -Encoding utf8 -NoNewline

$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$pythonRoot = Split-Path -Parent $pythonPath
$profileSid = (& $launcher profile --name $profileName).Trim()
if ($LASTEXITCODE -ne 0 -or $profileSid -notmatch '^S-1-15-2-') {
    throw "Failed to create the AppContainer profile or resolve its package SID."
}

try {
    Invoke-IcaclsGrant -Path $workspace -Grant "*$($profileSid):(OI)(CI)(M)" -Recursive
    Invoke-IcaclsGrant -Path $pythonRoot -Grant "*$($profileSid):(OI)(CI)(RX)" -Recursive
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
    $env:SCOPEGUARD_SECRET_SENTINEL = "must-not-cross-process-boundary"

    try {
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
            $boundaryResult
        )
        $probe = if (Test-Path -LiteralPath $boundaryResult) {
            Get-Content -LiteralPath $boundaryResult -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        $summary = [ordered]@{
            passed = $run.exitCode -eq 0 -and $null -ne $probe -and $probe.passed
            runner = "$Mode-job"
            packageSid = $profileSid
            windows = [Environment]::OSVersion.VersionString
            launcherExitCode = $run.exitCode
            launcherStdout = $run.stdout
            launcherStderr = $run.stderr
            checks = if ($null -ne $probe) { $probe.results } else { @() }
            protectedProcessStillRunning = -not $protectedProcess.HasExited
            hardLinkTargetUnchanged = (Get-Content -LiteralPath $hardLinkTarget -Raw) -eq "hardlink-original"
        }
        $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
        $summary | ConvertTo-Json -Depth 8
        if (-not $summary.passed) {
            throw "AppContainer boundary matrix failed. See $resultPath."
        }
    }
    finally {
        Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue
        $listener.Stop()
        if (-not $protectedProcess.HasExited) {
            Stop-Process -Id $protectedProcess.Id -Force
        }
        & cmdkey.exe "/delete:$credentialTarget" | Out-Null
        Remove-Item -Path $registryPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}
finally {
    & $launcher delete --name $profileName
    if (-not $KeepFixture -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
