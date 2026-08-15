[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AllowedPath,

    [Parameter(Mandatory = $true)]
    [string]$DeniedPath,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath
)

$ErrorActionPreference = "Stop"

Set-Content -LiteralPath $AllowedPath -Value "powershell-script-ok" -Encoding utf8

$outsideWriteDenied = $false
$outsideWriteDetail = "write unexpectedly succeeded"
try {
    Set-Content -LiteralPath $DeniedPath -Value "blocked" -Encoding utf8
}
catch {
    $outsideWriteDenied = $true
    $outsideWriteDetail = $_.Exception.Message
}

$passed = $outsideWriteDenied -and -not (Test-Path Env:SCOPEGUARD_SECRET_SENTINEL)
@{
    kind = "powershell-script"
    passed = $passed
    outsideWriteDenied = $outsideWriteDenied
    outsideWriteDetail = $outsideWriteDetail
    parentSecretInherited = Test-Path Env:SCOPEGUARD_SECRET_SENTINEL
} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding utf8

if (-not $passed) {
    exit 1
}
