[CmdletBinding()]
param(
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This integration test must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "lifecycle.ps1")

function Add-BrokerCheck {
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

function Test-ProcessAlive {
    param([int]$ProcessId)

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Wait-ProcessesGone {
    param(
        [int[]]$ProcessIds,
        [int]$TimeoutMilliseconds = 5000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (@($ProcessIds | Where-Object { Test-ProcessAlive -ProcessId $_ }).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 50
    }
    return @($ProcessIds | Where-Object { Test-ProcessAlive -ProcessId $_ }).Count -eq 0
}

function Wait-JsonFile {
    param(
        [string]$Path,
        [int]$TimeoutMilliseconds = 30000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            try {
                return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
            }
            catch {
                # The writer may still be replacing the file.
            }
        }
        Start-Sleep -Milliseconds 50
    }
    throw "Timed out waiting for JSON file: $Path"
}

function New-TestSandboxIdentity {
    param(
        [string]$Name,
        [string]$Workspace,
        [string]$LedgerPath,
        [string[]]$RuntimeRoots,
        [string]$Launcher
    )

    $packageSid = (& $Launcher profile --name $Name).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
        throw "Failed to create AppContainer profile $Name."
    }
    $profilePath = (& $Launcher profile-path --name $Name).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
        & $Launcher delete --name $Name
        throw "Failed to resolve AppContainer profile path for $Name."
    }

    New-SandboxLifecycleLedger `
        -Path $LedgerPath `
        -ProfileName $Name `
        -PackageSid $packageSid `
        -ProfilePath $profilePath | Out-Null
    Grant-SandboxAcl `
        -LedgerPath $LedgerPath `
        -Path $Workspace `
        -Grant "(OI)(CI)(M)" `
        -Recursive
    $ancestor = [IO.Directory]::GetParent($Workspace)
    while ($null -ne $ancestor) {
        Grant-SandboxAcl `
            -LedgerPath $LedgerPath `
            -Path $ancestor.FullName `
            -Grant "(RX)"
        $ancestor = $ancestor.Parent
    }
    foreach ($runtimeRoot in $RuntimeRoots) {
        Grant-SandboxAcl `
            -LedgerPath $LedgerPath `
            -Path $runtimeRoot `
            -Grant "(OI)(CI)(RX)" `
            -Recursive
    }

    return [pscustomobject][ordered]@{
        name = $Name
        packageSid = $packageSid
        profilePath = $profilePath
        ledgerPath = $LedgerPath
        workspace = $Workspace
    }
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-desktop-broker-fixture"
$workspaceA = Join-Path $fixtureRoot "workspace-a"
$workspaceB = Join-Path $fixtureRoot "workspace-b"
$resultPathA = Join-Path $workspaceA "conversation-result.json"
$resultPathB = Join-Path $workspaceB "conversation-result.json"
$hostReadyPath = Join-Path $fixtureRoot "desktop-host-ready.json"
$parentReadyPath = Join-Path $fixtureRoot "desktop-parent-ready.json"
$brokerReadyPath = Join-Path $fixtureRoot "lifetime-broker-ready.txt"
$resultPath = Join-Path $fixtureRoot "result.json"
$ledgerPathA = Join-Path $fixtureRoot "lifecycle-a.json"
$ledgerPathB = Join-Path $fixtureRoot "lifecycle-b.json"
$profileNameA = "ScopeGuardDesktopA_$([guid]::NewGuid().ToString('N'))"
$profileNameB = "ScopeGuardDesktopB_$([guid]::NewGuid().ToString('N'))"
$checks = [System.Collections.Generic.List[object]]::new()
$desktopProcess = $null
$launcher = $null
$cleanupPassed = $false

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workspaceA, $workspaceB -Force | Out-Null
Copy-Item `
    -LiteralPath (Join-Path $PSScriptRoot "conversation-isolation-probe.py") `
    -Destination $workspaceA
Copy-Item `
    -LiteralPath (Join-Path $PSScriptRoot "conversation-isolation-probe.py") `
    -Destination $workspaceB
Set-Content -LiteralPath (Join-Path $workspaceA "peer-secret.txt") -Value "secret-a" -Encoding utf8
Set-Content -LiteralPath (Join-Path $workspaceB "peer-secret.txt") -Value "secret-b" -Encoding utf8

try {
    Write-Host "[desktop-broker] Building native launcher and lifetime broker"
    $launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()
    $lifetimeBroker = (& (Join-Path $PSScriptRoot "build-lifetime-broker.ps1")).Trim()
    $pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
    $runtimeRoots = @((Split-Path -Parent $pythonPath))

    Write-Host "[desktop-broker] Provisioning two isolated Conversation identities"
    $identityA = New-TestSandboxIdentity `
        -Name $profileNameA `
        -Workspace $workspaceA `
        -LedgerPath $ledgerPathA `
        -RuntimeRoots $runtimeRoots `
        -Launcher $launcher
    $identityB = New-TestSandboxIdentity `
        -Name $profileNameB `
        -Workspace $workspaceB `
        -LedgerPath $ledgerPathB `
        -RuntimeRoots $runtimeRoots `
        -Launcher $launcher

    Add-BrokerCheck `
        -Checks $checks `
        -Name "unique-conversation-identities" `
        -Passed ($identityA.packageSid -ne $identityB.packageSid) `
        -Detail "$($identityA.packageSid);$($identityB.packageSid)"

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File", (Join-Path $PSScriptRoot "desktop-parent-probe.ps1"),
        "-LifetimeBroker", $lifetimeBroker,
        "-BrokerReadyPath", $brokerReadyPath,
        "-ParentReadyPath", $parentReadyPath,
        "-HostScript", (Join-Path $PSScriptRoot "desktop-host-probe.ps1"),
        "-Launcher", $launcher,
        "-ProfileNameA", $profileNameA,
        "-ProfileNameB", $profileNameB,
        "-WorkspaceA", $workspaceA,
        "-WorkspaceB", $workspaceB,
        "-PythonPath", $pythonPath,
        "-ResultPathA", $resultPathA,
        "-ResultPathB", $resultPathB,
        "-HostReadyPath", $hostReadyPath
    )) {
        $startInfo.ArgumentList.Add($argument)
    }
    $desktopProcess = [Diagnostics.Process]::new()
    $desktopProcess.StartInfo = $startInfo
    if (-not $desktopProcess.Start()) {
        throw "Failed to start the Desktop parent probe."
    }

    $parentReady = Wait-JsonFile -Path $parentReadyPath
    $hostReady = Wait-JsonFile -Path $hostReadyPath
    $conversationA = Wait-JsonFile -Path $resultPathA
    $conversationB = Wait-JsonFile -Path $resultPathB
    $allStartedPids = @(
        [int]$parentReady.parentPid,
        [int]$parentReady.brokerPid,
        [int]$hostReady.hostPid,
        [int]$hostReady.launcherPidA,
        [int]$hostReady.launcherPidB,
        [int]$conversationA.parentPid,
        [int]$conversationA.childPid,
        [int]$conversationB.parentPid,
        [int]$conversationB.childPid
    )
    Add-BrokerCheck `
        -Checks $checks `
        -Name "parallel-conversations-isolated" `
        -Passed (
            $conversationA.passed -and
            $conversationB.passed -and
            @($allStartedPids | Where-Object { -not (Test-ProcessAlive -ProcessId $_) }).Count -eq 0
        ) `
        -Detail "parent=$($parentReady.parentPid); broker=$($parentReady.brokerPid); host=$($hostReady.hostPid); launchers=$($hostReady.launcherPidA),$($hostReady.launcherPidB)"

    Stop-Process -Id ([int]$hostReady.launcherPidA) -Force
    $conversationAStopped = Wait-ProcessesGone -ProcessIds @(
        [int]$hostReady.launcherPidA,
        [int]$conversationA.parentPid,
        [int]$conversationA.childPid
    )
    $conversationBStillRunning = @(
        [int]$parentReady.parentPid,
        [int]$parentReady.brokerPid,
        [int]$hostReady.hostPid,
        [int]$hostReady.launcherPidB,
        [int]$conversationB.parentPid,
        [int]$conversationB.childPid
    ) | ForEach-Object { Test-ProcessAlive -ProcessId $_ }
    Add-BrokerCheck `
        -Checks $checks `
        -Name "single-conversation-cancel-is-local" `
        -Passed (
            $conversationAStopped -and
            @($conversationBStillRunning | Where-Object { -not $_ }).Count -eq 0
        ) `
        -Detail "conversationAStopped=$conversationAStopped; conversationBAlive=$($conversationBStillRunning -join ',')"

    $desktopProcess.Kill($false)
    $desktopProcess.WaitForExit()
    $remainingStopped = Wait-ProcessesGone -ProcessIds @(
        [int]$parentReady.brokerPid,
        [int]$hostReady.hostPid,
        [int]$hostReady.launcherPidB,
        [int]$conversationB.parentPid,
        [int]$conversationB.childPid
    )
    Add-BrokerCheck `
        -Checks $checks `
        -Name "desktop-host-exit-clears-all-managed-processes" `
        -Passed $remainingStopped `
        -Detail "desktopExit=$($desktopProcess.ExitCode); allGone=$remainingStopped"

    $recoveryA = Invoke-SandboxLifecycleRecovery `
        -LedgerPath $ledgerPathA `
        -Launcher $launcher
    $recoveryB = Invoke-SandboxLifecycleRecovery `
        -LedgerPath $ledgerPathB `
        -Launcher $launcher
    Add-BrokerCheck `
        -Checks $checks `
        -Name "host-exit-recovery-removes-identities" `
        -Passed (
            $recoveryA.passed -and
            $recoveryB.passed -and
            -not $recoveryA.profilePathExists -and
            -not $recoveryB.profilePathExists
        ) `
        -Detail "a=$($recoveryA.state); b=$($recoveryB.state)"

    Add-BrokerCheck `
        -Checks $checks `
        -Name "cross-workspace-writes-absent" `
        -Passed (
            -not (Test-Path -LiteralPath (Join-Path $workspaceA "cross-write.txt")) -and
            -not (Test-Path -LiteralPath (Join-Path $workspaceB "cross-write.txt"))
        ) `
        -Detail "workspace-a/workspace-b"

    $failedChecks = @($checks | Where-Object { -not $_.passed })
    $summary = [ordered]@{
        passed = $failedChecks.Count -eq 0
        windows = [Environment]::OSVersion.VersionString
        broker = "kill-on-close-outer-job"
        conversations = 2
        checks = $checks
    }
    $summary | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath $resultPath -Encoding utf8
    $summary | ConvertTo-Json -Depth 12
    $cleanupPassed = $summary.passed
    if (-not $summary.passed) {
        throw "$($failedChecks.Count) Desktop broker integration checks failed. See $resultPath."
    }
}
finally {
    if ($null -ne $desktopProcess) {
        try {
            if (-not $desktopProcess.HasExited) {
                $desktopProcess.Kill($true)
                $desktopProcess.WaitForExit()
            }
        }
        catch {
            Write-Warning "Final Desktop process cleanup failed: $_"
        }
    }
    foreach ($ledgerPath in @($ledgerPathA, $ledgerPathB)) {
        try {
            if ($null -ne $launcher -and (Test-Path -LiteralPath $ledgerPath)) {
                $ledger = Read-SandboxLifecycleLedger -Path $ledgerPath
            }
            else {
                $ledger = $null
            }
            if ($null -ne $ledger -and $ledger.state -ne "cleaned") {
                Invoke-SandboxLifecycleRecovery `
                    -LedgerPath $ledgerPath `
                    -Launcher $launcher | Out-Null
            }
        }
        catch {
            Write-Warning "Final cleanup failed for $ledgerPath`: $_"
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
