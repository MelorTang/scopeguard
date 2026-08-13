[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,

    [Parameter(Mandatory = $true)]
    [string]$OutsideDirectory,

    [Parameter(Mandatory = $true)]
    [string]$OutsideSecret,

    [Parameter(Mandatory = $true)]
    [string]$HardLinkPath,

    [Parameter(Mandatory = $true)]
    [string]$CredentialTarget,

    [Parameter(Mandatory = $true)]
    [int]$ProtectedProcessId,

    [Parameter(Mandatory = $true)]
    [int]$LoopbackPort,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )

    $results.Add([ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Test-WriteDenied {
    param(
        [string]$Name,
        [string]$Path
    )

    $errorDetail = "write unexpectedly succeeded"
    try {
        Set-Content -LiteralPath $Path -Value "blocked" -Encoding utf8 -ErrorAction Stop
    }
    catch {
        $errorDetail = $_.Exception.Message
    }

    $pathExists = Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    Add-Result -Name $Name -Passed (-not $pathExists) -Detail $errorDetail
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Add-Result -Name "dedicated-offline-identity" -Passed ($identity -match "\\CodexSandboxOffline$") -Detail $identity

$workspaceInput = Join-Path $Workspace "input.txt"
$workspaceOutput = Join-Path $Workspace "powershell-output.txt"
$inputValue = Get-Content -LiteralPath $workspaceInput -Raw
Set-Content -LiteralPath $workspaceOutput -Value "powershell-ok" -Encoding utf8
Add-Result -Name "workspace-read" -Passed ($inputValue.Trim() -eq "workspace-ok") -Detail $workspaceInput
Add-Result -Name "workspace-write" -Passed (Test-Path -LiteralPath $workspaceOutput) -Detail $workspaceOutput

$outsideVisible = $false
$outsideReadDetail = "read denied"
try {
    $outsideValue = Get-Content -LiteralPath $OutsideSecret -Raw -ErrorAction Stop
    $outsideVisible = $outsideValue -match "scopeguard-outside-secret"
    $outsideReadDetail = "outside sentinel was readable"
}
catch {
    $outsideReadDetail = $_.Exception.Message
}
Add-Result -Name "outside-read-denied" -Passed (-not $outsideVisible) -Detail $outsideReadDetail

Test-WriteDenied -Name "outside-write-denied" -Path (Join-Path $OutsideDirectory "direct-write.txt")
Test-WriteDenied -Name "parent-traversal-denied" -Path (Join-Path $Workspace "..\outside\traversal-write.txt")
Test-WriteDenied -Name "junction-escape-denied" -Path (Join-Path $Workspace "junction-outside\junction-write.txt")

$deviceOutsidePath = "\\?\$OutsideDirectory\device-write.txt"
Test-WriteDenied -Name "device-path-escape-denied" -Path $deviceOutsidePath

$hardLinkWriteFailed = $false
try {
    Set-Content -LiteralPath $HardLinkPath -Value "hardlink-overwrite" -Encoding utf8 -ErrorAction Stop
}
catch {
    $hardLinkWriteFailed = $true
}
Add-Result -Name "hard-link-escape-denied" -Passed $hardLinkWriteFailed -Detail $HardLinkPath

$registryVisible = $false
$registryDetail = "parent HKCU value not visible"
try {
    $registryValue = Get-ItemPropertyValue -Path "HKCU:\Software\ScopeGuardPrototype" -Name "Secret" -ErrorAction Stop
    $registryVisible = $registryValue -eq "scopeguard-registry-secret"
    $registryDetail = "parent HKCU sentinel was visible"
}
catch {
    $registryDetail = $_.Exception.Message
}
Add-Result -Name "parent-registry-isolated" -Passed (-not $registryVisible) -Detail $registryDetail

$credentialListing = (& cmdkey.exe /list 2>&1 | Out-String)
Add-Result -Name "credential-manager-isolated" -Passed (-not $credentialListing.Contains($CredentialTarget)) -Detail "target=$CredentialTarget"

$processTerminationDenied = $false
$processDetail = "termination unexpectedly succeeded"
try {
    Stop-Process -Id $ProtectedProcessId -Force -ErrorAction Stop
}
catch {
    $processTerminationDenied = $true
    $processDetail = $_.Exception.Message
}
Add-Result -Name "parent-process-protected" -Passed $processTerminationDenied -Detail $processDetail

$connected = $false
$networkDetail = "connection denied"
$client = [System.Net.Sockets.TcpClient]::new()
try {
    $connectTask = $client.ConnectAsync("127.0.0.1", $LoopbackPort)
    $connected = $connectTask.Wait(2000) -and $client.Connected
    if ($connected) {
        $networkDetail = "connected to 127.0.0.1:$LoopbackPort"
    }
}
catch {
    $networkDetail = $_.Exception.Message
}
finally {
    $client.Dispose()
}
Add-Result -Name "direct-network-denied" -Passed (-not $connected) -Detail $networkDetail

$nestedOutside = Join-Path $OutsideDirectory "nested-child-write.txt"
$nestedCommand = 'echo nested-child>"{0}"' -f $nestedOutside
& cmd.exe /d /s /c $nestedCommand 2>$null
$nestedExitCode = $LASTEXITCODE
$nestedExists = Test-Path -LiteralPath $nestedOutside -ErrorAction SilentlyContinue
Add-Result -Name "child-process-inherits-boundary" -Passed (-not $nestedExists) -Detail "cmd_exit=$nestedExitCode"

$secretInherited = Test-Path Env:SCOPEGUARD_SECRET_SENTINEL
Add-Result -Name "parent-secret-env-not-inherited" -Passed (-not $secretInherited) -Detail "allowlisted environment"

$failed = @($results | Where-Object { -not $_.passed })
$summary = [ordered]@{
    passed = $failed.Count -eq 0
    identity = $identity
    results = $results
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding utf8

if ($failed.Count -gt 0) {
    exit 1
}
