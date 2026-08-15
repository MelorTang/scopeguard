[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$WorkspaceRoot,
    [string]$WorkspaceId = "workspace.primary",
    [string]$BrokerSid,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles "ScopeGuard\ManagedExecution"),
    [string]$StateRoot = (Join-Path $env:ProgramData "ScopeGuard\ManagedExecution"),
    [string]$RegistryRoot = "HKLM:\SOFTWARE\ScopeGuard\ManagedExecution",
    [string]$ServiceName = "ScopeGuardProvisioner",
    [string]$PipeName = "ScopeGuardProvisioner",
    [switch]$AllowUnsignedDevelopmentPackage,
    [ValidateSet("none", "after-payload-commit", "after-service-registration")]
    [string]$FailureInjectionPoint = "none"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "managed-companion-installation.ps1")

Assert-ManagedInstallerElevated
if ($FailureInjectionPoint -cne "none" -and
    $env:SCOPEGUARD_INSTALLER_TEST_MODE -cne "1") {
    throw "Failure injection is available only in installer test mode."
}
if ($WorkspaceId -notmatch '^workspace\.[a-z][a-z0-9-]{0,62}$') {
    throw "WorkspaceId is invalid."
}
if ($ServiceName -notmatch '^ScopeGuardProvisioner[A-Za-z0-9._-]{0,64}$' -or
    $PipeName -notmatch '^ScopeGuard[A-Za-z0-9._-]{1,120}$') {
    throw "ServiceName or PipeName is invalid."
}
if ($RegistryRoot -notmatch '^HKLM:\\SOFTWARE\\ScopeGuard\\[A-Za-z0-9._\\-]+$') {
    throw "RegistryRoot must be below HKLM:\SOFTWARE\ScopeGuard."
}

$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$packageItem = Assert-ManagedNoReparsePoint -Path $PackageRoot -Context "PackageRoot"
if (-not $packageItem.PSIsContainer) { throw "PackageRoot must be a directory." }
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$workspaceItem = Assert-ManagedNoReparsePoint -Path $WorkspaceRoot -Context "WorkspaceRoot"
if (-not $workspaceItem.PSIsContainer) { throw "WorkspaceRoot must be a directory." }
$InstallRoot = Assert-ManagedChildPath `
    -Path $InstallRoot `
    -Parent (Join-Path $env:ProgramFiles "ScopeGuard") `
    -Context "InstallRoot"
$StateRoot = Assert-ManagedChildPath `
    -Path $StateRoot `
    -Parent (Join-Path $env:ProgramData "ScopeGuard") `
    -Context "StateRoot"
if ($PackageRoot.StartsWith("$InstallRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "PackageRoot cannot be inside InstallRoot."
}

$BrokerSid = if ($BrokerSid) {
    $BrokerSid
}
else {
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
if ($BrokerSid -notmatch '^S-1-(?:\d+-){1,14}\d+$') {
    throw "BrokerSid is invalid."
}

$verifierArguments = @("-PackageRoot", $PackageRoot)
if (-not $AllowUnsignedDevelopmentPackage) {
    $verifierArguments += "-RequireTrustedSignature"
}
& (Join-Path $PSScriptRoot "verify-managed-companion.ps1") @verifierArguments | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Source companion package verification failed." }

$manifestPath = Join-Path $PackageRoot "managed-companion-manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 12
$transactionId = [guid]::NewGuid().ToString("N")
$stageRoot = "$InstallRoot.staging.$transactionId"
$backupRoot = "$InstallRoot.rollback.$transactionId"
$configRoot = Join-Path $StateRoot "config"
$executionStateRoot = Join-Path $StateRoot "executions"
$requestRoot = Join-Path $StateRoot "requests"
$diagnosticsRoot = Join-Path $StateRoot "diagnostics"
$registryPath = Join-Path $configRoot "provisioner-registry.json"
$machineConfigPath = Join-Path $configRoot "machine-installation.json"
$diagnosticsPath = Join-Path $diagnosticsRoot "provisioner-service.log"
$stateExisted = Test-Path -LiteralPath $StateRoot
$installExisted = Test-Path -LiteralPath $InstallRoot
$registrySnapshot = Get-ManagedRegistrySnapshot -Path $RegistryRoot
$registryBackup = Get-ManagedFileBackup -Path $registryPath
$machineConfigBackup = Get-ManagedFileBackup -Path $machineConfigPath
$existingService = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
$existingServicePath = if ($existingService) { $existingService.PathName } else { $null }
$existingServiceStartMode = if ($existingService) { $existingService.StartMode } else { $null }
$existingServiceWasRunning = $existingService -and $existingService.State -eq "Running"
$payloadCommitted = $false
$newServiceRegistered = $false

try {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    Copy-ManagedDirectoryContents -Source $PackageRoot -Destination $stageRoot
    Set-ManagedInstallAcl -Path $stageRoot
    & (Join-Path $PSScriptRoot "verify-managed-companion.ps1") `
        -PackageRoot $stageRoot | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Staged companion package verification failed." }

    # Quiesce the old service before changing its pinned registry or payload.
    if ($existingService) {
        Remove-ManagedService -Name $ServiceName
    }

    New-Item -ItemType Directory -Path @(
        $configRoot,
        $executionStateRoot,
        $requestRoot,
        $diagnosticsRoot
    ) -Force | Out-Null
    Set-ManagedStateAcl -Path $StateRoot

    $runtimeRoot = Join-Path $InstallRoot "payload\runtimes\node"
    $runtimeManifestPath = Join-Path $InstallRoot "payload\metadata\node-runtime.json"
    $stagedRuntimeManifest = Join-Path $stageRoot "payload\metadata\node-runtime.json"
    Write-ManagedUtf8Json -Path $registryPath -Value ([ordered]@{
        schemaVersion = 1
        workspaces = @([ordered]@{ id = $WorkspaceId; root = $WorkspaceRoot })
        runtimes = @([ordered]@{
            id = "scopeguard.node"
            packRoot = $runtimeRoot
            manifestPath = $runtimeManifestPath
            manifestSha256 = Get-ManagedSha256 -Path $stagedRuntimeManifest
        })
    })
    Write-ManagedUtf8Json -Path $machineConfigPath -Value ([ordered]@{
        schemaVersion = 1
        component = "scopeguard-managed-execution"
        version = $manifest.version
        contentDigest = $manifest.contentDigest
        installRoot = $InstallRoot
        stateRoot = $StateRoot
        serviceName = $ServiceName
        pipeName = $PipeName
        brokerSid = $BrokerSid
        serviceClient = "payload/bin/scopeguard-provisioner-service.exe"
        launcher = "payload/bin/scopeguard-appcontainer.exe"
        lifetimeBroker = "payload/bin/scopeguard-lifetime-broker.exe"
        runtimeId = "scopeguard.node"
        workspaces = @([ordered]@{ id = $WorkspaceId; root = $WorkspaceRoot })
    })
    Set-ManagedStateAcl -Path $StateRoot

    if ($installExisted) {
        Move-Item -LiteralPath $InstallRoot -Destination $backupRoot
    }
    Move-Item -LiteralPath $stageRoot -Destination $InstallRoot
    $payloadCommitted = $true
    if ($FailureInjectionPoint -ceq "after-payload-commit") {
        throw "Injected failure after payload commit."
    }

    $serviceExe = Join-Path $InstallRoot "payload\bin\scopeguard-provisioner-service.exe"
    $launcher = Join-Path $InstallRoot "payload\bin\scopeguard-appcontainer.exe"
    $pwsh = Join-Path $InstallRoot "payload\runtimes\powershell\pwsh.exe"
    $worker = Join-Path $InstallRoot "payload\scripts\provisioner-service-worker.ps1"
    $provisioner = Join-Path $InstallRoot "payload\scripts\provisioner.ps1"
    $lifecycle = Join-Path $InstallRoot "payload\scripts\lifecycle.ps1"
    $runtimePack = Join-Path $InstallRoot "payload\scripts\runtime-pack.ps1"
    $hashes = [ordered]@{
        broker = Get-ManagedSha256 -Path $serviceExe
        pwsh = Get-ManagedSha256 -Path $pwsh
        worker = Get-ManagedSha256 -Path $worker
        provisioner = Get-ManagedSha256 -Path $provisioner
        lifecycle = Get-ManagedSha256 -Path $lifecycle
        runtimePack = Get-ManagedSha256 -Path $runtimePack
        registry = Get-ManagedSha256 -Path $registryPath
        launcher = Get-ManagedSha256 -Path $launcher
    }
    $serviceArguments = @(
        "--service",
        "--service-name", $ServiceName,
        "--pipe", $PipeName,
        "--broker-sid", $BrokerSid,
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
        "--state-root", $executionStateRoot,
        "--request-root", $requestRoot,
        "--launcher", $launcher,
        "--launcher-sha256", $hashes.launcher,
        "--diagnostics", $diagnosticsPath
    )
    $binaryPath = (Quote-ManagedServiceArgument -Value $serviceExe) + " " +
        (($serviceArguments | ForEach-Object {
            Quote-ManagedServiceArgument -Value $_
        }) -join " ")
    New-Service `
        -Name $ServiceName `
        -BinaryPathName $binaryPath `
        -StartupType Automatic `
        -Description "ScopeGuard managed execution ACL Provisioner" | Out-Null
    $newServiceRegistered = $true
    if ($FailureInjectionPoint -ceq "after-service-registration") {
        throw "Injected failure after service registration."
    }

    New-Item -Path $RegistryRoot -Force | Out-Null
    $registryValues = [ordered]@{
        Component = "scopeguard-managed-execution"
        Version = $manifest.version
        ContentDigest = $manifest.contentDigest
        InstallRoot = $InstallRoot
        StateRoot = $StateRoot
        ManifestPath = Join-Path $InstallRoot "managed-companion-manifest.json"
        MachineConfigurationPath = $machineConfigPath
        ServiceName = $ServiceName
        PipeName = $PipeName
    }
    foreach ($entry in $registryValues.GetEnumerator()) {
        Set-ItemProperty `
            -LiteralPath $RegistryRoot `
            -Name $entry.Key `
            -Value $entry.Value
    }

    Start-Service -Name $ServiceName
    Wait-ManagedServiceState -Name $ServiceName -State "Running"
    $serviceCim = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($serviceCim.StartName -cne "LocalSystem" -or $serviceCim.State -cne "Running") {
        throw "Provisioner service identity or state is invalid after installation."
    }
    Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue

    [pscustomobject][ordered]@{
        schemaVersion = 1
        status = if ($installExisted) { "repaired" } else { "installed" }
        version = $manifest.version
        contentDigest = $manifest.contentDigest
        installRoot = $InstallRoot
        stateRoot = $StateRoot
        registryRoot = $RegistryRoot
        serviceName = $ServiceName
        pipeName = $PipeName
        workspaceId = $WorkspaceId
        workspaceRoot = $WorkspaceRoot
        releaseSignaturesRequired = -not [bool]$AllowUnsignedDevelopmentPackage
    } | ConvertTo-Json -Depth 4
}
catch {
    $failure = $_
    try {
        if ($newServiceRegistered -or (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
            Remove-ManagedService -Name $ServiceName
        }
        if ($payloadCommitted -and (Test-Path -LiteralPath $InstallRoot)) {
            Remove-Item -LiteralPath $InstallRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $backupRoot) {
            Move-Item -LiteralPath $backupRoot -Destination $InstallRoot
        }
        Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
        Restore-ManagedFileBackup -Path $registryPath -Bytes $registryBackup
        Restore-ManagedFileBackup -Path $machineConfigPath -Bytes $machineConfigBackup
        Restore-ManagedRegistrySnapshot -Path $RegistryRoot -Snapshot $registrySnapshot
        if (-not $stateExisted -and (Test-Path -LiteralPath $StateRoot)) {
            Remove-Item -LiteralPath $StateRoot -Recurse -Force
        }
        if ($existingServicePath) {
            $startupType = if ($existingServiceStartMode -ceq "Auto") {
                "Automatic"
            }
            elseif ($existingServiceStartMode -ceq "Disabled") {
                "Disabled"
            }
            else { "Manual" }
            New-Service `
                -Name $ServiceName `
                -BinaryPathName $existingServicePath `
                -StartupType $startupType `
                -Description "ScopeGuard managed execution ACL Provisioner" | Out-Null
            if ($existingServiceWasRunning) {
                Start-Service -Name $ServiceName
                Wait-ManagedServiceState -Name $ServiceName -State "Running"
            }
        }
    }
    catch {
        throw "Installation failed and rollback also failed: $($failure.Exception.Message); $($_.Exception.Message)"
    }
    throw $failure
}
