[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This Provisioner recovery matrix must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "provisioner.ps1")

function Add-RecoveryCheck {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Passed,
        [Parameter(Mandatory)][string]$Detail
    )

    $Checks.Add([pscustomobject][ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Start-CrashProbe {
    param(
        [Parameter(Mandatory)][string]$Script,
        [Parameter(Mandatory)][string]$Launcher,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$ExecutionId,
        [Parameter(Mandatory)][string]$RequestSha256,
        [Parameter(Mandatory)][string]$ReadyPath,
        [Parameter(Mandatory)][string]$CrashPoint
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File", $Script,
        "-Launcher", $Launcher,
        "-StateRoot", $StateRoot,
        "-ExecutionId", $ExecutionId,
        "-RequestSha256", $RequestSha256,
        "-ReadyPath", $ReadyPath,
        "-CrashPoint", $CrashPoint
    )) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start the Provisioner intent crash probe."
    }
    if (-not $process.WaitForExit(120000)) {
        $process.Kill($true)
        $process.WaitForExit()
        return [pscustomobject]@{
            exitCode = 125
            stdout = $process.StandardOutput.ReadToEnd()
            stderr = $process.StandardError.ReadToEnd()
        }
    }
    return [pscustomobject]@{
        exitCode = $process.ExitCode
        stdout = $process.StandardOutput.ReadToEnd()
        stderr = $process.StandardError.ReadToEnd()
    }
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.File]::WriteAllText(
        $Path,
        ($Value | ConvertTo-Json -Depth 12 -Compress),
        [Text.UTF8Encoding]::new($false)
    )
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-provisioner-recovery-fixture"
$stateRoot = Join-Path $fixtureRoot "state"
$badStateRoot = Join-Path $fixtureRoot "bad-state"
$resultPath = Join-Path $fixtureRoot "result.json"
$launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()
$crashScript = Join-Path $PSScriptRoot "provisioner-intent-crash-probe.ps1"
$checks = [System.Collections.Generic.List[object]]::new()
$cleanupPassed = $false

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stateRoot, $badStateRoot -Force | Out-Null

$cases = @(
    [pscustomobject]@{ point = "after-intent"; exit = 91 },
    [pscustomobject]@{ point = "after-profile"; exit = 92 },
    [pscustomobject]@{ point = "after-profile-recorded"; exit = 93 },
    [pscustomobject]@{ point = "after-ledger"; exit = 94 }
)
$caseResults = [System.Collections.Generic.List[object]]::new()

try {
    foreach ($case in $cases) {
        $executionId = [guid]::NewGuid().ToString("N")
        $requestSha256 = [Convert]::ToHexString(
            [Security.Cryptography.SHA256]::HashData(
                [Text.Encoding]::UTF8.GetBytes("request-$executionId")
            )
        ).ToLowerInvariant()
        $readyPath = Join-Path $fixtureRoot "$($case.point)-ready.json"
        $probe = Start-CrashProbe `
            -Script $crashScript `
            -Launcher $launcher `
            -StateRoot $stateRoot `
            -ExecutionId $executionId `
            -RequestSha256 $requestSha256 `
            -ReadyPath $readyPath `
            -CrashPoint $case.point
        if (-not (Test-Path -LiteralPath $readyPath)) {
            throw "Crash probe did not persist its ready record: $($case.point); " +
                "exit=$($probe.exitCode); stderr=$($probe.stderr.Trim())"
        }
        $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
        $caseResults.Add([pscustomobject][ordered]@{
            point = $case.point
            expectedExit = $case.exit
            exitCode = $probe.exitCode
            executionId = $executionId
            requestSha256 = $requestSha256
            profileName = $ready.profileName
            profilePath = $ready.profilePath
            intentPath = $ready.intentPath
            ledgerPath = $ready.ledgerPath
            intentState = $ready.intentState
        })
    }

    Add-RecoveryCheck `
        -Checks $checks `
        -Name "hard-exit-covers-all-preparation-windows" `
        -Passed (@($caseResults | Where-Object { $_.exitCode -ne $_.expectedExit }).Count -eq 0) `
        -Detail (($caseResults | ForEach-Object { "$($_.point)=$($_.exitCode)" }) -join ';')
    $durableStatesCorrect = $true
    foreach ($case in $caseResults) {
        $hasIntent = Test-Path -LiteralPath $case.intentPath
        $hasLedger = Test-Path -LiteralPath $case.ledgerPath
        $profileExists = $case.profilePath -and
            (Test-Path -LiteralPath $case.profilePath)
        $expectedIntentState = if ($case.point -in @(
            "after-profile-recorded",
            "after-ledger"
        )) {
            "profile-created"
        }
        else {
            "profile-creation-planned"
        }
        if (-not $hasIntent -or
            $case.intentState -cne $expectedIntentState -or
            ($case.point -eq "after-intent" -and ($hasLedger -or $profileExists)) -or
            ($case.point -in @("after-profile", "after-profile-recorded") -and
                ($hasLedger -or -not $profileExists)) -or
            ($case.point -eq "after-ledger" -and (-not $hasLedger -or -not $profileExists))) {
            $durableStatesCorrect = $false
        }
    }
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "crash-leaves-unambiguous-durable-state" `
        -Passed $durableStatesCorrect `
        -Detail "intent-only planned/created and intent-plus-ledger observed"

    $firstRecovery = Invoke-ProvisionerStartupRecovery `
        -StateRoot $stateRoot `
        -Launcher $launcher
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "startup-recovers-every-crash-window" `
        -Passed (
            $firstRecovery.passed -and
            @($firstRecovery.recovered).Count -eq 4 -and
            @($firstRecovery.recovered | Where-Object profilePathExists).Count -eq 0
        ) `
        -Detail (($firstRecovery.recovered | ForEach-Object {
            "$($_.executionId):$($_.action)"
        }) -join ';')

    $intentOnlyCases = @($caseResults | Where-Object point -NE "after-ledger")
    $intentOnlyRecovered = $true
    foreach ($case in $intentOnlyCases) {
        $paths = Get-ProvisionerExecutionPaths `
            -StateRoot $stateRoot `
            -ExecutionId $case.executionId
        if ((Test-Path -LiteralPath $paths.intentPath) -or
            -not (Test-Path -LiteralPath $paths.tombstonePath) -or
            (Test-Path -LiteralPath $case.profilePath)) {
            $intentOnlyRecovered = $false
        }
    }
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "intent-only-recovery-writes-tombstones" `
        -Passed $intentOnlyRecovered `
        -Detail "intent removed; derived Profile absent; tombstone retained"

    $ledgerCase = @($caseResults | Where-Object point -EQ "after-ledger")[0]
    $ledger = Read-SandboxLifecycleLedger -Path $ledgerCase.ledgerPath
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "intent-plus-ledger-uses-lifecycle-recovery" `
        -Passed (
            $ledger.state -eq "cleaned" -and
            $ledger.cleanupAttempts -eq 1 -and
            @($ledger.lastCleanupErrors).Count -eq 0 -and
            -not (Test-Path -LiteralPath $ledgerCase.intentPath) -and
            -not (Test-Path -LiteralPath $ledgerCase.profilePath)
        ) `
        -Detail "state=$($ledger.state); attempts=$($ledger.cleanupAttempts)"

    $secondRecovery = Invoke-ProvisionerStartupRecovery `
        -StateRoot $stateRoot `
        -Launcher $launcher
    $ledgerAgain = Read-SandboxLifecycleLedger -Path $ledgerCase.ledgerPath
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "startup-recovery-is-idempotent" `
        -Passed (
            $secondRecovery.passed -and
            @($secondRecovery.recovered | Where-Object action -EQ "tombstone-retained").Count -eq 3 -and
            @($secondRecovery.recovered | Where-Object action -EQ "ledger-already-cleaned").Count -eq 1 -and
            $ledgerAgain.cleanupAttempts -eq 1
        ) `
        -Detail "ledgerAttempts=$($ledgerAgain.cleanupAttempts)"

    $replayCase = $intentOnlyCases[0]
    $replayRequest = [pscustomobject][ordered]@{
        operation = "prepare"
        executionId = $replayCase.executionId
        payloadSha256 = $replayCase.requestSha256
    }
    try {
        $null = Invoke-ProvisionerPrepare `
            -Request $replayRequest `
            -RegistryPath (Join-Path $fixtureRoot "unused-registry.json") `
            -StateRoot $stateRoot `
            -Launcher $launcher
        $replayRejected = $false
        $replayDetail = "replay was unexpectedly accepted"
    }
    catch {
        $replayDetail = $_.Exception.Message
        $replayRejected = $replayDetail -match "has been recovered"
    }
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "recovered-execution-cannot-be-replayed" `
        -Passed $replayRejected `
        -Detail $replayDetail

    $badExecutionId = [guid]::NewGuid().ToString("N")
    $badProfileName = "ScopeGuardExec_$badExecutionId"
    $badProfileSid = (& $launcher profile --name $badProfileName).Trim()
    $badProfilePath = (& $launcher profile-path --name $badProfileName).Trim()
    New-Item -ItemType Directory -Path $badProfilePath -Force | Out-Null
    $badPaths = Get-ProvisionerExecutionPaths `
        -StateRoot $badStateRoot `
        -ExecutionId $badExecutionId
    Write-Utf8Json -Path $badPaths.intentPath -Value ([ordered]@{
        schemaVersion = 1
        state = "profile-created"
        executionId = $badExecutionId
        prepareRequestSha256 = ("0" * 64)
        profileName = "ScopeGuardExec_00000000000000000000000000000000"
        packageSid = $badProfileSid
        profilePath = $badProfilePath
        createdAtUtc = [DateTime]::UtcNow.ToString("O")
        updatedAtUtc = [DateTime]::UtcNow.ToString("O")
    })
    $badRecovery = Invoke-ProvisionerStartupRecovery `
        -StateRoot $badStateRoot `
        -Launcher $launcher
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "malformed-intent-fails-closed-without-deletion" `
        -Passed (
            -not $badRecovery.passed -and
            @($badRecovery.errors).Count -eq 1 -and
            (Test-Path -LiteralPath $badProfilePath)
        ) `
        -Detail ($badRecovery.errors -join ';')
    & $launcher delete --name $badProfileName | Out-Null
    Remove-Item -LiteralPath $badPaths.intentPath -Force

    $unsafeDirectory = Join-Path $badStateRoot "not-an-execution"
    New-Item -ItemType Directory -Path $unsafeDirectory -Force | Out-Null
    $unsafeRecovery = Invoke-ProvisionerStartupRecovery `
        -StateRoot $badStateRoot `
        -Launcher $launcher
    Add-RecoveryCheck `
        -Checks $checks `
        -Name "invalid-state-directory-fails-closed" `
        -Passed (
            -not $unsafeRecovery.passed -and
            @($unsafeRecovery.errors | Where-Object { $_ -match "state directory is invalid" }).Count -eq 1
        ) `
        -Detail ($unsafeRecovery.errors -join ';')
    Remove-Item -LiteralPath $unsafeDirectory -Force

    $failedChecks = @($checks | Where-Object { -not $_.passed })
    $summary = [ordered]@{
        passed = $failedChecks.Count -eq 0
        productionReady = $false
        windows = [Environment]::OSVersion.VersionString
        crashPoints = @($cases.point)
        checks = $checks
        firstRecovery = $firstRecovery
        secondRecovery = $secondRecovery
        badRecovery = $badRecovery
    }
    Write-Utf8Json -Path $resultPath -Value $summary
    $summary | ConvertTo-Json -Depth 14
    $cleanupPassed = $summary.passed
    if (-not $summary.passed) {
        throw "$($failedChecks.Count) Provisioner startup-recovery checks failed. See $resultPath."
    }
}
finally {
    foreach ($root in @($stateRoot, $badStateRoot)) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($directory in Get-ChildItem -LiteralPath $root -Directory -Force) {
            if ($directory.Name -notmatch '^[0-9a-f]{32}$') { continue }
            $profileName = "ScopeGuardExec_$($directory.Name)"
            try { & $launcher delete --name $profileName | Out-Null } catch {}
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
