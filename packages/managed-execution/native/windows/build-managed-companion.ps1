[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "release"),
    [string]$NodePath,
    [string]$PowerShellPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The managed execution companion package must be built on Windows."
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
    [Runtime.InteropServices.Architecture]::X64) {
    throw "Only the Windows x64 managed execution package is supported."
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    [IO.File]::WriteAllText(
        $Path,
        ($Value | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
    )
}

function Get-RelativePackagePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path
    )

    return [IO.Path]::GetRelativePath($Root, $Path).Replace('\', '/')
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
$packageVersion = (
    Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw |
        ConvertFrom-Json
).version
if ($packageVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw "The repository package version is invalid."
}

$NodePath = if ($NodePath) {
    (Resolve-Path -LiteralPath $NodePath).Path
}
else {
    (Get-Command node.exe -ErrorAction Stop).Source
}
$PowerShellPath = if ($PowerShellPath) {
    (Resolve-Path -LiteralPath $PowerShellPath).Path
}
else {
    (Get-Command pwsh.exe -ErrorAction Stop).Source
}
if ([IO.Path]::GetFileName($NodePath) -cne "node.exe") {
    throw "NodePath must identify node.exe."
}
if ([IO.Path]::GetFileName($PowerShellPath) -cne "pwsh.exe") {
    throw "PowerShellPath must identify pwsh.exe."
}

$packageName = "ScopeGuard-ManagedExecution-$packageVersion-windows-x64"
$packageRoot = Join-Path $OutputDirectory $packageName
$payloadRoot = Join-Path $packageRoot "payload"
$binRoot = Join-Path $payloadRoot "bin"
$scriptsRoot = Join-Path $payloadRoot "scripts"
$nodeRoot = Join-Path $payloadRoot "runtimes\node"
$powershellRoot = Join-Path $payloadRoot "runtimes\powershell"
$metadataRoot = Join-Path $payloadRoot "metadata"
$manifestPath = Join-Path $packageRoot "managed-companion-manifest.json"
$archivePath = Join-Path $OutputDirectory "$packageName.zip"

Remove-Item -LiteralPath $packageRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path @(
    $binRoot,
    $scriptsRoot,
    $nodeRoot,
    $powershellRoot,
    $metadataRoot
) -Force | Out-Null

$launcher = (& (Join-Path $PSScriptRoot "build.ps1") -OutputDirectory $binRoot).Trim()
$service = (& (Join-Path $PSScriptRoot "build-provisioner-service.ps1") -OutputDirectory $binRoot).Trim()
$lifetimeBroker = (& (Join-Path $PSScriptRoot "build-lifetime-broker.ps1") -OutputDirectory $binRoot).Trim()

foreach ($scriptName in @(
    "provisioner-service-worker.ps1",
    "provisioner.ps1",
    "lifecycle.ps1",
    "runtime-pack.ps1"
)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Destination $scriptsRoot
}
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $nodeRoot "node.exe")
$sourcePowerShellRoot = Split-Path -Parent $PowerShellPath
foreach ($item in Get-ChildItem -LiteralPath $sourcePowerShellRoot -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $powershellRoot -Recurse
}

$packagedPowerShell = Join-Path $powershellRoot "pwsh.exe"
if (-not (Test-Path -LiteralPath $packagedPowerShell -PathType Leaf)) {
    throw "The packaged PowerShell runtime does not contain pwsh.exe."
}

$packagedNode = Join-Path $nodeRoot "node.exe"
$nodeVersion = (& $packagedNode --version).TrimStart('v')
$powershellVersion = (& $packagedPowerShell -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()').Trim()
$nodeRuntimeManifestPath = Join-Path $metadataRoot "node-runtime.json"
Write-Utf8Json -Path $nodeRuntimeManifestPath -Value ([ordered]@{
    schemaVersion = 1
    runtimeId = "scopeguard.node"
    version = $nodeVersion
    architecture = "x64"
    executable = "node.exe"
    capabilities = @("registryRead")
    files = @([ordered]@{
        path = "node.exe"
        size = (Get-Item -LiteralPath $packagedNode).Length
        sha256 = Get-Sha256 -Path $packagedNode
    })
})

$payloadFiles = @(
    Get-ChildItem -LiteralPath $payloadRoot -File -Recurse -Force |
        Sort-Object FullName
)
$files = @($payloadFiles | ForEach-Object {
    [ordered]@{
        path = Get-RelativePackagePath -Root $packageRoot -Path $_.FullName
        size = $_.Length
        sha256 = Get-Sha256 -Path $_.FullName
    }
})
$contentIndex = ($files | ForEach-Object {
    "$($_.path)`0$($_.size)`0$($_.sha256)"
}) -join "`n"
$contentDigest = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($contentIndex))
).ToLowerInvariant()

Write-Utf8Json -Path $manifestPath -Value ([ordered]@{
    schemaVersion = 1
    component = "scopeguard-managed-execution"
    version = $packageVersion
    platform = "windows"
    architecture = "x64"
    layout = [ordered]@{
        installRoot = "%ProgramFiles%\ScopeGuard\ManagedExecution"
        stateRoot = "%ProgramData%\ScopeGuard\ManagedExecution"
        installRootOwner = "installer-administrators"
        desktopAccess = "read-execute"
        desktopWriteAllowed = $false
        serviceIdentity = "LocalSystem"
    }
    entrypoints = [ordered]@{
        service = "payload/bin/scopeguard-provisioner-service.exe"
        serviceClient = "payload/bin/scopeguard-provisioner-service.exe"
        launcher = "payload/bin/scopeguard-appcontainer.exe"
        lifetimeBroker = "payload/bin/scopeguard-lifetime-broker.exe"
        powershell = "payload/runtimes/powershell/pwsh.exe"
        worker = "payload/scripts/provisioner-service-worker.ps1"
        provisioner = "payload/scripts/provisioner.ps1"
        lifecycle = "payload/scripts/lifecycle.ps1"
        runtimePackVerifier = "payload/scripts/runtime-pack.ps1"
    }
    runtimes = @([ordered]@{
        id = "scopeguard.node"
        root = "payload/runtimes/node"
        manifest = "payload/metadata/node-runtime.json"
        version = $nodeVersion
        capabilities = @("registryRead")
    }, [ordered]@{
        id = "scopeguard.provisioner-powershell"
        root = "payload/runtimes/powershell"
        executable = "payload/runtimes/powershell/pwsh.exe"
        version = $powershellVersion
        capabilities = @()
    })
    releasePolicy = [ordered]@{
        authenticodeRequired = $true
        signedInstallerRequired = $true
        unsignedDevelopmentArtifact = $true
    }
    contentDigest = $contentDigest
    files = $files
})

& (Join-Path $PSScriptRoot "verify-managed-companion.ps1") -PackageRoot $packageRoot
if ($LASTEXITCODE -ne 0) {
    throw "Managed companion staging verification failed."
}

Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
$archiveHash = Get-Sha256 -Path $archivePath
[pscustomobject][ordered]@{
    schemaVersion = 1
    packageRoot = $packageRoot
    archivePath = $archivePath
    archiveSha256 = $archiveHash
    contentDigest = $contentDigest
    payloadFileCount = $files.Count
    payloadBytes = ($files | Measure-Object size -Sum).Sum
    nativeEntrypoints = @($service, $launcher, $lifetimeBroker)
    nodeVersion = $nodeVersion
    powershellVersion = $powershellVersion
    releaseSignaturesVerified = $false
} | ConvertTo-Json -Depth 5
