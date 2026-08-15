[CmdletBinding()]
param(
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "Sandbox lifecycle recovery tests must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "lifecycle.ps1")

function Add-LifecycleCheck {
    param(
        [System.Collections.Generic.List[object]]$Checks,
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )

    $Checks.Add([ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Start-PowerShellScript {
    param(
        [Parameter(Mandatory)]
        [string]$Script,
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.ArgumentList.Add("-NoLogo")
    $startInfo.ArgumentList.Add("-NoProfile")
    $startInfo.ArgumentList.Add("-NonInteractive")
    $startInfo.ArgumentList.Add("-File")
    $startInfo.ArgumentList.Add($Script)
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start PowerShell lifecycle test process."
    }
    if (-not $process.WaitForExit(120000)) {
        $process.Kill($true)
        $process.WaitForExit()
        return 125
    }
    return $process.ExitCode
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-lifecycle-recovery-fixture"
$targetRoot = Join-Path $fixtureRoot "acl-target"
$targetChild = Join-Path $targetRoot "child.txt"
$ledgerPath = Join-Path $fixtureRoot "lifecycle-ledger.json"
$readyPath = Join-Path $fixtureRoot "provisioned.txt"
$firstRecoveryPath = Join-Path $fixtureRoot "recovery-first.json"
$secondRecoveryPath = Join-Path $fixtureRoot "recovery-second.json"
$resultPath = Join-Path $fixtureRoot "result.json"
$profileName = "ScopeGuardRecovery_$([guid]::NewGuid().ToString('N'))"
$launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
Set-Content -LiteralPath $targetChild -Value "acl-recovery" -Encoding utf8
$checks = [System.Collections.Generic.List[object]]::new()
$cleanupPassed = $false

try {
    $crashExit = Start-PowerShellScript `
        -Script (Join-Path $PSScriptRoot "lifecycle-crash-probe.ps1") `
        -Arguments @(
            "-Launcher", $launcher,
            "-LedgerPath", $ledgerPath,
            "-TargetRoot", $targetRoot,
            "-ReadyPath", $readyPath,
            "-ProfileName", $profileName
        )
    Add-LifecycleCheck -Checks $checks -Name "host-crash-bypasses-finally" -Passed (
        $crashExit -eq 86 -and (Test-Path -LiteralPath $readyPath)
    ) -Detail "exit=$crashExit"

    $ledger = Read-SandboxLifecycleLedger -Path $ledgerPath
    $aclPresentBeforeRecovery = -not (Test-SandboxSidAceAbsent `
        -Path $targetRoot `
        -PackageSid $ledger.packageSid `
        -Recursive $true)
    Add-LifecycleCheck -Checks $checks -Name "crash-leaves-recoverable-ledger" -Passed (
        $ledger.state -eq "provisioning" -and
        @($ledger.aclGrants).Count -eq 1 -and
        $aclPresentBeforeRecovery -and
        (Test-Path -LiteralPath $ledger.profilePath)
    ) -Detail "state=$($ledger.state); sid=$($ledger.packageSid)"

    $firstRecoveryExit = Start-PowerShellScript `
        -Script (Join-Path $PSScriptRoot "recover.ps1") `
        -Arguments @(
            "-LedgerPath", $ledgerPath,
            "-Launcher", $launcher,
            "-ResultPath", $firstRecoveryPath
        )
    $firstRecovery = Get-Content -LiteralPath $firstRecoveryPath -Raw | ConvertFrom-Json
    $aclAbsentAfterRecovery = Test-SandboxSidAceAbsent `
        -Path $targetRoot `
        -PackageSid $ledger.packageSid `
        -Recursive $true
    Add-LifecycleCheck -Checks $checks -Name "recovery-removes-acl-and-profile" -Passed (
        $firstRecoveryExit -eq 0 -and
        $firstRecovery.passed -and
        $aclAbsentAfterRecovery -and
        -not (Test-Path -LiteralPath $ledger.profilePath)
    ) -Detail "exit=$firstRecoveryExit; state=$($firstRecovery.state)"

    $secondRecoveryExit = Start-PowerShellScript `
        -Script (Join-Path $PSScriptRoot "recover.ps1") `
        -Arguments @(
            "-LedgerPath", $ledgerPath,
            "-Launcher", $launcher,
            "-ResultPath", $secondRecoveryPath
        )
    $secondRecovery = Get-Content -LiteralPath $secondRecoveryPath -Raw | ConvertFrom-Json
    Add-LifecycleCheck -Checks $checks -Name "recovery-is-idempotent" -Passed (
        $secondRecoveryExit -eq 0 -and
        $secondRecovery.passed -and
        $secondRecovery.state -eq "cleaned" -and
        $secondRecovery.cleanupAttempts -eq 2
    ) -Detail "exit=$secondRecoveryExit; attempts=$($secondRecovery.cleanupAttempts)"

    $failedChecks = @($checks | Where-Object { -not $_.passed })
    $summary = [ordered]@{
        passed = $failedChecks.Count -eq 0
        windows = [Environment]::OSVersion.VersionString
        checks = $checks
    }
    $summary | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath $resultPath -Encoding utf8
    $summary | ConvertTo-Json -Depth 12
    $cleanupPassed = $summary.passed
    if (-not $summary.passed) {
        throw "$($failedChecks.Count) lifecycle recovery checks failed. See $resultPath."
    }
}
finally {
    if (Test-Path -LiteralPath $ledgerPath) {
        try {
            Invoke-SandboxLifecycleRecovery `
                -LedgerPath $ledgerPath `
                -Launcher $launcher | Out-Null
        }
        catch {
            Write-Warning "Final lifecycle recovery attempt failed: $_"
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
