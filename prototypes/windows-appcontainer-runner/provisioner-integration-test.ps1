[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "This Provisioner prototype must run on Windows with PowerShell 7."
}

. (Join-Path $PSScriptRoot "provisioner.ps1")

function Write-Utf8Text {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Value
    )

    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function ConvertTo-CompactJson {
    param([Parameter(Mandatory)][object]$Value)

    return $Value | ConvertTo-Json -Depth 16 -Compress
}

function Add-ProvisionerCheck {
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

function Add-ProvisionerRejectionCheck {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Checks,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$ExpectedError
    )

    try {
        $null = & $Action
        Add-ProvisionerCheck `
            -Checks $Checks `
            -Name $Name `
            -Passed $false `
            -Detail "request was unexpectedly accepted"
    }
    catch {
        $message = $_.Exception.Message
        Add-ProvisionerCheck `
            -Checks $Checks `
            -Name $Name `
            -Passed ($message -match [regex]::Escape($ExpectedError)) `
            -Detail $message
    }
}

function New-PreparePayloadJson {
    param(
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$ExecutionId,
        [Parameter(Mandatory)][string]$IssuedAtUtc,
        [string]$WorkspaceId = "workspace.primary",
        [string]$RuntimeId = "scopeguard.node"
    )

    return ConvertTo-CompactJson -Value ([ordered]@{
        schemaVersion = 1
        operation = "prepare"
        requestId = $RequestId
        executionId = $ExecutionId
        issuedAtUtc = $IssuedAtUtc
        workspaceId = $WorkspaceId
        runtimeId = $RuntimeId
    })
}

function New-CleanupPayloadJson {
    param(
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$ExecutionId,
        [Parameter(Mandatory)][string]$IssuedAtUtc
    )

    return ConvertTo-CompactJson -Value ([ordered]@{
        schemaVersion = 1
        operation = "cleanup"
        requestId = $RequestId
        executionId = $ExecutionId
        issuedAtUtc = $IssuedAtUtc
    })
}

function Get-EnvelopeJson {
    param(
        [Parameter(Mandatory)][byte[]]$Key,
        [Parameter(Mandatory)][string]$PayloadJson
    )

    return ConvertTo-CompactJson -Value (
        New-ProvisionerEnvelope -Key $Key -PayloadJson $PayloadJson
    )
}

function Read-TestRequest {
    param(
        [Parameter(Mandatory)][string]$EnvelopeJson,
        [Parameter(Mandatory)][byte[]]$Key,
        [Parameter(Mandatory)][DateTimeOffset]$Now
    )

    return Read-ProvisionerEnvelope `
        -EnvelopeJson $EnvelopeJson `
        -Key $Key `
        -Now $Now
}

function New-NodeRuntimeManifest {
    param(
        [Parameter(Mandatory)][string]$PackRoot,
        [Parameter(Mandatory)][string]$Version
    )

    $node = Get-Item -LiteralPath (Join-Path $PackRoot "node.exe") -Force
    return [ordered]@{
        schemaVersion = 1
        runtimeId = "scopeguard.node"
        version = $Version
        architecture = "x64"
        executable = "node.exe"
        capabilities = @("registryRead")
        files = @(
            [ordered]@{
                path = "node.exe"
                size = $node.Length
                sha256 = Get-RuntimePackSha256 -Path $node.FullName
            }
        )
    }
}

function New-ProvisionerRegistryJson {
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$PackRoot,
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$ManifestSha256
    )

    return ConvertTo-CompactJson -Value ([ordered]@{
        schemaVersion = 1
        workspaces = @(
            [ordered]@{ id = "workspace.primary"; root = $Workspace }
        )
        runtimes = @(
            [ordered]@{
                id = "scopeguard.node"
                packRoot = $PackRoot
                manifestPath = $ManifestPath
                manifestSha256 = $ManifestSha256
            }
        )
    })
}

function Test-TokenManifestDiagnostic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Capabilities
    )

    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $diagnostics = Get-Content -LiteralPath $Path -Raw
    $expected = $Capabilities -join ','
    return $diagnostics -match [regex]::Escape(
        "token-capabilities-verified=$expected"
    )
}

function Invoke-ProvisionedNodeProbe {
    param(
        [Parameter(Mandatory)][string]$Launcher,
        [Parameter(Mandatory)][object]$Prepared,
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$Outside,
        [Parameter(Mandatory)][string]$DiagnosticsPath
    )

    $resultPath = Join-Path $Workspace "provisioner-node-result.json"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Launcher
    $startInfo.WorkingDirectory = $Workspace
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $arguments = @(
        "run",
        "--name", $Prepared.profileName,
        "--cwd", $Workspace,
        "--timeout", "30",
        "--lpac",
        "--diagnostics", $DiagnosticsPath
    )
    foreach ($capability in @($Prepared.runtime.capabilities)) {
        $arguments += @("--capability", $capability)
    }
    $arguments += @(
        "--",
        $Prepared.runtime.executablePath,
        (Join-Path $Workspace "runtime-pack-probe.js"),
        $Workspace,
        $Outside,
        $Prepared.runtime.packRoot,
        $resultPath
    )
    foreach ($argument in $arguments) { $startInfo.ArgumentList.Add($argument) }
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
        if ($null -ne $value) { $startInfo.Environment[$name] = $value }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Failed to start the provisioned Node probe." }
    if (-not $process.WaitForExit(45000)) {
        $process.Kill($true)
        $process.WaitForExit()
        $exitCode = 125
    }
    else {
        $exitCode = $process.ExitCode
    }
    $probe = if (Test-Path -LiteralPath $resultPath) {
        Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    }
    else {
        $null
    }
    return [pscustomobject][ordered]@{
        exitCode = $exitCode
        tokenManifestVerified = Test-TokenManifestDiagnostic `
            -Path $DiagnosticsPath `
            -Capabilities @($Prepared.runtime.capabilities)
        probe = $probe
        passed = $exitCode -eq 0 -and
            $null -ne $probe -and
            $probe.passed
    }
}

$fixtureBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$fixtureRoot = Join-Path $fixtureBase "scopeguard-provisioner-fixture"
$workspace = Join-Path $fixtureRoot "workspace"
$outside = Join-Path $fixtureRoot "outside"
$packRoot = Join-Path $fixtureRoot "runtime-pack"
$metadataRoot = Join-Path $fixtureRoot "metadata"
$stateRoot = Join-Path $fixtureRoot "state"
$registryPath = Join-Path $metadataRoot "provisioner-registry.json"
$manifestPath = Join-Path $metadataRoot "runtime-manifest.json"
$resultPath = Join-Path $fixtureRoot "result.json"
$diagnosticsPath = Join-Path $fixtureRoot "launcher-diagnostics.log"
$executionId = [guid]::NewGuid().ToString("N")
$now = [DateTimeOffset]::UtcNow
$issuedAtUtc = $now.UtcDateTime.ToString("O")
$key = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($key)
$checks = [System.Collections.Generic.List[object]]::new()
$lifecycleChecks = [System.Collections.Generic.List[object]]::new()
$launcher = $null
$prepared = $null
$cleanupPassed = $false

if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path @(
    $workspace,
    $outside,
    $packRoot,
    $metadataRoot,
    $stateRoot
) -Force | Out-Null
Copy-Item `
    -LiteralPath (Join-Path $PSScriptRoot "runtime-pack-probe.js") `
    -Destination $workspace
$sourceNode = Get-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Force
Copy-Item -LiteralPath $sourceNode.FullName -Destination (Join-Path $packRoot "node.exe")
$runtimeVersion = ($sourceNode.VersionInfo.FileVersion -split ' ')[0]
$manifestJson = ConvertTo-CompactJson -Value (
    New-NodeRuntimeManifest -PackRoot $packRoot -Version $runtimeVersion
)
Write-Utf8Text -Path $manifestPath -Value $manifestJson
$manifestSha256 = Get-RuntimePackSha256 -Path $manifestPath
$registryJson = New-ProvisionerRegistryJson `
    -Workspace $workspace `
    -PackRoot $packRoot `
    -ManifestPath $manifestPath `
    -ManifestSha256 $manifestSha256
Write-Utf8Text -Path $registryPath -Value $registryJson
$launcher = (& (Join-Path $PSScriptRoot "build.ps1")).Trim()

try {
    $preparePayload = New-PreparePayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId $executionId `
        -IssuedAtUtc $issuedAtUtc
    $prepareEnvelope = Get-EnvelopeJson -Key $key -PayloadJson $preparePayload
    $validRequest = Read-TestRequest `
        -EnvelopeJson $prepareEnvelope -Key $key -Now $now
    Add-ProvisionerCheck `
        -Checks $checks `
        -Name "valid-authenticated-prepare-accepted" `
        -Passed (
            $validRequest.operation -eq "prepare" -and
            $validRequest.executionId -eq $executionId -and
            $validRequest.workspaceId -eq "workspace.primary" -and
            $validRequest.runtimeId -eq "scopeguard.node"
        ) `
        -Detail "payload=$($validRequest.payloadSha256)"

    $plan = Resolve-ProvisionerPlan -Request $validRequest -RegistryPath $registryPath
    Add-ProvisionerCheck `
        -Checks $checks `
        -Name "registered-identifiers-resolve-server-side" `
        -Passed (
            $plan.workspaceRoot -eq $workspace -and
            $plan.runtime.executablePath -eq (Join-Path $packRoot "node.exe") -and
            @($plan.runtime.capabilities).Count -eq 1 -and
            $plan.runtime.capabilities[0] -eq "registryRead"
        ) `
        -Detail "workspace=$($plan.workspaceId); runtime=$($plan.runtimeId)"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    Add-ProvisionerCheck `
        -Checks $checks `
        -Name "mutation-host-is-explicitly-elevated" `
        -Passed $principal.IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator
        ) `
        -Detail "identity=$($identity.Name)"

    $badHmacEnvelope = $prepareEnvelope -replace '"hmacSha256":".', '"hmacSha256":"0'
    if ($badHmacEnvelope -eq $prepareEnvelope) {
        $badHmacEnvelope = $prepareEnvelope -replace '"hmacSha256":".', '"hmacSha256":"1'
    }
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "invalid-hmac-rejected-before-payload-use" `
        -Action { Read-TestRequest -EnvelopeJson $badHmacEnvelope -Key $key -Now $now } `
        -ExpectedError "authentication failed"
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "extra-envelope-property-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson $prepareEnvelope.Replace(
                    '{"payloadBase64":',
                    '{"unexpected":true,"payloadBase64":'
                ) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "properties must be exactly"
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "duplicate-envelope-property-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson $prepareEnvelope.Replace(
                    '{"payloadBase64":',
                    '{"payloadBase64":"duplicate","payloadBase64":'
                ) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "duplicate property"

    $rawPathPayload = $preparePayload.Replace(
        '{"schemaVersion":1,',
        '{"schemaVersion":1,"workspaceRoot":"C:/Windows","capabilities":["internetClient"],'
    )
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "caller-path-and-capability-surface-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $rawPathPayload) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "properties must be exactly"
    $duplicatePayload = $preparePayload.Replace(
        '{"schemaVersion":1,',
        '{"schemaVersion":1,"requestId":"00000000000000000000000000000000",'
    )
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "duplicate-payload-property-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $duplicatePayload) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "duplicate property"
    $stalePayload = New-PreparePayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId ([guid]::NewGuid().ToString("N")) `
        -IssuedAtUtc $now.AddMinutes(-10).UtcDateTime.ToString("O")
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "stale-request-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $stalePayload) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "request is stale"
    $futurePayload = New-PreparePayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId ([guid]::NewGuid().ToString("N")) `
        -IssuedAtUtc $now.AddMinutes(2).UtcDateTime.ToString("O")
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "future-request-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $futurePayload) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "request is from the future"
    $badIdPayload = $preparePayload.Replace($executionId, "../../Windows/System32")
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "execution-path-injection-rejected" `
        -Action {
            Read-TestRequest `
                -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $badIdPayload) `
                -Key $key `
                -Now $now
        } `
        -ExpectedError "executionId must be"

    $unknownWorkspacePayload = New-PreparePayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId ([guid]::NewGuid().ToString("N")) `
        -IssuedAtUtc $issuedAtUtc `
        -WorkspaceId "workspace.unknown"
    $unknownWorkspaceRequest = Read-TestRequest `
        -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $unknownWorkspacePayload) `
        -Key $key `
        -Now $now
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "unknown-workspace-id-rejected" `
        -Action { Resolve-ProvisionerPlan -Request $unknownWorkspaceRequest -RegistryPath $registryPath } `
        -ExpectedError "workspaceId is not registered"
    $unknownRuntimePayload = New-PreparePayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId ([guid]::NewGuid().ToString("N")) `
        -IssuedAtUtc $issuedAtUtc `
        -RuntimeId "scopeguard.unknown"
    $unknownRuntimeRequest = Read-TestRequest `
        -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $unknownRuntimePayload) `
        -Key $key `
        -Now $now
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "unknown-runtime-id-rejected" `
        -Action { Resolve-ProvisionerPlan -Request $unknownRuntimeRequest -RegistryPath $registryPath } `
        -ExpectedError "runtimeId is not registered"

    try {
        Write-Utf8Text `
            -Path $registryPath `
            -Value $registryJson.Replace(
                '{"schemaVersion":1,',
                '{"schemaVersion":1,"unexpected":true,'
            )
        Add-ProvisionerRejectionCheck `
            -Checks $checks `
            -Name "registry-extra-property-rejected" `
            -Action { Read-ProvisionerRegistry -RegistryPath $registryPath } `
            -ExpectedError "properties must be exactly"
    }
    finally {
        Write-Utf8Text -Path $registryPath -Value $registryJson
    }
    try {
        $duplicateWorkspaceRegistry = $registryJson.Replace(
            '"workspaces":[',
            '"workspaces":[{"id":"workspace.primary","root":"' +
                $workspace.Replace('\', '\\') + '"},'
        )
        Write-Utf8Text -Path $registryPath -Value $duplicateWorkspaceRegistry
        Add-ProvisionerRejectionCheck `
            -Checks $checks `
            -Name "registry-duplicate-workspace-rejected" `
            -Action { Read-ProvisionerRegistry -RegistryPath $registryPath } `
            -ExpectedError "duplicate workspace ID"
    }
    finally {
        Write-Utf8Text -Path $registryPath -Value $registryJson
    }
    $registryHardLink = Join-Path $fixtureRoot "registry-hardlink.json"
    New-Item -ItemType HardLink -Path $registryHardLink -Target $registryPath | Out-Null
    try {
        Add-ProvisionerRejectionCheck `
            -Checks $checks `
            -Name "registry-multiple-hard-links-rejected" `
            -Action { Read-ProvisionerRegistry -RegistryPath $registryPath } `
            -ExpectedError "multiple hard links"
    }
    finally {
        Remove-Item -LiteralPath $registryHardLink -Force -ErrorAction SilentlyContinue
    }
    $manifestHardLink = Join-Path $fixtureRoot "manifest-hardlink.json"
    New-Item -ItemType HardLink -Path $manifestHardLink -Target $manifestPath | Out-Null
    try {
        Add-ProvisionerRejectionCheck `
            -Checks $checks `
            -Name "manifest-multiple-hard-links-rejected" `
            -Action { Read-ProvisionerRegistry -RegistryPath $registryPath } `
            -ExpectedError "multiple hard links"
    }
    finally {
        Remove-Item -LiteralPath $manifestHardLink -Force -ErrorAction SilentlyContinue
    }
    $junctionWorkspace = Join-Path $fixtureRoot "workspace-junction"
    New-Item -ItemType Junction -Path $junctionWorkspace -Target $workspace | Out-Null
    try {
        $junctionRegistry = New-ProvisionerRegistryJson `
            -Workspace $junctionWorkspace `
            -PackRoot $packRoot `
            -ManifestPath $manifestPath `
            -ManifestSha256 $manifestSha256
        Write-Utf8Text -Path $registryPath -Value $junctionRegistry
        Add-ProvisionerRejectionCheck `
            -Checks $checks `
            -Name "registry-reparse-workspace-rejected" `
            -Action { Read-ProvisionerRegistry -RegistryPath $registryPath } `
            -ExpectedError "contains a reparse point"
    }
    finally {
        Write-Utf8Text -Path $registryPath -Value $registryJson
        Remove-Item -LiteralPath $junctionWorkspace -Force -ErrorAction SilentlyContinue
    }
    try {
        Write-Utf8Text -Path $manifestPath -Value $manifestJson.Replace(
            '"version":"',
            '"version":"tampered-'
        )
        Add-ProvisionerRejectionCheck `
            -Checks $checks `
            -Name "registered-runtime-manifest-tamper-rejected" `
            -Action { Resolve-ProvisionerPlan -Request $validRequest -RegistryPath $registryPath } `
            -ExpectedError "manifest digest mismatch"
    }
    finally {
        Write-Utf8Text -Path $manifestPath -Value $manifestJson
    }
    $unknownCleanupPayload = New-CleanupPayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId ([guid]::NewGuid().ToString("N")) `
        -IssuedAtUtc $issuedAtUtc
    $unknownCleanupRequest = Read-TestRequest `
        -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $unknownCleanupPayload) `
        -Key $key `
        -Now $now
    Add-ProvisionerRejectionCheck `
        -Checks $checks `
        -Name "unknown-cleanup-lifecycle-rejected" `
        -Action {
            Invoke-ProvisionerCleanup `
                -Request $unknownCleanupRequest `
                -StateRoot $stateRoot `
                -Launcher $launcher
        } `
        -ExpectedError "lifecycle does not exist"

    $failedPreflight = @($checks | Where-Object { -not $_.passed })
    if ($failedPreflight.Count -gt 0) {
        throw "$($failedPreflight.Count) Provisioner preflight checks failed."
    }

    $prepared = Invoke-ProvisionerPrepare `
        -Request $validRequest `
        -RegistryPath $registryPath `
        -StateRoot $stateRoot `
        -Launcher $launcher
    Add-ProvisionerCheck `
        -Checks $lifecycleChecks `
        -Name "prepare-creates-derived-profile-and-exact-acls" `
        -Passed (
            $prepared.passed -and
            -not $prepared.idempotent -and
            $prepared.profileName -eq "ScopeGuardExec_$executionId" -and
            (Test-SandboxSidAcePresentEverywhere `
                -Path $workspace `
                -PackageSid $prepared.packageSid `
                -Recursive $true) -and
            (Test-SandboxSidAcePresentEverywhere `
                -Path $packRoot `
                -PackageSid $prepared.packageSid `
                -Recursive $true)
        ) `
        -Detail "profile=$($prepared.profileName); sid=$($prepared.packageSid)"

    $env:SCOPEGUARD_SECRET_SENTINEL = "must-not-cross-provisioned-launch"
    try {
        $nodeProbe = Invoke-ProvisionedNodeProbe `
            -Launcher $launcher `
            -Prepared $prepared `
            -Workspace $workspace `
            -Outside $outside `
            -DiagnosticsPath $diagnosticsPath
    }
    finally {
        Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue
    }
    Add-ProvisionerCheck `
        -Checks $lifecycleChecks `
        -Name "prepared-profile-launches-verified-lpac-runtime" `
        -Passed (
            $nodeProbe.passed -and
            $nodeProbe.tokenManifestVerified -and
            $nodeProbe.probe.allowedWrite -and
            $nodeProbe.probe.outsideWriteDenied -and
            $nodeProbe.probe.runtimeWriteDenied -and
            -not $nodeProbe.probe.parentSecretInherited
        ) `
        -Detail "exit=$($nodeProbe.exitCode); tokenExact=$($nodeProbe.tokenManifestVerified)"

    $repeatedPrepare = Invoke-ProvisionerPrepare `
        -Request $validRequest `
        -RegistryPath $registryPath `
        -StateRoot $stateRoot `
        -Launcher $launcher
    $ledgerBeforeCleanup = Read-SandboxLifecycleLedger -Path $prepared.ledgerPath
    Add-ProvisionerCheck `
        -Checks $lifecycleChecks `
        -Name "identical-prepare-is-idempotent" `
        -Passed (
            $repeatedPrepare.idempotent -and
            $repeatedPrepare.packageSid -eq $prepared.packageSid -and
            @($ledgerBeforeCleanup.aclGrants).Count -gt 0
        ) `
        -Detail "grants=$(@($ledgerBeforeCleanup.aclGrants).Count)"

    $conflictingPayload = New-PreparePayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId $executionId `
        -IssuedAtUtc $issuedAtUtc
    $conflictingRequest = Read-TestRequest `
        -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $conflictingPayload) `
        -Key $key `
        -Now $now
    Add-ProvisionerRejectionCheck `
        -Checks $lifecycleChecks `
        -Name "conflicting-prepare-replay-rejected" `
        -Action {
            Invoke-ProvisionerPrepare `
                -Request $conflictingRequest `
                -RegistryPath $registryPath `
                -StateRoot $stateRoot `
                -Launcher $launcher
        } `
        -ExpectedError "conflicts with an existing lifecycle"

    $cleanupPayload = New-CleanupPayloadJson `
        -RequestId ([guid]::NewGuid().ToString("N")) `
        -ExecutionId $executionId `
        -IssuedAtUtc $issuedAtUtc
    $cleanupRequest = Read-TestRequest `
        -EnvelopeJson (Get-EnvelopeJson -Key $key -PayloadJson $cleanupPayload) `
        -Key $key `
        -Now $now
    $cleanup = Invoke-ProvisionerCleanup `
        -Request $cleanupRequest `
        -StateRoot $stateRoot `
        -Launcher $launcher
    Add-ProvisionerCheck `
        -Checks $lifecycleChecks `
        -Name "cleanup-removes-exact-acls-and-profile" `
        -Passed (
            $cleanup.passed -and
            -not $cleanup.idempotent -and
            $cleanup.state -eq "cleaned" -and
            $cleanup.cleanupAttempts -eq 1 -and
            -not $cleanup.profilePathExists -and
            (Test-SandboxSidAceAbsent `
                -Path $workspace `
                -PackageSid $prepared.packageSid `
                -Recursive $true) -and
            (Test-SandboxSidAceAbsent `
                -Path $packRoot `
                -PackageSid $prepared.packageSid `
                -Recursive $true)
        ) `
        -Detail "state=$($cleanup.state); attempts=$($cleanup.cleanupAttempts)"

    $repeatedCleanup = Invoke-ProvisionerCleanup `
        -Request $cleanupRequest `
        -StateRoot $stateRoot `
        -Launcher $launcher
    Add-ProvisionerCheck `
        -Checks $lifecycleChecks `
        -Name "identical-cleanup-is-idempotent" `
        -Passed (
            $repeatedCleanup.passed -and
            $repeatedCleanup.idempotent -and
            $repeatedCleanup.cleanupAttempts -eq 1
        ) `
        -Detail "attempts=$($repeatedCleanup.cleanupAttempts)"
    Add-ProvisionerRejectionCheck `
        -Checks $lifecycleChecks `
        -Name "cleaned-execution-cannot-be-reprepared" `
        -Action {
            Invoke-ProvisionerPrepare `
                -Request $validRequest `
                -RegistryPath $registryPath `
                -StateRoot $stateRoot `
                -Launcher $launcher
        } `
        -ExpectedError "cannot be prepared again"

    $failedChecks = @(
        @($checks) + @($lifecycleChecks) |
            Where-Object { -not $_.passed }
    )
    $finalLedger = Read-SandboxLifecycleLedger -Path $prepared.ledgerPath
    $summary = [ordered]@{
        passed = $failedChecks.Count -eq 0
        productionReady = $false
        windows = [Environment]::OSVersion.VersionString
        authentication = "prototype-hmac-sha256"
        requestSurface = @("workspaceId", "runtimeId", "executionId")
        sourceRuntime = [ordered]@{
            path = $sourceNode.FullName
            fileVersion = $sourceNode.VersionInfo.FileVersion
            productVersion = $sourceNode.VersionInfo.ProductVersion
            sha256 = Get-RuntimePackSha256 -Path $sourceNode.FullName
        }
        validationChecks = $checks
        lifecycleChecks = $lifecycleChecks
        prepared = [ordered]@{
            profileName = $prepared.profileName
            packageSid = $prepared.packageSid
            workspaceId = $prepared.workspaceId
            runtimeId = $prepared.runtimeId
            manifestSha256 = $prepared.runtime.manifestSha256
            contentSha256 = $prepared.runtime.contentSha256
        }
        nodeProbe = $nodeProbe
        finalLedger = $finalLedger
        remainingGates = @(
            "OS-authenticated Broker-to-Provisioner transport and key bootstrap",
            "installed service identity and administrator-owned registry/state roots",
            "signed ScopeGuard runtime distribution",
            "Windows 10 x64 client validation"
        )
    }
    Write-Utf8Text -Path $resultPath -Value (ConvertTo-CompactJson -Value $summary)
    $summary | ConvertTo-Json -Depth 16
    $cleanupPassed = $summary.passed -and $finalLedger.state -eq "cleaned"
    if (-not $summary.passed) {
        throw "$($failedChecks.Count) Provisioner integration checks failed. See $resultPath."
    }
}
finally {
    Remove-Item Env:SCOPEGUARD_SECRET_SENTINEL -ErrorAction SilentlyContinue
    [Security.Cryptography.CryptographicOperations]::ZeroMemory($key)
    if ($null -ne $prepared -and (Test-Path -LiteralPath $prepared.ledgerPath)) {
        try {
            $ledger = Read-SandboxLifecycleLedger -Path $prepared.ledgerPath
            if ($ledger.state -ne "cleaned") {
                $recovery = Invoke-SandboxLifecycleRecovery `
                    -LedgerPath $prepared.ledgerPath `
                    -Launcher $launcher
                $cleanupPassed = $recovery.passed
            }
        }
        catch {
            Write-Warning "Final Provisioner recovery failed: $_"
        }
    }
    if (-not $KeepFixture -and $cleanupPassed -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
