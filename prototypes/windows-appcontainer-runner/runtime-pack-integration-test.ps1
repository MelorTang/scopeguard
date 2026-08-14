[CmdletBinding()]
param(
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This runtime-pack matrix must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "lifecycle.ps1")
. (Join-Path $PSScriptRoot "runtime-pack.ps1")

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [object]$Value
    )

    $raw = $Value | ConvertTo-Json -Depth 12 -Compress
    [IO.File]::WriteAllText($Path, $raw, [Text.UTF8Encoding]::new($false))
    return $raw
}

function Write-Utf8Text {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Value
    )

    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function New-NodeRuntimeManifest {
    param(
        [Parameter(Mandatory)]
        [string]$PackRoot,
        [Parameter(Mandatory)]
        [string]$Version,
        [string[]]$Capabilities = @()
    )

    $nodePath = Join-Path $PackRoot "node.exe"
    $node = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
    return [ordered]@{
        schemaVersion = 1
        runtimeId = "scopeguard.node"
        version = $Version
        architecture = "x64"
        executable = "node.exe"
        capabilities = @($Capabilities)
        files = @(
            [ordered]@{
                path = "node.exe"
                size = $node.Length
                sha256 = Get-RuntimePackSha256 -Path $node.FullName
            }
        )
    }
}

function Add-Check {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [bool]$Passed,
        [Parameter(Mandatory)]
        [string]$Detail
    )

    $Checks.Add([pscustomobject][ordered]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Add-ManifestRejectionCheck {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [string]$Raw,
        [Parameter(Mandatory)]
        [string]$ManifestPath,
        [Parameter(Mandatory)]
        [string]$PackRoot,
        [Parameter(Mandatory)]
        [string]$ExpectedError,
        [string]$ExpectedManifestSha256
    )

    Write-Utf8Text -Path $ManifestPath -Value $Raw
    $expectedHash = if ($ExpectedManifestSha256) {
        $ExpectedManifestSha256
    }
    else {
        Get-RuntimePackSha256 -Path $ManifestPath
    }
    try {
        $null = Read-VerifiedRuntimePack `
            -PackRoot $PackRoot `
            -ManifestPath $ManifestPath `
            -ExpectedManifestSha256 $expectedHash
        Add-Check `
            -Checks $Checks `
            -Name $Name `
            -Passed $false `
            -Detail "runtime pack was unexpectedly accepted"
    }
    catch {
        $message = $_.Exception.Message
        Add-Check `
            -Checks $Checks `
            -Name $Name `
            -Passed ($message -match [regex]::Escape($ExpectedError)) `
            -Detail $message
    }
}

function Add-PayloadRejectionCheck {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [scriptblock]$Mutate,
        [Parameter(Mandatory)]
        [scriptblock]$Restore,
        [Parameter(Mandatory)]
        [string]$PackRoot,
        [Parameter(Mandatory)]
        [string]$ManifestPath,
        [Parameter(Mandatory)]
        [string]$ManifestSha256,
        [Parameter(Mandatory)]
        [string]$ExpectedError
    )

    try {
        & $Mutate
        try {
            $null = Read-VerifiedRuntimePack `
                -PackRoot $PackRoot `
                -ManifestPath $ManifestPath `
                -ExpectedManifestSha256 $ManifestSha256
            Add-Check `
                -Checks $Checks `
                -Name $Name `
                -Passed $false `
                -Detail "mutated runtime pack was unexpectedly accepted"
        }
        catch {
            $message = $_.Exception.Message
            Add-Check `
                -Checks $Checks `
                -Name $Name `
                -Passed ($message -match [regex]::Escape($ExpectedError)) `
                -Detail $message
        }
    }
    finally {
        & $Restore
    }
}

function Test-TokenManifestDiagnostic {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [string[]]$Capabilities = @()
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $expected = if ($Capabilities.Count -eq 0) {
        "none"
    }
    else {
        $Capabilities -join ","
    }
    return (Get-Content -LiteralPath $Path -Raw) -match (
        [regex]::Escape("token-capabilities-verified=$expected")
    )
}

function Invoke-BundledNodeProbe {
    param(
        [Parameter(Mandatory)]
        [string]$Launcher,
        [Parameter(Mandatory)]
        [string]$ProfileName,
        [Parameter(Mandatory)]
        [string]$Workspace,
        [Parameter(Mandatory)]
        [string]$Outside,
        [Parameter(Mandatory)]
        [object]$Descriptor,
        [Parameter(Mandatory)]
        [string]$ManifestName,
        [Parameter(Mandatory)]
        [string]$DiagnosticsRoot
    )

    $resultPath = Join-Path $Workspace "$ManifestName-result.json"
    $diagnosticsPath = Join-Path $DiagnosticsRoot "$ManifestName.log"
    foreach ($path in @(
        $resultPath,
        (Join-Path $Workspace "bundled-node-output.txt"),
        (Join-Path $Outside "bundled-node-outside.txt"),
        (Join-Path $Descriptor.packRoot "sandbox-write.txt"),
        $diagnosticsPath,
        "$diagnosticsPath.child-output.log"
    )) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Launcher
    $startInfo.WorkingDirectory = $Workspace
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $arguments = @(
        "run",
        "--name", $ProfileName,
        "--cwd", $Workspace,
        "--timeout", "30",
        "--lpac",
        "--diagnostics", $diagnosticsPath
    )
    foreach ($capability in @($Descriptor.capabilities)) {
        $arguments += @("--capability", $capability)
    }
    $arguments += @(
        "--",
        $Descriptor.executablePath,
        (Join-Path $Workspace "runtime-pack-probe.js"),
        $Workspace,
        $Outside,
        $Descriptor.packRoot,
        $resultPath
    )
    foreach ($argument in $arguments) {
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
        throw "Failed to start bundled Node LPAC probe."
    }
    if (-not $process.WaitForExit(45000)) {
        $process.Kill($true)
        $process.WaitForExit()
        $exitCode = 125
    }
    else {
        $exitCode = $process.ExitCode
    }
    $tokenVerified = Test-TokenManifestDiagnostic `
        -Path $diagnosticsPath `
        -Capabilities @($Descriptor.capabilities)
    $probe = if (Test-Path -LiteralPath $resultPath) {
        Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    }
    else {
        $null
    }
    return [pscustomobject][ordered]@{
        manifest = $ManifestName
        capabilities = @($Descriptor.capabilities)
        capabilityCount = @($Descriptor.capabilities).Count
        manifestSha256 = $Descriptor.manifestSha256
        contentSha256 = $Descriptor.contentSha256
        exitCode = $exitCode
        tokenManifestVerified = $tokenVerified
        passed = $exitCode -eq 0 -and
            $tokenVerified -and
            $null -ne $probe -and
            $probe.passed
        probe = $probe
        diagnosticsPath = $diagnosticsPath
    }
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-runtime-pack-fixture"
$packRoot = Join-Path $fixtureRoot "pack"
$metadataRoot = Join-Path $fixtureRoot "metadata"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$diagnosticsRoot = Join-Path $fixtureRoot "diagnostics"
$resultPath = Join-Path $fixtureRoot "result.json"
$ledgerPath = Join-Path $fixtureRoot "lifecycle-ledger.json"
$cleanupResultPath = Join-Path $fixtureRoot "cleanup-result.json"
$profileName = "ScopeGuardRuntimePack_$([guid]::NewGuid().ToString('N'))"
$launcher = $null
$cleanupPassed = $false

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path @(
    $packRoot,
    $metadataRoot,
    $workspace,
    $outside,
    $diagnosticsRoot
) -Force | Out-Null
Copy-Item `
    -LiteralPath (Join-Path $PSScriptRoot "runtime-pack-probe.js") `
    -Destination $workspace

$sourceNodePath = (Get-Command node.exe -ErrorAction Stop).Source
$sourceNode = Get-Item -LiteralPath $sourceNodePath -Force
$packNodePath = Join-Path $packRoot "node.exe"
Copy-Item -LiteralPath $sourceNode.FullName -Destination $packNodePath
$runtimeVersion = ($sourceNode.VersionInfo.FileVersion -split ' ')[0]
$baseManifestPath = Join-Path $metadataRoot "base.json"
$baseManifest = New-NodeRuntimeManifest `
    -PackRoot $packRoot `
    -Version $runtimeVersion `
    -Capabilities @("registryRead")
$baseRaw = Write-Utf8Json -Path $baseManifestPath -Value $baseManifest
$baseManifestSha256 = Get-RuntimePackSha256 -Path $baseManifestPath
$checks = [System.Collections.Generic.List[object]]::new()
$profileCreatedAfterPreflight = $false

try {
    $baseDescriptor = Read-VerifiedRuntimePack `
        -PackRoot $packRoot `
        -ManifestPath $baseManifestPath `
        -ExpectedManifestSha256 $baseManifestSha256
    Add-Check `
        -Checks $checks `
        -Name "valid-pack-accepted" `
        -Passed (
            $baseDescriptor.runtimeId -eq "scopeguard.node" -and
            $baseDescriptor.executablePath -eq $packNodePath -and
            @($baseDescriptor.capabilities).Count -eq 1 -and
            $baseDescriptor.capabilities[0] -eq "registryRead"
        ) `
        -Detail "manifest=$($baseDescriptor.manifestSha256); content=$($baseDescriptor.contentSha256)"

    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "manifest-digest-tamper-rejected" `
        -Raw $baseRaw.Replace($runtimeVersion, "$runtimeVersion-tampered") `
        -ManifestPath (Join-Path $metadataRoot "digest-tamper.json") `
        -PackRoot $packRoot `
        -ExpectedError "manifest digest mismatch" `
        -ExpectedManifestSha256 $baseManifestSha256
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "extra-property-rejected" `
        -Raw $baseRaw.Replace('{"schemaVersion":1,', '{"schemaVersion":1,"unexpected":true,') `
        -ManifestPath (Join-Path $metadataRoot "extra-property.json") `
        -PackRoot $packRoot `
        -ExpectedError "properties must be exactly"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "duplicate-property-rejected" `
        -Raw $baseRaw.Replace('{"schemaVersion":1,', '{"schemaVersion":1,"schemaVersion":1,') `
        -ManifestPath (Join-Path $metadataRoot "duplicate-property.json") `
        -PackRoot $packRoot `
        -ExpectedError "duplicate property"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "executable-traversal-rejected" `
        -Raw $baseRaw.Replace('"executable":"node.exe"', '"executable":"../node.exe"') `
        -ManifestPath (Join-Path $metadataRoot "executable-traversal.json") `
        -PackRoot $packRoot `
        -ExpectedError "traversal segment"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "absolute-executable-rejected" `
        -Raw $baseRaw.Replace('"executable":"node.exe"', '"executable":"C:/Windows/System32/cmd.exe"') `
        -ManifestPath (Join-Path $metadataRoot "absolute-executable.json") `
        -PackRoot $packRoot `
        -ExpectedError "forward-slash relative path"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "file-traversal-rejected" `
        -Raw $baseRaw.Replace('"path":"node.exe"', '"path":"../node.exe"') `
        -ManifestPath (Join-Path $metadataRoot "file-traversal.json") `
        -PackRoot $packRoot `
        -ExpectedError "traversal segment"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "unsupported-capability-rejected" `
        -Raw $baseRaw.Replace('["registryRead"]', '["internetClient"]') `
        -ManifestPath (Join-Path $metadataRoot "unsupported-capability.json") `
        -PackRoot $packRoot `
        -ExpectedError "Unsupported runtime Capability"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "duplicate-capability-rejected" `
        -Raw $baseRaw.Replace('["registryRead"]', '["registryRead","registryRead"]') `
        -ManifestPath (Join-Path $metadataRoot "duplicate-capability.json") `
        -PackRoot $packRoot `
        -ExpectedError "Duplicate runtime Capability"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "noncanonical-capability-order-rejected" `
        -Raw $baseRaw.Replace('["registryRead"]', '["registryRead","lpacAppExperience"]') `
        -ManifestPath (Join-Path $metadataRoot "capability-order.json") `
        -PackRoot $packRoot `
        -ExpectedError "canonical order"
    Add-ManifestRejectionCheck `
        -Checks $checks `
        -Name "unlisted-executable-rejected" `
        -Raw $baseRaw.Replace('"executable":"node.exe"', '"executable":"missing.exe"') `
        -ManifestPath (Join-Path $metadataRoot "unlisted-executable.json") `
        -PackRoot $packRoot `
        -ExpectedError "not present in the file manifest"

    Add-PayloadRejectionCheck `
        -Checks $checks `
        -Name "payload-digest-tamper-rejected" `
        -Mutate {
            $stream = [IO.File]::Open($packNodePath, [IO.FileMode]::Append, [IO.FileAccess]::Write)
            try { $stream.WriteByte(0) } finally { $stream.Dispose() }
        } `
        -Restore { Copy-Item -LiteralPath $sourceNode.FullName -Destination $packNodePath -Force } `
        -PackRoot $packRoot `
        -ManifestPath $baseManifestPath `
        -ManifestSha256 $baseManifestSha256 `
        -ExpectedError "file size mismatch"
    $extraPayloadPath = Join-Path $packRoot "unexpected.txt"
    Add-PayloadRejectionCheck `
        -Checks $checks `
        -Name "unlisted-payload-rejected" `
        -Mutate { Write-Utf8Text -Path $extraPayloadPath -Value "unexpected" } `
        -Restore { Remove-Item -LiteralPath $extraPayloadPath -Force -ErrorAction SilentlyContinue } `
        -PackRoot $packRoot `
        -ManifestPath $baseManifestPath `
        -ManifestSha256 $baseManifestSha256 `
        -ExpectedError "does not exactly match"
    $missingPayloadPath = Join-Path $packRoot "node.missing"
    Add-PayloadRejectionCheck `
        -Checks $checks `
        -Name "missing-payload-rejected" `
        -Mutate { Move-Item -LiteralPath $packNodePath -Destination $missingPayloadPath } `
        -Restore { Move-Item -LiteralPath $missingPayloadPath -Destination $packNodePath -Force } `
        -PackRoot $packRoot `
        -ManifestPath $baseManifestPath `
        -ManifestSha256 $baseManifestSha256 `
        -ExpectedError "does not exactly match"

    Add-PayloadRejectionCheck `
        -Checks $checks `
        -Name "alternate-data-stream-rejected" `
        -Mutate {
            Set-Content `
                -LiteralPath $packNodePath `
                -Stream "ScopeGuardHidden" `
                -Value "hidden" `
                -Encoding utf8
        } `
        -Restore {
            Remove-Item `
                -LiteralPath $packNodePath `
                -Stream "ScopeGuardHidden" `
                -Force `
                -ErrorAction SilentlyContinue
        } `
        -PackRoot $packRoot `
        -ManifestPath $baseManifestPath `
        -ManifestSha256 $baseManifestSha256 `
        -ExpectedError "alternate data stream"
    $hardLinkPath = Join-Path $fixtureRoot "node-hardlink.exe"
    Add-PayloadRejectionCheck `
        -Checks $checks `
        -Name "multiple-hard-links-rejected" `
        -Mutate {
            New-Item `
                -ItemType HardLink `
                -Path $hardLinkPath `
                -Target $packNodePath | Out-Null
        } `
        -Restore {
            Remove-Item -LiteralPath $hardLinkPath -Force -ErrorAction SilentlyContinue
        } `
        -PackRoot $packRoot `
        -ManifestPath $baseManifestPath `
        -ManifestSha256 $baseManifestSha256 `
        -ExpectedError "multiple hard links"

    $junctionPath = Join-Path $fixtureRoot "junction-pack"
    New-Item -ItemType Junction -Path $junctionPath -Target $packRoot | Out-Null
    try {
        try {
            $null = Read-VerifiedRuntimePack `
                -PackRoot $junctionPath `
                -ManifestPath $baseManifestPath `
                -ExpectedManifestSha256 $baseManifestSha256
            Add-Check `
                -Checks $checks `
                -Name "reparse-root-rejected" `
                -Passed $false `
                -Detail "junction runtime root was unexpectedly accepted"
        }
        catch {
            $message = $_.Exception.Message
            Add-Check `
                -Checks $checks `
                -Name "reparse-root-rejected" `
                -Passed ($message -match "reparse point") `
                -Detail $message
        }
    }
    finally {
        Remove-Item -LiteralPath $junctionPath -Force -ErrorAction SilentlyContinue
    }

    $failedPreflightChecks = @($checks | Where-Object { -not $_.passed })
    if ($failedPreflightChecks.Count -gt 0) {
        throw "$($failedPreflightChecks.Count) runtime-pack preflight checks failed before profile creation."
    }

    $launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()
    $packageSid = (& $launcher profile --name $profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
        throw "Failed to create runtime-pack AppContainer profile."
    }
    $profileCreatedAfterPreflight = $true
    $profilePath = (& $launcher profile-path --name $profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
        & $launcher delete --name $profileName
        throw "Failed to resolve runtime-pack AppContainer profile path."
    }
    New-SandboxLifecycleLedger `
        -Path $ledgerPath `
        -ProfileName $profileName `
        -PackageSid $packageSid `
        -ProfilePath $profilePath | Out-Null
    Grant-SandboxAcl `
        -LedgerPath $ledgerPath `
        -Path $workspace `
        -Grant "(OI)(CI)(M)" `
        -Recursive
    $ancestor = [IO.Directory]::GetParent($workspace)
    while ($null -ne $ancestor) {
        Grant-SandboxAcl `
            -LedgerPath $ledgerPath `
            -Path $ancestor.FullName `
            -Grant "(RX)"
        $ancestor = $ancestor.Parent
    }
    Grant-SandboxAcl `
        -LedgerPath $ledgerPath `
        -Path $packRoot `
        -Grant "(OI)(CI)(RX)" `
        -Recursive

    $manifests = @(
        [pscustomobject]@{ name = "none"; capabilities = @() },
        [pscustomobject]@{ name = "app"; capabilities = @("lpacAppExperience") },
        [pscustomobject]@{ name = "registry"; capabilities = @("registryRead") },
        [pscustomobject]@{ name = "instrumentation"; capabilities = @("lpacInstrumentation") },
        [pscustomobject]@{ name = "app-registry"; capabilities = @("lpacAppExperience", "registryRead") },
        [pscustomobject]@{ name = "app-instrumentation"; capabilities = @("lpacAppExperience", "lpacInstrumentation") },
        [pscustomobject]@{ name = "registry-instrumentation"; capabilities = @("registryRead", "lpacInstrumentation") },
        [pscustomobject]@{ name = "all"; capabilities = @("lpacAppExperience", "registryRead", "lpacInstrumentation") }
    )
    $env:SCOPEGUARD_SECRET_SENTINEL = "must-not-cross-process-boundary"
    $matrix = [System.Collections.Generic.List[object]]::new()
    foreach ($manifest in $manifests) {
        $manifestPath = Join-Path $metadataRoot "$($manifest.name).json"
        $manifestValue = New-NodeRuntimeManifest `
            -PackRoot $packRoot `
            -Version $runtimeVersion `
            -Capabilities @($manifest.capabilities)
        $null = Write-Utf8Json -Path $manifestPath -Value $manifestValue
        $manifestSha256 = Get-RuntimePackSha256 -Path $manifestPath
        $descriptor = Read-VerifiedRuntimePack `
            -PackRoot $packRoot `
            -ManifestPath $manifestPath `
            -ExpectedManifestSha256 $manifestSha256
        $matrix.Add((Invoke-BundledNodeProbe `
            -Launcher $launcher `
            -ProfileName $profileName `
            -Workspace $workspace `
            -Outside $outside `
            -Descriptor $descriptor `
            -ManifestName $manifest.name `
            -DiagnosticsRoot $diagnosticsRoot))
    }
    Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue

    $selected = @($matrix | Where-Object passed | Sort-Object capabilityCount, manifest)[0]
    $missingTokenProof = @($matrix | Where-Object { -not $_.tokenManifestVerified })
    $summary = [ordered]@{
        passed = $profileCreatedAfterPreflight -and
            $null -ne $selected -and
            $selected.manifest -eq "registry" -and
            $missingTokenProof.Count -eq 0 -and
            @($checks | Where-Object { -not $_.passed }).Count -eq 0
        productionReady = $false
        windows = [Environment]::OSVersion.VersionString
        sourceRuntime = [ordered]@{
            path = $sourceNode.FullName
            fileVersion = $sourceNode.VersionInfo.FileVersion
            productVersion = $sourceNode.VersionInfo.ProductVersion
            sha256 = Get-RuntimePackSha256 -Path $sourceNode.FullName
        }
        verifiedRuntime = $baseDescriptor
        profileCreatedAfterPreflight = $profileCreatedAfterPreflight
        validationChecks = $checks
        selected = if ($null -ne $selected) {
            [ordered]@{
                manifest = $selected.manifest
                capabilities = @($selected.capabilities)
            }
        }
        else {
            $null
        }
        matrix = $matrix
    }
    $summary | ConvertTo-Json -Depth 14 |
        Set-Content -LiteralPath $resultPath -Encoding utf8
    $summary | ConvertTo-Json -Depth 14
    if (-not $summary.passed) {
        throw "Bundled runtime-pack matrix failed. See $resultPath."
    }
}
finally {
    Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue
    if ($null -ne $launcher -and (Test-Path -LiteralPath $ledgerPath)) {
        $cleanup = Invoke-SandboxLifecycleRecovery `
            -LedgerPath $ledgerPath `
            -Launcher $launcher
        $cleanup | ConvertTo-Json -Depth 12 |
            Set-Content -LiteralPath $cleanupResultPath -Encoding utf8
        $cleanupPassed = $cleanup.passed
        if (-not $cleanupPassed) {
            throw "Runtime-pack cleanup failed. See $cleanupResultPath."
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
