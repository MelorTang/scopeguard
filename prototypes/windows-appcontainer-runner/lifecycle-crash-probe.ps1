[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Launcher,
    [Parameter(Mandatory)]
    [string]$LedgerPath,
    [Parameter(Mandatory)]
    [string]$TargetRoot,
    [Parameter(Mandatory)]
    [string]$ReadyPath,
    [Parameter(Mandatory)]
    [string]$ProfileName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lifecycle.ps1")

$packageSid = (& $Launcher profile --name $ProfileName).Trim()
if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
    throw "Failed to create the recovery-test AppContainer profile."
}
$profilePath = (& $Launcher profile-path --name $ProfileName).Trim()
if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
    throw "Failed to resolve the recovery-test AppContainer profile path."
}

New-SandboxLifecycleLedger `
    -Path $LedgerPath `
    -ProfileName $ProfileName `
    -PackageSid $packageSid `
    -ProfilePath $profilePath | Out-Null
New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
Set-Content `
    -LiteralPath (Join-Path $profilePath "scopeguard-recovery-sentinel.txt") `
    -Value "profile-must-be-removed" `
    -Encoding utf8
Grant-SandboxAcl `
    -LedgerPath $LedgerPath `
    -Path $TargetRoot `
    -Grant "(OI)(CI)(RX)" `
    -Recursive
Set-Content -LiteralPath $ReadyPath -Value "provisioned" -Encoding ascii

# Exit without stack unwinding to simulate a broker host crash after provisioning.
[Environment]::Exit(86)
