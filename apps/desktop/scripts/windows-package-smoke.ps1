[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$AppRoot,
    [Parameter(Mandatory)]
    [string]$ReportPath,
    [ValidateRange(5, 120)]
    [int]$StartupTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DescendantProcesses {
    param(
        [Parameter(Mandatory)]
        [int]$RootProcessId
    )

    $all = @(Get-CimInstance Win32_Process)
    $pending = [Collections.Generic.Queue[int]]::new()
    $pending.Enqueue($RootProcessId)
    $result = [Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
        $parentId = $pending.Dequeue()
        foreach ($child in $all | Where-Object ParentProcessId -eq $parentId) {
            $result.Add($child)
            $pending.Enqueue([int]$child.ProcessId)
        }
    }
    return $result.ToArray()
}

$executable = Join-Path $AppRoot "ScopeGuard.exe"
$asarPath = Join-Path $AppRoot "resources\app.asar"
$logPath = Join-Path (Split-Path $ReportPath -Parent) "scopeguard-electron.log"
$windowsVersion = Get-ItemProperty `
    -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$process = $null
$report = [ordered]@{
    schemaVersion = 1
    passed = $false
    windowsBuild = "$($windowsVersion.CurrentBuildNumber).$($windowsVersion.UBR)"
    executable = $executable
    executableSha256 = $null
    asarSha256 = $null
    authenticodeStatus = $null
    mainProcessId = $null
    mainWindowTitle = $null
    mainWindowHandle = $null
    descendantProcessCount = 0
    gracefulShutdown = $false
    remainingProcessIds = @()
    error = $null
}

try {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "ScopeGuard.exe was not found below the package root."
    }
    if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
        throw "resources\app.asar was not found below the package root."
    }
    $existing = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and
        [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($executable)
    })
    if ($existing.Count -gt 0) {
        throw "The package already has a running ScopeGuard process."
    }

    $report.executableSha256 = (
        Get-FileHash -LiteralPath $executable -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    $report.asarSha256 = (
        Get-FileHash -LiteralPath $asarPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    $report.authenticodeStatus = (
        Get-AuthenticodeSignature -LiteralPath $executable
    ).Status.ToString()

    $process = Start-Process -FilePath $executable -ArgumentList @(
        "--enable-logging",
        "--log-file=$logPath"
    ) -PassThru
    $report.mainProcessId = $process.Id
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $main = $null
    $descendants = @()
    do {
        Start-Sleep -Milliseconds 250
        $main = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if (-not $main) {
            throw "ScopeGuard exited before its main window became ready."
        }
        $descendants = @(Get-DescendantProcesses -RootProcessId $process.Id)
    } until (
        ($main.MainWindowHandle -ne [IntPtr]::Zero -and
        $descendants.Count -ge 2) -or
        [DateTimeOffset]::UtcNow -ge $deadline
    )
    if ($main.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "ScopeGuard did not expose a main window before the startup timeout."
    }
    if ($descendants.Count -lt 2) {
        throw "ScopeGuard did not retain the expected Electron child processes."
    }

    $report.mainWindowTitle = $main.MainWindowTitle
    $report.mainWindowHandle = $main.MainWindowHandle.ToInt64()
    $report.descendantProcessCount = $descendants.Count
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        throw "ScopeGuard exited during the startup stability window."
    }

    $null = $main.CloseMainWindow()
    $report.gracefulShutdown = $process.WaitForExit(15000)
    if (-not $report.gracefulShutdown) {
        throw "ScopeGuard did not stop after its main window closed."
    }
    Start-Sleep -Seconds 1
    $remaining = @(
        @($process.Id) + @($descendants.ProcessId) |
            Sort-Object -Unique |
            Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    )
    $report.remainingProcessIds = @($remaining)
    if ($remaining.Count -gt 0) {
        throw "ScopeGuard left packaged child processes running after shutdown."
    }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
} finally {
    $reportDirectory = Split-Path $ReportPath -Parent
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}

if (-not $report.passed) {
    throw $report.error
}
