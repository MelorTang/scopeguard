[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This Provisioner service matrix must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "provisioner.ps1")

function Add-ServiceCheck {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Passed,
        [Parameter(Mandatory)][string]$Detail
    )

    $Checks.Add([pscustomobject][ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.File]::WriteAllText(
        $Path,
        ($Value | ConvertTo-Json -Depth 16 -Compress),
        [Text.UTF8Encoding]::new($false)
    )
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Quote-ServiceArgument {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value.Contains('"')) {
        throw "Service argument contains a quote."
    }
    return '"' + $Value + '"'
}

function Invoke-ServiceClient {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$PipeName,
        [Parameter(Mandatory)][string]$Payload
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @("--client", "--pipe", $PipeName)) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start the Provisioner service client."
    }
    $process.StandardInput.Write($Payload)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(180000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Provisioner service client timed out."
    }
    return [pscustomobject][ordered]@{
        exitCode = $process.ExitCode
        stdout = $process.StandardOutput.ReadToEnd().Trim()
        stderr = $process.StandardError.ReadToEnd().Trim()
    }
}

function New-RequestJson {
    param(
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$ExecutionId,
        [string]$WorkspaceId = "workspace.primary",
        [string]$RuntimeId = "scopeguard.node"
    )

    $request = [ordered]@{
        schemaVersion = 1
        operation = $Operation
        requestId = [guid]::NewGuid().ToString("N")
        executionId = $ExecutionId
        issuedAtUtc = [DateTime]::UtcNow.ToString("O")
    }
    if ($Operation -ceq "prepare") {
        $request.workspaceId = $WorkspaceId
        $request.runtimeId = $RuntimeId
    }
    return $request | ConvertTo-Json -Compress
}

function Wait-ServiceState {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$State,
        [int]$TimeoutSeconds = 120
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $service = Get-Service -Name $Name -ErrorAction Stop
        if ($service.Status.ToString() -eq $State) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Service $Name did not reach $State."
}

function Set-FixtureAcl {
    param(
        [Parameter(Mandatory)][string]$FixtureRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$UserSid
    )

    & icacls.exe $FixtureRoot /inheritance:r /grant:r `
        '*S-1-5-18:(OI)(CI)(F)' `
        '*S-1-5-32-544:(OI)(CI)(F)' /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to protect the service fixture root." }
    & icacls.exe $InstallRoot /grant `
        "*$UserSid`:(OI)(CI)(RX)" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to grant Broker read/execute access." }
    & icacls.exe $Workspace /grant `
        "*$UserSid`:(OI)(CI)(M)" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to grant Workspace access." }
}

function Test-ExplicitUserRights {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$UserSid,
        [Parameter(Mandatory)][string]$ExpectedRights
    )

    $rules = @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        try {
            $_.IdentityReference.Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value -eq $UserSid
        }
        catch { $false }
    })
    return $rules.Count -eq 1 -and
        $rules[0].FileSystemRights.ToString() -match $ExpectedRights
}

Assert-ProvisionerElevated
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$serviceName = "ScopeGuardProvisionerPrototype"
$pipeName = "ScopeGuard.Provisioner.$([guid]::NewGuid().ToString('N'))"
$fixtureRoot = Join-Path $env:ProgramData "ScopeGuardProvisionerServiceFixture"
$installRoot = Join-Path $fixtureRoot "install"
$runtimeRoot = Join-Path $installRoot "runtime\node"
$metadataRoot = Join-Path $installRoot "metadata"
$stateRoot = Join-Path $fixtureRoot "state"
$requestRoot = Join-Path $fixtureRoot "requests"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$resultPath = Join-Path $fixtureRoot "result.json"
$checks = [System.Collections.Generic.List[object]]::new()
$cleanupPassed = $false

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 1
}
if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path @(
    $installRoot,
    $runtimeRoot,
    $metadataRoot,
    $stateRoot,
    $requestRoot,
    $workspace,
    $outside
) -Force | Out-Null

$builtLauncher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()
$builtService = (& (Join-Path $PSScriptRoot "build-provisioner-service.ps1")).Trim()
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$serviceExe = Join-Path $installRoot "scopeguard-provisioner-service.exe"
$launcher = Join-Path $installRoot "scopeguard-appcontainer.exe"
$worker = Join-Path $installRoot "provisioner-service-worker.ps1"
$provisioner = Join-Path $installRoot "provisioner.ps1"
$lifecycle = Join-Path $installRoot "lifecycle.ps1"
$runtimePack = Join-Path $installRoot "runtime-pack.ps1"
$runtimeExe = Join-Path $runtimeRoot "node.exe"
$manifestPath = Join-Path $metadataRoot "node-runtime.json"
$registryPath = Join-Path $metadataRoot "provisioner-registry.json"

Copy-Item -LiteralPath $builtService -Destination $serviceExe
Copy-Item -LiteralPath $builtLauncher -Destination $launcher
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "provisioner-service-worker.ps1") -Destination $worker
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "provisioner.ps1") -Destination $provisioner
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "lifecycle.ps1") -Destination $lifecycle
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "runtime-pack.ps1") -Destination $runtimePack
Copy-Item -LiteralPath $node -Destination $runtimeExe

$runtimeVersion = (Get-Item -LiteralPath $runtimeExe).VersionInfo.FileVersion
Write-Utf8Json -Path $manifestPath -Value ([ordered]@{
    schemaVersion = 1
    runtimeId = "scopeguard.node"
    version = $runtimeVersion
    architecture = "x64"
    executable = "node.exe"
    capabilities = @("registryRead")
    files = @([ordered]@{
        path = "node.exe"
        size = (Get-Item -LiteralPath $runtimeExe).Length
        sha256 = Get-Sha256 -Path $runtimeExe
    })
})
Write-Utf8Json -Path $registryPath -Value ([ordered]@{
    schemaVersion = 1
    workspaces = @([ordered]@{ id = "workspace.primary"; root = $workspace })
    runtimes = @([ordered]@{
        id = "scopeguard.node"
        packRoot = $runtimeRoot
        manifestPath = $manifestPath
        manifestSha256 = Get-Sha256 -Path $manifestPath
    })
})

$startupExecutionId = [guid]::NewGuid().ToString("N")
$startupPaths = Get-ProvisionerExecutionPaths `
    -StateRoot $stateRoot `
    -ExecutionId $startupExecutionId
$null = New-ProvisionerIntent `
    -Path $startupPaths.intentPath `
    -Request ([pscustomobject]@{
        executionId = $startupExecutionId
        payloadSha256 = "0" * 64
    }) `
    -ProfileName "ScopeGuardExec_$startupExecutionId"

Set-FixtureAcl `
    -FixtureRoot $fixtureRoot `
    -InstallRoot $installRoot `
    -Workspace $workspace `
    -UserSid $userSid

$hashes = [ordered]@{
    broker = Get-Sha256 -Path $serviceExe
    pwsh = Get-Sha256 -Path $pwsh
    worker = Get-Sha256 -Path $worker
    provisioner = Get-Sha256 -Path $provisioner
    lifecycle = Get-Sha256 -Path $lifecycle
    runtimePack = Get-Sha256 -Path $runtimePack
    registry = Get-Sha256 -Path $registryPath
    launcher = Get-Sha256 -Path $launcher
}
$serviceArguments = @(
    "--service",
    "--service-name", $serviceName,
    "--pipe", $pipeName,
    "--broker-sid", $userSid,
    "--broker-image", $serviceExe,
    "--broker-sha256", $hashes.broker,
    "--pwsh", $pwsh,
    "--pwsh-sha256", $hashes.pwsh,
    "--worker", $worker,
    "--worker-sha256", $hashes.worker,
    "--provisioner", $provisioner,
    "--provisioner-sha256", $hashes.provisioner,
    "--lifecycle", $lifecycle,
    "--lifecycle-sha256", $hashes.lifecycle,
    "--runtime-pack", $runtimePack,
    "--runtime-pack-sha256", $hashes.runtimePack,
    "--registry", $registryPath,
    "--registry-sha256", $hashes.registry,
    "--state-root", $stateRoot,
    "--request-root", $requestRoot,
    "--launcher", $launcher,
    "--launcher-sha256", $hashes.launcher
)
$binaryPath = (Quote-ServiceArgument -Value $serviceExe) + " " +
    (($serviceArguments | ForEach-Object { Quote-ServiceArgument -Value $_ }) -join " ")

try {
    New-Service `
        -Name $serviceName `
        -BinaryPathName $binaryPath `
        -StartupType Manual `
        -Description "ScopeGuard narrow sandbox Provisioner prototype" | Out-Null
    Start-Service -Name $serviceName
    Wait-ServiceState -Name $serviceName -State "Running"

    $serviceCim = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    Add-ServiceCheck `
        -Checks $checks `
        -Name "scm-service-runs-as-local-system" `
        -Passed ($serviceCim.StartName -eq "LocalSystem" -and $serviceCim.State -eq "Running") `
        -Detail "startName=$($serviceCim.StartName); state=$($serviceCim.State)"

    $installAclOk = Test-ExplicitUserRights `
        -Path $installRoot `
        -UserSid $userSid `
        -ExpectedRights "ReadAndExecute"
    $stateUserRules = @((Get-Acl -LiteralPath $stateRoot).Access | Where-Object {
        try {
            $_.IdentityReference.Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value -eq $userSid
        }
        catch { $false }
    })
    Add-ServiceCheck `
        -Checks $checks `
        -Name "service-roots-have-narrow-user-acls" `
        -Passed ($installAclOk -and $stateUserRules.Count -eq 0) `
        -Detail "installRx=$installAclOk; stateUserRules=$($stateUserRules.Count)"

    Add-ServiceCheck `
        -Checks $checks `
        -Name "startup-recovery-completes-before-pipe-opens" `
        -Passed (
            -not (Test-Path -LiteralPath $startupPaths.intentPath) -and
            (Test-Path -LiteralPath $startupPaths.tombstonePath)
        ) `
        -Detail "intent=$([bool](Test-Path $startupPaths.intentPath)); tombstone=$([bool](Test-Path $startupPaths.tombstonePath))"

    $executionId = [guid]::NewGuid().ToString("N")
    $prepareClient = Invoke-ServiceClient `
        -Executable $serviceExe `
        -PipeName $pipeName `
        -Payload (New-RequestJson -Operation "prepare" -ExecutionId $executionId)
    $prepare = if ($prepareClient.stdout) {
        $prepareClient.stdout | ConvertFrom-Json -Depth 16
    }
    else { $null }
    Write-Utf8Json `
        -Path (Join-Path $fixtureRoot "prepare-client.json") `
        -Value $prepareClient
    if ($prepareClient.exitCode -ne 0 -or $null -eq $prepare -or -not $prepare.ok) {
        throw "Provisioner service prepare failed: exit=$($prepareClient.exitCode); " +
            "stdout=$($prepareClient.stdout); stderr=$($prepareClient.stderr)"
    }
    Add-ServiceCheck `
        -Checks $checks `
        -Name "pinned-broker-prepares-through-service" `
        -Passed (
            $prepare.result.state -eq "prepared"
        ) `
        -Detail "exit=$($prepareClient.exitCode); state=$($prepare.result.state)"
    Add-ServiceCheck `
        -Checks $checks `
        -Name "worker-retains-local-system-identity" `
        -Passed (
            $prepare.serviceIdentity.isLocalSystem -and
            $prepare.serviceIdentity.sid -eq "S-1-5-18"
        ) `
        -Detail "identity=$($prepare.serviceIdentity.name); sid=$($prepare.serviceIdentity.sid)"

    $malformed = (New-RequestJson -Operation "cleanup" -ExecutionId $executionId) |
        ConvertFrom-Json
    $malformed | Add-Member -NotePropertyName rawPath -NotePropertyValue "C:\Windows"
    $malformedClient = Invoke-ServiceClient `
        -Executable $serviceExe `
        -PipeName $pipeName `
        -Payload ($malformed | ConvertTo-Json -Compress)
    $malformedResponse = $malformedClient.stdout | ConvertFrom-Json
    Add-ServiceCheck `
        -Checks $checks `
        -Name "service-worker-rejects-unknown-request-fields" `
        -Passed (
            $malformedClient.exitCode -eq 0 -and
            -not $malformedResponse.ok -and
            $malformedResponse.error.message -match "unexpected property"
        ) `
        -Detail $malformedResponse.error.message

    $copiedClient = Join-Path $env:TEMP "scopeguard-untrusted-provisioner-client.exe"
    Copy-Item -LiteralPath $serviceExe -Destination $copiedClient -Force
    $untrustedClient = Invoke-ServiceClient `
        -Executable $copiedClient `
        -PipeName $pipeName `
        -Payload (New-RequestJson -Operation "cleanup" -ExecutionId $executionId)
    Add-ServiceCheck `
        -Checks $checks `
        -Name "copied-client-image-is-rejected" `
        -Passed ($untrustedClient.exitCode -ne 0 -and -not $untrustedClient.stdout) `
        -Detail "exit=$($untrustedClient.exitCode); stderr=$($untrustedClient.stderr)"
    Remove-Item -LiteralPath $copiedClient -Force

    $cleanupClient = Invoke-ServiceClient `
        -Executable $serviceExe `
        -PipeName $pipeName `
        -Payload (New-RequestJson -Operation "cleanup" -ExecutionId $executionId)
    $cleanup = $cleanupClient.stdout | ConvertFrom-Json -Depth 16
    Add-ServiceCheck `
        -Checks $checks `
        -Name "service-cleanup-removes-profile-and-acls" `
        -Passed (
            $cleanupClient.exitCode -eq 0 -and
            $cleanup.ok -and
            $cleanup.result.state -eq "cleaned" -and
            -not $cleanup.result.profilePathExists -and
            @($cleanup.result.errors).Count -eq 0
        ) `
        -Detail "state=$($cleanup.result.state); attempts=$($cleanup.result.cleanupAttempts)"

    $restartExecutionId = [guid]::NewGuid().ToString("N")
    $restartPrepareClient = Invoke-ServiceClient `
        -Executable $serviceExe `
        -PipeName $pipeName `
        -Payload (New-RequestJson -Operation "prepare" -ExecutionId $restartExecutionId)
    $restartPrepare = $restartPrepareClient.stdout | ConvertFrom-Json -Depth 16
    Stop-Service -Name $serviceName -Force
    Wait-ServiceState -Name $serviceName -State "Stopped"
    Start-Service -Name $serviceName
    Wait-ServiceState -Name $serviceName -State "Running"
    $restartLedgerPath = Get-ProvisionerLedgerPath `
        -StateRoot $stateRoot `
        -ExecutionId $restartExecutionId
    $restartLedger = Read-SandboxLifecycleLedger -Path $restartLedgerPath
    Add-ServiceCheck `
        -Checks $checks `
        -Name "service-restart-recovers-prepared-lifecycle" `
        -Passed (
            $restartPrepare.ok -and
            $restartLedger.state -eq "cleaned" -and
            $restartLedger.cleanupAttempts -eq 1 -and
            @($restartLedger.lastCleanupErrors).Count -eq 0
        ) `
        -Detail "state=$($restartLedger.state); attempts=$($restartLedger.cleanupAttempts)"

    Add-Content -LiteralPath $worker -Value "# tamper" -Encoding utf8
    $tamperClient = Invoke-ServiceClient `
        -Executable $serviceExe `
        -PipeName $pipeName `
        -Payload (New-RequestJson -Operation "cleanup" -ExecutionId $restartExecutionId)
    Add-ServiceCheck `
        -Checks $checks `
        -Name "pinned-worker-tamper-fails-before-dispatch" `
        -Passed ($tamperClient.exitCode -ne 0 -and -not $tamperClient.stdout) `
        -Detail "exit=$($tamperClient.exitCode); stderr=$($tamperClient.stderr)"

    $requestFiles = @(Get-ChildItem -LiteralPath $requestRoot -Force)
    Add-ServiceCheck `
        -Checks $checks `
        -Name "request-spool-is-empty-after-dispatch" `
        -Passed ($requestFiles.Count -eq 0) `
        -Detail "remaining=$($requestFiles.Count)"

    $failed = @($checks | Where-Object { -not $_.passed })
    $summary = [ordered]@{
        passed = $failed.Count -eq 0
        productionReady = $false
        windows = [Environment]::OSVersion.VersionString
        serviceName = $serviceName
        pipeName = $pipeName
        checks = $checks
        prepare = $prepare
        cleanup = $cleanup
        restartLedger = $restartLedger
        remainingGates = @(
            "signed ScopeGuard service and Broker binaries",
            "installer-owned production roots and upgrade/recovery design",
            "Desktop Broker adapter and concurrent request handling",
            "Windows 10 x64 validation"
        )
    }
    Write-Utf8Json -Path $resultPath -Value $summary
    $summary | ConvertTo-Json -Depth 16
    $cleanupPassed = $summary.passed
    if (-not $summary.passed) {
        throw "$($failed.Count) Provisioner service checks failed. See $resultPath."
    }
}
finally {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 1
    if (Test-Path -LiteralPath $stateRoot) {
        foreach ($directory in Get-ChildItem -LiteralPath $stateRoot -Directory -Force) {
            if ($directory.Name -notmatch '^[0-9a-f]{32}$') { continue }
            try { & $launcher delete --name "ScopeGuardExec_$($directory.Name)" | Out-Null } catch {}
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
