[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Launcher,
    [Parameter(Mandatory)]
    [string]$ProfileNameA,
    [Parameter(Mandatory)]
    [string]$ProfileNameB,
    [Parameter(Mandatory)]
    [string]$WorkspaceA,
    [Parameter(Mandatory)]
    [string]$WorkspaceB,
    [Parameter(Mandatory)]
    [string]$PythonPath,
    [Parameter(Mandatory)]
    [string]$ResultPathA,
    [Parameter(Mandatory)]
    [string]$ResultPathB,
    [Parameter(Mandatory)]
    [string]$ReadyPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Start-ManagedLauncher {
    param(
        [string]$ProfileName,
        [string]$Workspace,
        [string]$PeerWorkspace,
        [string]$ResultPath
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Launcher
    $startInfo.WorkingDirectory = $Workspace
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @(
        "run",
        "--name", $ProfileName,
        "--cwd", $Workspace,
        "--timeout", "300",
        "--lpac",
        "--diagnostics", (Join-Path $Workspace "launcher-diagnostics.log"),
        "--",
        $PythonPath,
        (Join-Path $Workspace "conversation-isolation-probe.py"),
        $Workspace,
        $PeerWorkspace,
        $ResultPath
    )) {
        $startInfo.ArgumentList.Add($argument)
    }
    $startInfo.Environment.Clear()
    foreach ($name in @(
        "ALLUSERSPROFILE",
        "ComSpec",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "Path",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "SystemDrive",
        "SystemRoot",
        "windir"
    )) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) {
            $startInfo.Environment[$name] = $value
        }
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start managed launcher for $ProfileName."
    }
    return $process
}

$launcherA = Start-ManagedLauncher `
    -ProfileName $ProfileNameA `
    -Workspace $WorkspaceA `
    -PeerWorkspace $WorkspaceB `
    -ResultPath $ResultPathA
$launcherB = Start-ManagedLauncher `
    -ProfileName $ProfileNameB `
    -Workspace $WorkspaceB `
    -PeerWorkspace $WorkspaceA `
    -ResultPath $ResultPathB

$ready = [ordered]@{
    hostPid = $PID
    launcherPidA = $launcherA.Id
    launcherPidB = $launcherB.Id
}
$ready | ConvertTo-Json | Set-Content -LiteralPath $ReadyPath -Encoding utf8

while (-not $launcherA.HasExited -or -not $launcherB.HasExited) {
    Start-Sleep -Milliseconds 100
}

if ($launcherA.ExitCode -ne 0 -or $launcherB.ExitCode -ne 0) {
    exit 1
}
