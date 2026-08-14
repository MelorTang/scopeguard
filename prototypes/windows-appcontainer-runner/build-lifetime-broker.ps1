[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "bin")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The lifetime broker must be built on Windows."
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "Visual Studio Installer vswhere.exe was not found."
}

$installationPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $installationPath) {
    throw "MSVC x64 build tools were not found."
}

$devCommand = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
$source = Join-Path $PSScriptRoot "lifetime-broker.cpp"
$output = Join-Path $OutputDirectory "scopeguard-lifetime-broker.exe"
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$compileCommand = @(
    "call `"$devCommand`" -no_logo -arch=amd64 -host_arch=amd64",
    "cl.exe /nologo /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE /Fe:`"$output`" `"$source`""
) -join " && "

& $env:ComSpec /d /s /c $compileCommand | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    throw "MSVC failed to build the lifetime broker."
}

Write-Output $output
