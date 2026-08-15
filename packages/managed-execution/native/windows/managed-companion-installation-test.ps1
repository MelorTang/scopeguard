[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The managed companion installation matrix requires Windows."
}
. (Join-Path $PSScriptRoot "managed-companion-installation.ps1")
Assert-ManagedInstallerElevated

function Add-InstallationCheck {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Passed,
        [Parameter(Mandatory)][string]$Detail
    )

    $script:Checks.Add([pscustomobject][ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Test-SidRights {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Sid,
        [Parameter(Mandatory)][string]$Pattern
    )

    $rules = @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        try {
            $_.IdentityReference.Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value -eq $Sid
        }
        catch { $false }
    })
    return $rules.Count -eq 1 -and
        $rules[0].FileSystemRights.ToString() -match $Pattern
}

$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
$serviceName = "ScopeGuardProvisionerTest$suffix"
$pipeName = "ScopeGuard.InstallTest.$suffix"
$installRoot = Join-Path $env:ProgramFiles "ScopeGuard\ManagedExecution-Test-$suffix"
$stateRoot = Join-Path $env:ProgramData "ScopeGuard\ManagedExecution-Test-$suffix"
$registryRoot = "HKLM:\SOFTWARE\ScopeGuard\ManagedExecutionTest\$suffix"
$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-managed-installation-$suffix"
$workspace = Join-Path $fixtureRoot "workspace"
$diagnostics = Join-Path $fixtureRoot "product-adapter-diagnostics"
$profileState = Join-Path $fixtureRoot "product-adapter-profile-intents"
$adapterResultPath = Join-Path $fixtureRoot "product-adapter-result.json"
$ReportPath = if ($ReportPath) {
    Get-NormalizedPath -Path $ReportPath
}
else {
    Join-Path $fixtureRoot "installation-result.json"
}
$checks = [Collections.Generic.List[object]]::new()
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$installer = Join-Path $PSScriptRoot "install-managed-companion.ps1"
$uninstaller = Join-Path $PSScriptRoot "uninstall-managed-companion.ps1"
$serviceExe = Join-Path $installRoot "payload\bin\scopeguard-provisioner-service.exe"
$worker = Join-Path $installRoot "payload\scripts\provisioner-service-worker.ps1"
$cleanupComplete = $false

Remove-ManagedService -Name $serviceName
Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $registryRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $workspace -Force | Out-Null

try {
    $installJson = & $installer `
        -PackageRoot $PackageRoot `
        -WorkspaceRoot $workspace `
        -BrokerSid $currentSid `
        -InstallRoot $installRoot `
        -StateRoot $stateRoot `
        -RegistryRoot $registryRoot `
        -ServiceName $serviceName `
        -PipeName $pipeName `
        -AllowUnsignedDevelopmentPackage
    $install = $installJson | ConvertFrom-Json -Depth 8
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    $registered = Get-ItemProperty -LiteralPath $registryRoot
    Add-InstallationCheck `
        -Name "fresh-machine-install-registers-running-service" `
        -Passed (
            $install.status -ceq "installed" -and
            $service.State -ceq "Running" -and
            $service.StartName -ceq "LocalSystem" -and
            $registered.InstallRoot -ceq $installRoot -and
            $registered.ContentDigest -ceq $install.contentDigest
        ) `
        -Detail "status=$($install.status); service=$($service.State); identity=$($service.StartName)"

    $installAcl = Test-SidRights `
        -Path $installRoot `
        -Sid "S-1-5-32-545" `
        -Pattern "ReadAndExecute"
    $stateUserRules = @((Get-Acl -LiteralPath $stateRoot).Access | Where-Object {
        try {
            $_.IdentityReference.Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value -eq "S-1-5-32-545"
        }
        catch { $false }
    })
    Add-InstallationCheck `
        -Name "machine-roots-enforce-readonly-install-and-private-state" `
        -Passed ($installAcl -and $stateUserRules.Count -eq 0) `
        -Detail "installUsersRx=$installAcl; stateUsersRules=$($stateUserRules.Count)"

    $adapterOutput = (& node `
        (Join-Path $PSScriptRoot "product-adapter-probe.mjs") `
        --installation-root $installRoot `
        --service-client $serviceExe `
        --launcher (Join-Path $installRoot "payload\bin\scopeguard-appcontainer.exe") `
        --lifetime-broker (Join-Path $installRoot "payload\bin\scopeguard-lifetime-broker.exe") `
        --pipe $pipeName `
        --workspace $workspace `
        --diagnostics $diagnostics `
        --profile-state $profileState `
        --result $adapterResultPath 2>&1 | Out-String).Trim()
    $adapterExit = $LASTEXITCODE
    $adapter = if (Test-Path -LiteralPath $adapterResultPath) {
        Get-Content -LiteralPath $adapterResultPath -Raw | ConvertFrom-Json -Depth 16
    }
    else { $null }
    Add-InstallationCheck `
        -Name "installed-product-adapter-runs-and-cleans-lpac-command" `
        -Passed (
            $adapterExit -eq 0 -and
            $adapter -and
            $adapter.passed -and
            $adapter.result.cleanup -ceq "clean" -and
            $adapter.result.termination -ceq "confirmed"
        ) `
        -Detail "exit=$adapterExit; output=$adapterOutput"

    $packageWorker = Join-Path $PackageRoot "payload\scripts\provisioner-service-worker.ps1"
    $expectedWorkerHash = Get-ManagedSha256 -Path $packageWorker
    [IO.File]::AppendAllText($worker, "`n# installation repair test")
    $repairJson = & $installer `
        -PackageRoot $PackageRoot `
        -WorkspaceRoot $workspace `
        -BrokerSid $currentSid `
        -InstallRoot $installRoot `
        -StateRoot $stateRoot `
        -RegistryRoot $registryRoot `
        -ServiceName $serviceName `
        -PipeName $pipeName `
        -AllowUnsignedDevelopmentPackage
    $repair = $repairJson | ConvertFrom-Json -Depth 8
    Add-InstallationCheck `
        -Name "repair-restores-tampered-payload-and-service" `
        -Passed (
            $repair.status -ceq "repaired" -and
            (Get-ManagedSha256 -Path $worker) -ceq $expectedWorkerHash -and
            (Get-Service -Name $serviceName).Status -eq
                [ServiceProcess.ServiceControllerStatus]::Running
        ) `
        -Detail "status=$($repair.status); worker=$(Get-ManagedSha256 -Path $worker)"

    $beforeRollbackHash = Get-ManagedSha256 -Path $worker
    $beforeRollbackConfig = [IO.File]::ReadAllBytes(
        (Join-Path $stateRoot "config\provisioner-registry.json")
    )
    $env:SCOPEGUARD_INSTALLER_TEST_MODE = "1"
    $rollbackRejected = $false
    try {
        & $installer `
            -PackageRoot $PackageRoot `
            -WorkspaceRoot $workspace `
            -BrokerSid $currentSid `
            -InstallRoot $installRoot `
            -StateRoot $stateRoot `
            -RegistryRoot $registryRoot `
            -ServiceName $serviceName `
            -PipeName $pipeName `
            -AllowUnsignedDevelopmentPackage `
            -FailureInjectionPoint "after-service-registration" | Out-Null
    }
    catch {
        $rollbackRejected = $_.Exception.Message -match "Injected failure"
    }
    finally {
        Remove-Item Env:SCOPEGUARD_INSTALLER_TEST_MODE -ErrorAction SilentlyContinue
    }
    $afterRollbackConfig = [IO.File]::ReadAllBytes(
        (Join-Path $stateRoot "config\provisioner-registry.json")
    )
    $rollbackConfigMatches = [Convert]::ToBase64String($beforeRollbackConfig) -ceq
        [Convert]::ToBase64String($afterRollbackConfig)
    Add-InstallationCheck `
        -Name "failed-upgrade-restores-payload-config-and-service" `
        -Passed (
            $rollbackRejected -and
            (Get-ManagedSha256 -Path $worker) -ceq $beforeRollbackHash -and
            $rollbackConfigMatches -and
            (Get-Service -Name $serviceName).Status -eq
                [ServiceProcess.ServiceControllerStatus]::Running
        ) `
        -Detail "rejected=$rollbackRejected; service=$((Get-Service $serviceName).Status)"

    $unsignedRejected = $false
    try {
        & $installer `
            -PackageRoot $PackageRoot `
            -WorkspaceRoot $workspace `
            -BrokerSid $currentSid `
            -InstallRoot $installRoot `
            -StateRoot $stateRoot `
            -RegistryRoot $registryRoot `
            -ServiceName $serviceName `
            -PipeName $pipeName | Out-Null
    }
    catch {
        $unsignedRejected = $_.Exception.Message -match "trusted release verification|development package"
    }
    Add-InstallationCheck `
        -Name "unsigned-package-is-rejected-by-default-without-mutation" `
        -Passed (
            $unsignedRejected -and
            (Get-Service -Name $serviceName).Status -eq
                [ServiceProcess.ServiceControllerStatus]::Running -and
            (Get-ManagedSha256 -Path $worker) -ceq $beforeRollbackHash
        ) `
        -Detail "rejected=$unsignedRejected"

    $uninstallJson = & $uninstaller `
        -InstallRoot $installRoot `
        -StateRoot $stateRoot `
        -RegistryRoot $registryRoot `
        -ServiceName $serviceName `
        -PurgeCleanState
    $uninstall = $uninstallJson | ConvertFrom-Json -Depth 6
    Add-InstallationCheck `
        -Name "clean-uninstall-removes-service-roots-and-registration" `
        -Passed (
            $uninstall.serviceRemoved -and
            $uninstall.installRootRemoved -and
            $uninstall.registryRemoved -and
            $uninstall.stateWasClean -and
            $uninstall.stateRemoved
        ) `
        -Detail ($uninstall | ConvertTo-Json -Compress)

    $secondUninstallJson = & $uninstaller `
        -InstallRoot $installRoot `
        -StateRoot $stateRoot `
        -RegistryRoot $registryRoot `
        -ServiceName $serviceName `
        -PurgeCleanState
    $secondUninstall = $secondUninstallJson | ConvertFrom-Json -Depth 6
    Add-InstallationCheck `
        -Name "uninstall-is-idempotent" `
        -Passed (
            $secondUninstall.serviceRemoved -and
            $secondUninstall.installRootRemoved -and
            $secondUninstall.registryRemoved -and
            $secondUninstall.stateRemoved
        ) `
        -Detail ($secondUninstall | ConvertTo-Json -Compress)
    $cleanupComplete = $true
}
finally {
    Remove-Item Env:SCOPEGUARD_INSTALLER_TEST_MODE -ErrorAction SilentlyContinue
    if (-not $cleanupComplete) {
        try {
            & $uninstaller `
                -InstallRoot $installRoot `
                -StateRoot $stateRoot `
                -RegistryRoot $registryRoot `
                -ServiceName $serviceName `
                -PurgeCleanState | Out-Null
        }
        catch {
            Remove-ManagedService -Name $serviceName
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $registryRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$failed = @($checks | Where-Object { -not $_.passed })
$result = [pscustomobject][ordered]@{
    schemaVersion = 1
    passed = $failed.Count -eq 0
    windowsBuild = (Get-ItemProperty `
        -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuildNumber
    checks = $checks
    cleanupComplete = $cleanupComplete
}
Write-ManagedUtf8Json -Path $ReportPath -Value $result
$result | ConvertTo-Json -Depth 8
if ($failed.Count -gt 0) {
    throw "$($failed.Count) managed companion installation checks failed."
}
