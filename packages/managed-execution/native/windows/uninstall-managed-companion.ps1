[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles "ScopeGuard\ManagedExecution"),
    [string]$StateRoot = (Join-Path $env:ProgramData "ScopeGuard\ManagedExecution"),
    [string]$RegistryRoot = "HKLM:\SOFTWARE\ScopeGuard\ManagedExecution",
    [string]$ServiceName = "ScopeGuardProvisioner",
    [switch]$PurgeCleanState
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "managed-companion-installation.ps1")

Assert-ManagedInstallerElevated
$InstallRoot = Assert-ManagedChildPath `
    -Path $InstallRoot `
    -Parent (Join-Path $env:ProgramFiles "ScopeGuard") `
    -Context "InstallRoot"
$StateRoot = Assert-ManagedChildPath `
    -Path $StateRoot `
    -Parent (Join-Path $env:ProgramData "ScopeGuard") `
    -Context "StateRoot"
Assert-ManagedExistingDirectoryNotReparse `
    -Path (Join-Path $env:ProgramFiles "ScopeGuard") `
    -Context "Install parent"
Assert-ManagedExistingDirectoryNotReparse `
    -Path (Join-Path $env:ProgramData "ScopeGuard") `
    -Context "State parent"
Assert-ManagedExistingDirectoryNotReparse -Path $InstallRoot -Context "InstallRoot"
Assert-ManagedExistingDirectoryNotReparse -Path $StateRoot -Context "StateRoot"
if ($RegistryRoot -notmatch '^HKLM:\\SOFTWARE\\ScopeGuard\\[A-Za-z0-9._\\-]+$' -or
    $ServiceName -notmatch '^ScopeGuardProvisioner[A-Za-z0-9._-]{0,64}$') {
    throw "RegistryRoot or ServiceName is invalid."
}

$registered = Get-ManagedRegistrySnapshot -Path $RegistryRoot
if ($registered) {
    if ($registered.Component -cne "scopeguard-managed-execution" -or
        (Get-NormalizedPath -Path $registered.InstallRoot) -ine $InstallRoot -or
        (Get-NormalizedPath -Path $registered.StateRoot) -ine $StateRoot -or
        $registered.ServiceName -ine $ServiceName) {
        throw "Registered installation identity does not match the requested uninstall target."
    }
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
    Start-Service -Name $ServiceName
    Wait-ManagedServiceState -Name $ServiceName -State "Running"
}
$executionStateRoot = Join-Path $StateRoot "executions"
$stateClean = Test-ManagedStateClean -ExecutionStateRoot $executionStateRoot
if ($PurgeCleanState -and -not $stateClean) {
    throw "Managed state is not fully cleaned; installation was preserved."
}
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Remove-ManagedService -Name $ServiceName
}
if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
Remove-Item -LiteralPath $RegistryRoot -Recurse -Force -ErrorAction SilentlyContinue
if ($PurgeCleanState) {
    Remove-Item -LiteralPath $StateRoot -Recurse -Force -ErrorAction SilentlyContinue
}

[pscustomobject][ordered]@{
    schemaVersion = 1
    status = "uninstalled"
    serviceRemoved = -not [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    installRootRemoved = -not (Test-Path -LiteralPath $InstallRoot)
    registryRemoved = -not (Test-Path -LiteralPath $RegistryRoot)
    stateWasClean = $stateClean
    stateRemoved = -not (Test-Path -LiteralPath $StateRoot)
} | ConvertTo-Json -Depth 3
