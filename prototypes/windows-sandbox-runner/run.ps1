[CmdletBinding()]
param(
    [string]$ToolCache = (Join-Path ([IO.Path]::GetTempPath()) "scopeguard-codex-0.147.0"),
    [switch]$SkipSetup,
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $IsWindows) {
    throw "This prototype must run on Windows with PowerShell 7."
}

$prototypeDirectory = $PSScriptRoot
$fixtureBase = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
}
else {
    [IO.Path]::GetTempPath()
}
$fixtureRoot = Join-Path $fixtureBase "scopeguard-windows-sandbox-fixture"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$codexHome = Join-Path $fixtureRoot "codex-home"
$resultPath = Join-Path $fixtureRoot "result.json"
$binDirectory = Join-Path $ToolCache "bin"
$codexPath = Join-Path $binDirectory "codex.exe"

$assets = @(
    @{
        Name = "codex.exe"
        Url = "https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-x86_64-pc-windows-msvc.exe"
        Sha256 = "935a1911ed2556e4ffcec995f4886ac2ac425863ba26fed264df62e30272ad9d"
    },
    @{
        Name = "codex-command-runner.exe"
        Url = "https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-command-runner-x86_64-pc-windows-msvc.exe"
        Sha256 = "3a70491d8d588afa459a42816f05b8c2fdd6bddb0ef318f3dfccc963a30b420a"
    },
    @{
        Name = "codex-windows-sandbox-setup.exe"
        Url = "https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe"
        Sha256 = "a4df86996dfbb218d96d73a80606d89b742dfa4ddd3470614e90dde89e3250a3"
    }
)

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-VerifiedAsset {
    param(
        [hashtable]$Asset
    )

    $destination = Join-Path $binDirectory $Asset.Name
    if (Test-Path -LiteralPath $destination) {
        $existingHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -eq $Asset.Sha256) {
            return
        }
        Remove-Item -LiteralPath $destination -Force
    }

    Write-Host "Downloading $($Asset.Name)..."
    Invoke-WebRequest -Uri $Asset.Url -OutFile $destination
    $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $Asset.Sha256) {
        Remove-Item -LiteralPath $destination -Force
        throw "SHA-256 mismatch for $($Asset.Name): expected $($Asset.Sha256), got $actualHash"
    }
}

function ConvertTo-TomlBasicString {
    param([string]$Value)

    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
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

function Invoke-SandboxCommand {
    param(
        [string[]]$CommandArguments,
        [int]$TimeoutSeconds = 90
    )

    $arguments = @(
        "sandbox",
        "--permission-profile",
        "scopeguard-prototype",
        "--cd",
        $workspace,
        "--"
    ) + $CommandArguments

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $codexPath
    $startInfo.WorkingDirectory = $workspace
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    foreach ($argument in $arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $startInfo.Environment.Clear()
    $allowedEnvironment = @(
        "ALLUSERSPROFILE",
        "APPDATA",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "ComSpec",
        "LOCALAPPDATA",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "Path",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "PROCESSOR_LEVEL",
        "PROCESSOR_REVISION",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "SystemDrive",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "windir"
    )
    foreach ($name in $allowedEnvironment) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) {
            $startInfo.Environment[$name] = $value
        }
    }
    $startInfo.Environment["CODEX_HOME"] = $codexHome
    $startInfo.Environment["CODEX_DISABLE_UPDATE_CHECK"] = "1"

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start Codex sandbox command."
    }

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        throw "Codex sandbox command timed out after $TimeoutSeconds seconds."
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()

    return [ordered]@{
        exitCode = $process.ExitCode
        stdout = $stdout
        stderr = $stderr
        arguments = $arguments
    }
}

if (-not (Test-IsAdministrator)) {
    throw "The prototype requires an elevated PowerShell process for one-time sandbox provisioning."
}

New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
foreach ($asset in $assets) {
    Get-VerifiedAsset -Asset $asset
}

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workspace, $outside, $codexHome -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $prototypeDirectory "probe.ps1") -Destination $workspace
Copy-Item -LiteralPath (Join-Path $prototypeDirectory "boundary-probe.py") -Destination $workspace
Copy-Item -LiteralPath (Join-Path $prototypeDirectory "worker-probe.js") -Destination $workspace
Copy-Item -LiteralPath (Join-Path $prototypeDirectory "python-probe.py") -Destination $workspace
Copy-Item -LiteralPath (Join-Path $prototypeDirectory "cmd-probe.cmd") -Destination $workspace
Set-Content -LiteralPath (Join-Path $workspace "input.txt") -Value "workspace-ok" -Encoding utf8

$outsideSecret = Join-Path $outside "outside-secret.txt"
$hardLinkTarget = Join-Path $outside "hardlink-target.txt"
$hardLinkPath = Join-Path $workspace "outside-hardlink.txt"
Set-Content -LiteralPath $outsideSecret -Value "scopeguard-outside-secret" -Encoding utf8
Set-Content -LiteralPath $hardLinkTarget -Value "hardlink-original" -Encoding utf8 -NoNewline
New-Item -ItemType Junction -Path (Join-Path $workspace "junction-outside") -Target $outside | Out-Null
New-Item -ItemType HardLink -Path $hardLinkPath -Target $hardLinkTarget | Out-Null

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$runtimeReadRoots = @(
    (Split-Path -Parent $nodePath),
    (Split-Path -Parent $pythonPath),
    (Split-Path -Parent $pwshPath)
) | Sort-Object -Unique

$filesystemLines = [System.Collections.Generic.List[string]]::new()
$filesystemLines.Add('":minimal" = "read"')
$filesystemLines.Add('{0} = "write"' -f (ConvertTo-TomlBasicString $workspace))
$filesystemLines.Add('{0} = "deny"' -f (ConvertTo-TomlBasicString $outside))
foreach ($runtimeRoot in $runtimeReadRoots) {
    $filesystemLines.Add('{0} = "read"' -f (ConvertTo-TomlBasicString $runtimeRoot))
}

$config = @"
default_permissions = "scopeguard-prototype"

[windows]
sandbox = "elevated"
sandbox_private_desktop = true

[permissions.scopeguard-prototype.workspace_roots]
"." = true

[permissions.scopeguard-prototype.filesystem]
$($filesystemLines -join "`n")

[permissions.scopeguard-prototype.network]
enabled = false
"@
Set-Content -LiteralPath (Join-Path $codexHome "config.toml") -Value $config -Encoding utf8

$oldCodexHome = [Environment]::GetEnvironmentVariable("CODEX_HOME")
$env:CODEX_HOME = $codexHome
try {
    if (-not $SkipSetup) {
        Write-Host "Provisioning elevated Codex Windows sandbox..."
        & $codexPath sandbox setup --elevated --current-user
        if ($LASTEXITCODE -ne 0) {
            throw "Codex sandbox setup failed with exit code $LASTEXITCODE."
        }
    }

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
    $checks = [System.Collections.Generic.List[object]]::new()

    try {
        $boundaryResultPath = Join-Path $workspace "boundary-result.json"
        $boundaryRun = Invoke-SandboxCommand -CommandArguments @(
            $pythonPath,
            (Join-Path $workspace "boundary-probe.py"),
            $workspace,
            $outside,
            $outsideSecret,
            $hardLinkPath,
            $credentialTarget,
            $protectedProcess.Id.ToString(),
            $loopbackPort.ToString(),
            $boundaryResultPath
        )
        $boundarySummary = if (Test-Path -LiteralPath $boundaryResultPath) {
            Get-Content -LiteralPath $boundaryResultPath -Raw | ConvertFrom-Json
        }
        else {
            $null
        }
        Add-Check -Checks $checks -Name "python-os-boundary" -Passed (
            $null -ne $boundarySummary -and $boundarySummary.passed
        ) -Detail "exit=$($boundaryRun.exitCode); stderr=$($boundaryRun.stderr.Trim())"
        if ($null -ne $boundarySummary) {
            foreach ($probeResult in $boundarySummary.results) {
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
        )
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
        ) -Detail "exit=$($powershellRun.exitCode); stderr=$($powershellRun.stderr.Trim())"

        $cmdAllowed = Join-Path $workspace "cmd-output.txt"
        $cmdDenied = Join-Path $outside "cmd-outside.txt"
        $cmdRun = Invoke-SandboxCommand -CommandArguments @(
            "cmd.exe",
            "/d",
            "/s",
            "/c",
            (Join-Path $workspace "cmd-probe.cmd"),
            $cmdAllowed,
            $cmdDenied
        )
        Add-Check -Checks $checks -Name "cmd-runtime" -Passed (
            $cmdRun.exitCode -eq 0 -and
            (Test-Path -LiteralPath $cmdAllowed) -and
            -not (Test-Path -LiteralPath $cmdDenied)
        ) -Detail "exit=$($cmdRun.exitCode); stderr=$($cmdRun.stderr.Trim())"

        foreach ($kind in @("document-worker", "skill", "stdio-mcp")) {
            $workerResultPath = Join-Path $workspace "$kind-result.json"
            $workerRun = Invoke-SandboxCommand -CommandArguments @(
                $nodePath,
                (Join-Path $workspace "worker-probe.js"),
                $kind,
                $workspace,
                $outside,
                $workerResultPath
            )
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
            ) -Detail "exit=$($workerRun.exitCode); stderr=$($workerRun.stderr.Trim())"
        }

        $pythonResultPath = Join-Path $workspace "python-result.json"
        $pythonRun = Invoke-SandboxCommand -CommandArguments @(
            $pythonPath,
            (Join-Path $workspace "python-probe.py"),
            $workspace,
            $outside,
            $pythonResultPath
        )
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
        ) -Detail "exit=$($pythonRun.exitCode); stderr=$($pythonRun.stderr.Trim())"

        Add-Check -Checks $checks -Name "protected-process-still-running" -Passed (-not $protectedProcess.HasExited) -Detail "pid=$($protectedProcess.Id)"
        Add-Check -Checks $checks -Name "hardlink-target-unchanged" -Passed (
            (Get-Content -LiteralPath $hardLinkTarget -Raw) -eq "hardlink-original"
        ) -Detail $hardLinkTarget

        $failedChecks = @($checks | Where-Object { -not $_.passed })
        $summary = [ordered]@{
            passed = $failedChecks.Count -eq 0
            codexVersion = "0.147.0"
            windows = [Environment]::OSVersion.VersionString
            powershell = $PSVersionTable.PSVersion.ToString()
            checks = $checks
        }
        $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
        $summary | ConvertTo-Json -Depth 8

        if ($failedChecks.Count -gt 0) {
            throw "$($failedChecks.Count) sandbox checks failed. See $resultPath."
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
    if ($null -eq $oldCodexHome) {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    }
    else {
        $env:CODEX_HOME = $oldCodexHome
    }

    if (-not $KeepFixture -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
