[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LedgerPath,
    [string]$Launcher,
    [string]$ResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "Sandbox lifecycle recovery must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "lifecycle.ps1")

if (-not $Launcher) {
    $Launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()
}

$result = Invoke-SandboxLifecycleRecovery `
    -LedgerPath $LedgerPath `
    -Launcher $Launcher

if ($ResultPath) {
    $result | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath $ResultPath -Encoding utf8
}
$result | ConvertTo-Json -Depth 12
if (-not $result.passed) {
    throw "Sandbox lifecycle recovery failed. See $LedgerPath."
}
