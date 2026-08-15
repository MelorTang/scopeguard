[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Launcher,
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)][string]$ExecutionId,
    [Parameter(Mandatory)][string]$RequestSha256,
    [Parameter(Mandatory)][string]$ReadyPath,
    [Parameter(Mandatory)]
    [ValidateSet(
        "after-intent",
        "after-profile",
        "after-profile-recorded",
        "after-ledger"
    )]
    [string]$CrashPoint
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "provisioner.ps1")

Assert-ProvisionerElevated
$paths = Get-ProvisionerExecutionPaths `
    -StateRoot $StateRoot `
    -ExecutionId $ExecutionId
$profileName = "ScopeGuardExec_$ExecutionId"
$request = [pscustomobject][ordered]@{
    executionId = $ExecutionId
    payloadSha256 = $RequestSha256
}
$null = New-ProvisionerIntent `
    -Path $paths.intentPath `
    -Request $request `
    -ProfileName $profileName

$packageSid = ""
$profilePath = ""

if ($CrashPoint -ne "after-intent") {
    $packageSid = (& $Launcher profile --name $profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
        throw "Crash probe could not create the Profile."
    }
    $profilePath = (& $Launcher profile-path --name $profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
        throw "Crash probe could not derive the Profile path."
    }
    New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
    Set-Content `
        -LiteralPath (Join-Path $profilePath "intent-crash-sentinel.txt") `
        -Value $CrashPoint `
        -Encoding utf8
}

if ($CrashPoint -in @("after-profile-recorded", "after-ledger")) {
    $null = Set-ProvisionerIntentProfileCreated `
        -Path $paths.intentPath `
        -ExecutionId $ExecutionId `
        -PackageSid $packageSid `
        -ProfilePath $profilePath
}

if ($CrashPoint -eq "after-ledger") {
    $ledger = New-SandboxLifecycleLedger `
        -Path $paths.ledgerPath `
        -ProfileName $profileName `
        -PackageSid $packageSid `
        -ProfilePath $profilePath
    $ledger | Add-Member -NotePropertyName executionId -NotePropertyValue $ExecutionId
    $ledger | Add-Member `
        -NotePropertyName prepareRequestSha256 `
        -NotePropertyValue $RequestSha256
    Write-SandboxLifecycleLedger -Path $paths.ledgerPath -Ledger $ledger
}

[pscustomobject][ordered]@{
    crashPoint = $CrashPoint
    executionId = $ExecutionId
    profileName = $profileName
    packageSid = $packageSid
    profilePath = $profilePath
    intentPath = $paths.intentPath
    ledgerPath = $paths.ledgerPath
    intentState = if ($CrashPoint -in @("after-profile-recorded", "after-ledger")) {
        "profile-created"
    }
    else {
        "profile-creation-planned"
    }
} | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath $ReadyPath -Encoding utf8

$exitCode = switch ($CrashPoint) {
    "after-intent" { 91 }
    "after-profile" { 92 }
    "after-profile-recorded" { 93 }
    "after-ledger" { 94 }
}
[Environment]::Exit($exitCode)
