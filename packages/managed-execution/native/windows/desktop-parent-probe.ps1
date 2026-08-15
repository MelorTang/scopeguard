[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LifetimeBroker,
    [Parameter(Mandatory)]
    [string]$BrokerReadyPath,
    [Parameter(Mandatory)]
    [string]$ParentReadyPath,
    [Parameter(Mandatory)]
    [string]$HostScript,
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
    [string]$HostReadyPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $LifetimeBroker
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
foreach ($argument in @(
    "--parent-pid", $PID.ToString(),
    "--ready", $BrokerReadyPath,
    "--",
    (Get-Command pwsh.exe -ErrorAction Stop).Source,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File", $HostScript,
    "-Launcher", $Launcher,
    "-ProfileNameA", $ProfileNameA,
    "-ProfileNameB", $ProfileNameB,
    "-WorkspaceA", $WorkspaceA,
    "-WorkspaceB", $WorkspaceB,
    "-PythonPath", $PythonPath,
    "-ResultPathA", $ResultPathA,
    "-ResultPathB", $ResultPathB,
    "-ReadyPath", $HostReadyPath
)) {
    $startInfo.ArgumentList.Add($argument)
}

$broker = [Diagnostics.Process]::new()
$broker.StartInfo = $startInfo
if (-not $broker.Start()) {
    throw "Failed to start the lifetime broker."
}
[ordered]@{
    parentPid = $PID
    brokerPid = $broker.Id
} | ConvertTo-Json | Set-Content -LiteralPath $ParentReadyPath -Encoding utf8

$broker.WaitForExit()
exit $broker.ExitCode
