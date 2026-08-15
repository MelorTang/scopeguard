Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "lifecycle.ps1")
. (Join-Path $PSScriptRoot "runtime-pack.ps1")

function Assert-ProvisionerElevated {
    if (-not $IsWindows) {
        throw "Provisioner mutations require Windows."
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )) {
        throw "Provisioner mutations require an elevated administrator token."
    }
}

function Get-ProvisionerSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    return [Security.Cryptography.SHA256]::HashData($Bytes)
}

function Get-ProvisionerSha256Hex {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    return [Convert]::ToHexString(
        (Get-ProvisionerSha256Bytes -Bytes $Bytes)
    ).ToLowerInvariant()
}

function Get-ProvisionerHmacHex {
    param(
        [Parameter(Mandatory)][byte[]]$Key,
        [Parameter(Mandatory)][byte[]]$Bytes
    )

    if ($Key.Length -lt 32) {
        throw "Provisioner authentication keys must contain at least 32 bytes."
    }
    $hmac = [Security.Cryptography.HMACSHA256]::new($Key)
    try {
        return [Convert]::ToHexString($hmac.ComputeHash($Bytes)).ToLowerInvariant()
    }
    finally {
        $hmac.Dispose()
    }
}

function New-ProvisionerEnvelope {
    param(
        [Parameter(Mandatory)][byte[]]$Key,
        [Parameter(Mandatory)][string]$PayloadJson
    )

    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($PayloadJson)
    return [pscustomobject][ordered]@{
        payloadBase64 = [Convert]::ToBase64String($payloadBytes)
        hmacSha256 = Get-ProvisionerHmacHex -Key $Key -Bytes $payloadBytes
    }
}

function Get-ProvisionerStrictString {
    param(
        [Parameter(Mandatory)][object[]]$Properties,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Context
    )

    return Get-StrictJsonString `
        -Element (Get-StrictJsonProperty -Properties $Properties -Name $Name) `
        -Context "$Context.$Name"
}

function Read-ProvisionerPayload {
    param(
        [Parameter(Mandatory)][byte[]]$PayloadBytes,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [int]$MaximumAgeSeconds = 300,
        [int]$MaximumFutureSkewSeconds = 30
    )

    if ($PayloadBytes.Length -eq 0 -or $PayloadBytes.Length -gt 64KB) {
        throw "Provisioner payload must contain between 1 byte and 64 KiB."
    }
    $payloadDocument = $null
    try {
        $payloadJson = [Text.Encoding]::UTF8.GetString($PayloadBytes)
        $payloadDocument = [System.Text.Json.JsonDocument]::Parse($payloadJson)
        if ($payloadDocument.RootElement.ValueKind -ne
            [System.Text.Json.JsonValueKind]::Object) {
            throw "Provisioner payload must be a JSON object."
        }
        $operationProperty = @(
            $payloadDocument.RootElement.EnumerateObject() |
                Where-Object Name -CEQ "operation"
        )
        if ($operationProperty.Count -ne 1) {
            throw "Provisioner payload must contain one operation property."
        }
        $operation = Get-StrictJsonString `
            -Element $operationProperty[0].Value `
            -Context "Provisioner payload.operation"
        $expectedNames = switch ($operation) {
            "prepare" {
                @(
                    "schemaVersion",
                    "operation",
                    "requestId",
                    "executionId",
                    "issuedAtUtc",
                    "workspaceId",
                    "runtimeId"
                )
            }
            "cleanup" {
                @(
                    "schemaVersion",
                    "operation",
                    "requestId",
                    "executionId",
                    "issuedAtUtc"
                )
            }
            default { throw "Unsupported Provisioner operation: $operation" }
        }
        $payloadProperties = @(Get-StrictJsonProperties `
            -Element $payloadDocument.RootElement `
            -ExpectedNames $expectedNames `
            -Context "Provisioner $operation payload")
        $schemaVersion = Get-StrictJsonInt64 `
            -Element (Get-StrictJsonProperty `
                -Properties $payloadProperties `
                -Name "schemaVersion") `
            -Context "Provisioner payload.schemaVersion"
        if ($schemaVersion -ne 1) {
            throw "Unsupported Provisioner schemaVersion: $schemaVersion"
        }
        $requestId = Get-ProvisionerStrictString `
            -Properties $payloadProperties -Name "requestId" -Context "Provisioner payload"
        $executionId = Get-ProvisionerStrictString `
            -Properties $payloadProperties -Name "executionId" -Context "Provisioner payload"
        foreach ($identifier in @(
            [pscustomobject]@{ name = "requestId"; value = $requestId },
            [pscustomobject]@{ name = "executionId"; value = $executionId }
        )) {
            if ($identifier.value -notmatch '^[0-9a-f]{32}$') {
                throw "Provisioner $($identifier.name) must be 32 lowercase hexadecimal characters."
            }
        }
        $issuedAtText = Get-ProvisionerStrictString `
            -Properties $payloadProperties -Name "issuedAtUtc" -Context "Provisioner payload"
        if ($issuedAtText -notmatch 'Z$') {
            throw "Provisioner issuedAtUtc must use the UTC Z suffix."
        }
        $issuedAt = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse(
            $issuedAtText,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$issuedAt
        )) {
            throw "Provisioner issuedAtUtc is invalid."
        }
        if ($issuedAt -lt $Now.AddSeconds(-$MaximumAgeSeconds)) {
            throw "Provisioner request is stale."
        }
        if ($issuedAt -gt $Now.AddSeconds($MaximumFutureSkewSeconds)) {
            throw "Provisioner request is from the future."
        }

        $workspaceId = $null
        $runtimeId = $null
        if ($operation -ceq "prepare") {
            $workspaceId = Get-ProvisionerStrictString `
                -Properties $payloadProperties -Name "workspaceId" -Context "Provisioner payload"
            $runtimeId = Get-ProvisionerStrictString `
                -Properties $payloadProperties -Name "runtimeId" -Context "Provisioner payload"
            if ($workspaceId -notmatch '^workspace\.[a-z][a-z0-9-]{0,62}$') {
                throw "Provisioner workspaceId is invalid."
            }
            if ($runtimeId -notmatch '^scopeguard\.[a-z][a-z0-9.-]{0,63}$') {
                throw "Provisioner runtimeId is invalid."
            }
        }
        return [pscustomobject][ordered]@{
            schemaVersion = 1
            operation = $operation
            requestId = $requestId
            executionId = $executionId
            issuedAtUtc = $issuedAt.UtcDateTime.ToString("O")
            workspaceId = $workspaceId
            runtimeId = $runtimeId
            payloadSha256 = Get-ProvisionerSha256Hex -Bytes $PayloadBytes
        }
    }
    finally {
        if ($null -ne $payloadDocument) { $payloadDocument.Dispose() }
    }
}

function Read-ProvisionerEnvelope {
    param(
        [Parameter(Mandatory)][string]$EnvelopeJson,
        [Parameter(Mandatory)][byte[]]$Key,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [int]$MaximumAgeSeconds = 300,
        [int]$MaximumFutureSkewSeconds = 30
    )

    if ([Text.Encoding]::UTF8.GetByteCount($EnvelopeJson) -gt 128KB) {
        throw "Provisioner envelope exceeds the 128 KiB limit."
    }
    $envelopeDocument = $null
    try {
        $envelopeDocument = [System.Text.Json.JsonDocument]::Parse($EnvelopeJson)
        $envelopeProperties = @(Get-StrictJsonProperties `
            -Element $envelopeDocument.RootElement `
            -ExpectedNames @("payloadBase64", "hmacSha256") `
            -Context "Provisioner envelope")
        $payloadBase64 = Get-ProvisionerStrictString `
            -Properties $envelopeProperties `
            -Name "payloadBase64" `
            -Context "Provisioner envelope"
        $hmacSha256 = Get-ProvisionerStrictString `
            -Properties $envelopeProperties `
            -Name "hmacSha256" `
            -Context "Provisioner envelope"
        if ($hmacSha256 -notmatch '^[0-9a-f]{64}$') {
            throw "Provisioner envelope HMAC must be lowercase hexadecimal."
        }
        try {
            $payloadBytes = [Convert]::FromBase64String($payloadBase64)
        }
        catch {
            throw "Provisioner envelope payload is not valid base64."
        }
        if ($payloadBytes.Length -eq 0 -or $payloadBytes.Length -gt 64KB) {
            throw "Provisioner payload must contain between 1 byte and 64 KiB."
        }
        $expectedHmacBytes = [Convert]::FromHexString(
            (Get-ProvisionerHmacHex -Key $Key -Bytes $payloadBytes)
        )
        $actualHmacBytes = [Convert]::FromHexString($hmacSha256)
        if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals(
            $expectedHmacBytes,
            $actualHmacBytes
        )) {
            throw "Provisioner envelope authentication failed."
        }
        return Read-ProvisionerPayload `
            -PayloadBytes $payloadBytes `
            -Now $Now `
            -MaximumAgeSeconds $MaximumAgeSeconds `
            -MaximumFutureSkewSeconds $MaximumFutureSkewSeconds
    }
    finally {
        if ($null -ne $envelopeDocument) { $envelopeDocument.Dispose() }
    }
}

function Resolve-ProvisionerRegisteredPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Context,
        [switch]$Directory
    )

    if ($Path.StartsWith('\\', [StringComparison]::Ordinal) -or
        $Path.StartsWith('//', [StringComparison]::Ordinal) -or
        $Path.StartsWith('\\?', [StringComparison]::Ordinal) -or
        $Path.StartsWith('\\.', [StringComparison]::Ordinal) -or
        $Path.IndexOf(':', 2) -ge 0) {
        throw "$Context uses a UNC, device, or alternate-stream path."
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $trimmedInput = $Path.TrimEnd('\')
    $trimmedFullPath = $fullPath.TrimEnd('\')
    if (-not $trimmedInput.Equals($trimmedFullPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Context must already be canonical."
    }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if ($Directory -and -not $item.PSIsContainer) {
        throw "$Context must be a directory."
    }
    if (-not $Directory -and $item.PSIsContainer) {
        throw "$Context must be a file."
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Context contains a reparse point: $($item.FullName)"
    }
    $ancestor = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    while ($null -ne $ancestor) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Context contains a reparse point: $($ancestor.FullName)"
        }
        $ancestor = $ancestor.Parent
    }
    if (-not $item.PSIsContainer) {
        $namedStreams = @(
            Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction Stop |
                Where-Object Stream -CNE ':$DATA'
        )
        if ($namedStreams.Count -gt 0) {
            throw "$Context contains an alternate data stream."
        }
    }
    return $item.FullName.TrimEnd('\')
}

function Read-ProvisionerRegistry {
    param([Parameter(Mandatory)][string]$RegistryPath)

    $registryFile = Resolve-ProvisionerRegisteredPath `
        -Path $RegistryPath `
        -Context "Provisioner registry"
    Assert-RuntimePackSingleHardLink -Path $registryFile
    if ((Get-Item -LiteralPath $registryFile).Length -gt 2MB) {
        throw "Provisioner registry exceeds the 2 MiB limit."
    }
    $document = $null
    try {
        $document = [System.Text.Json.JsonDocument]::Parse(
            [IO.File]::ReadAllText($registryFile, [Text.Encoding]::UTF8)
        )
        $rootProperties = @(Get-StrictJsonProperties `
            -Element $document.RootElement `
            -ExpectedNames @("schemaVersion", "workspaces", "runtimes") `
            -Context "Provisioner registry")
        $schemaVersion = Get-StrictJsonInt64 `
            -Element (Get-StrictJsonProperty -Properties $rootProperties -Name "schemaVersion") `
            -Context "Provisioner registry.schemaVersion"
        if ($schemaVersion -ne 1) {
            throw "Unsupported Provisioner registry schemaVersion: $schemaVersion"
        }
        $workspaceElement = Get-StrictJsonProperty `
            -Properties $rootProperties -Name "workspaces"
        $runtimeElement = Get-StrictJsonProperty `
            -Properties $rootProperties -Name "runtimes"
        if ($workspaceElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Array -or
            $runtimeElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Array) {
            throw "Provisioner registry workspaces and runtimes must be arrays."
        }
        $workspaces = [System.Collections.Generic.List[object]]::new()
        $workspaceIds = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal
        )
        foreach ($entry in $workspaceElement.EnumerateArray()) {
            $properties = @(Get-StrictJsonProperties `
                -Element $entry `
                -ExpectedNames @("id", "root") `
                -Context "Provisioner workspace entry")
            $id = Get-ProvisionerStrictString `
                -Properties $properties -Name "id" -Context "Provisioner workspace entry"
            $root = Get-ProvisionerStrictString `
                -Properties $properties -Name "root" -Context "Provisioner workspace entry"
            if ($id -notmatch '^workspace\.[a-z][a-z0-9-]{0,62}$') {
                throw "Provisioner registry workspace ID is invalid."
            }
            if (-not $workspaceIds.Add($id)) {
                throw "Provisioner registry contains duplicate workspace ID: $id"
            }
            $workspaces.Add([pscustomobject][ordered]@{
                id = $id
                root = Resolve-ProvisionerRegisteredPath `
                    -Path $root `
                    -Context "Registered Workspace $id" `
                    -Directory
            })
        }
        $runtimes = [System.Collections.Generic.List[object]]::new()
        $runtimeIds = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal
        )
        foreach ($entry in $runtimeElement.EnumerateArray()) {
            $properties = @(Get-StrictJsonProperties `
                -Element $entry `
                -ExpectedNames @("id", "packRoot", "manifestPath", "manifestSha256") `
                -Context "Provisioner runtime entry")
            $id = Get-ProvisionerStrictString `
                -Properties $properties -Name "id" -Context "Provisioner runtime entry"
            $packRoot = Get-ProvisionerStrictString `
                -Properties $properties -Name "packRoot" -Context "Provisioner runtime entry"
            $manifestPath = Get-ProvisionerStrictString `
                -Properties $properties -Name "manifestPath" -Context "Provisioner runtime entry"
            $manifestSha256 = Get-ProvisionerStrictString `
                -Properties $properties `
                -Name "manifestSha256" `
                -Context "Provisioner runtime entry"
            if ($id -notmatch '^scopeguard\.[a-z][a-z0-9.-]{0,63}$') {
                throw "Provisioner registry runtime ID is invalid."
            }
            if (-not $runtimeIds.Add($id)) {
                throw "Provisioner registry contains duplicate runtime ID: $id"
            }
            if ($manifestSha256 -notmatch '^[0-9a-f]{64}$') {
                throw "Provisioner registry manifest SHA-256 is invalid."
            }
            $resolvedManifestPath = Resolve-ProvisionerRegisteredPath `
                -Path $manifestPath `
                -Context "Registered Runtime $id manifest"
            Assert-RuntimePackSingleHardLink -Path $resolvedManifestPath
            $runtimes.Add([pscustomobject][ordered]@{
                id = $id
                packRoot = Resolve-ProvisionerRegisteredPath `
                    -Path $packRoot `
                    -Context "Registered Runtime $id root" `
                    -Directory
                manifestPath = $resolvedManifestPath
                manifestSha256 = $manifestSha256
            })
        }
        if ($workspaces.Count -eq 0 -or $runtimes.Count -eq 0) {
            throw "Provisioner registry must contain at least one Workspace and Runtime."
        }
        return [pscustomobject][ordered]@{
            schemaVersion = 1
            path = $registryFile
            workspaces = @($workspaces)
            runtimes = @($runtimes)
        }
    }
    finally {
        if ($null -ne $document) { $document.Dispose() }
    }
}

function Resolve-ProvisionerPlan {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$RegistryPath
    )

    if ($Request.operation -cne "prepare") {
        throw "Only prepare requests resolve a provisioning plan."
    }
    $registry = Read-ProvisionerRegistry -RegistryPath $RegistryPath
    $workspace = @($registry.workspaces | Where-Object id -CEQ $Request.workspaceId)
    if ($workspace.Count -ne 1) {
        throw "Provisioner workspaceId is not registered: $($Request.workspaceId)"
    }
    $runtime = @($registry.runtimes | Where-Object id -CEQ $Request.runtimeId)
    if ($runtime.Count -ne 1) {
        throw "Provisioner runtimeId is not registered: $($Request.runtimeId)"
    }
    $descriptor = Read-VerifiedRuntimePack `
        -PackRoot $runtime[0].packRoot `
        -ManifestPath $runtime[0].manifestPath `
        -ExpectedManifestSha256 $runtime[0].manifestSha256
    if ($descriptor.runtimeId -cne $runtime[0].id) {
        throw "Verified runtime ID does not match the registered runtime ID."
    }
    return [pscustomobject][ordered]@{
        executionId = $Request.executionId
        workspaceId = $workspace[0].id
        workspaceRoot = $workspace[0].root
        runtimeId = $runtime[0].id
        runtimeManifestPath = $runtime[0].manifestPath
        runtime = $descriptor
        profileName = "ScopeGuardExec_$($Request.executionId)"
    }
}

function Get-ProvisionerLedgerPath {
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$ExecutionId
    )

    if ($ExecutionId -notmatch '^[0-9a-f]{32}$') {
        throw "Provisioner executionId is invalid."
    }
    $paths = Get-ProvisionerExecutionPaths `
        -StateRoot $StateRoot `
        -ExecutionId $ExecutionId
    return $paths.ledgerPath
}

function Get-ProvisionerExecutionPaths {
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$ExecutionId
    )

    if ($ExecutionId -notmatch '^[0-9a-f]{32}$') {
        throw "Provisioner executionId is invalid."
    }
    $resolvedStateRoot = Resolve-ProvisionerRegisteredPath `
        -Path $StateRoot `
        -Context "Provisioner state root" `
        -Directory
    $executionRoot = Join-Path $resolvedStateRoot $ExecutionId
    return [pscustomobject][ordered]@{
        stateRoot = $resolvedStateRoot
        executionRoot = $executionRoot
        ledgerPath = Join-Path $executionRoot "lifecycle-ledger.json"
        intentPath = Join-Path $executionRoot "provisioning-intent.json"
        tombstonePath = Join-Path $executionRoot "recovery-tombstone.json"
    }
}

function New-ProvisionerIntent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$ProfileName
    )

    $intent = [pscustomobject][ordered]@{
        schemaVersion = 1
        state = "profile-creation-planned"
        executionId = $Request.executionId
        prepareRequestSha256 = $Request.payloadSha256
        profileName = $ProfileName
        packageSid = ""
        profilePath = ""
        createdAtUtc = [DateTime]::UtcNow.ToString("O")
        updatedAtUtc = [DateTime]::UtcNow.ToString("O")
    }
    Write-SandboxLifecycleLedger -Path $Path -Ledger $intent
    return $intent
}

function Read-ProvisionerIntent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedExecutionId
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Provisioner intent does not exist: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt 64KB -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Provisioner intent must be a regular file below 64 KiB."
    }
    Assert-RuntimePackSingleHardLink -Path $item.FullName
    $document = $null
    try {
        $document = [System.Text.Json.JsonDocument]::Parse(
            [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8)
        )
        $properties = @(Get-StrictJsonProperties `
            -Element $document.RootElement `
            -ExpectedNames @(
                "schemaVersion",
                "state",
                "executionId",
                "prepareRequestSha256",
                "profileName",
                "packageSid",
                "profilePath",
                "createdAtUtc",
                "updatedAtUtc"
            ) `
            -Context "Provisioner intent")
        $schemaVersion = Get-StrictJsonInt64 `
            -Element (Get-StrictJsonProperty -Properties $properties -Name "schemaVersion") `
            -Context "Provisioner intent.schemaVersion"
        if ($schemaVersion -ne 1) {
            throw "Unsupported Provisioner intent schemaVersion: $schemaVersion"
        }
        $intent = [pscustomobject][ordered]@{
            schemaVersion = 1
            state = Get-ProvisionerStrictString `
                -Properties $properties -Name "state" -Context "Provisioner intent"
            executionId = Get-ProvisionerStrictString `
                -Properties $properties -Name "executionId" -Context "Provisioner intent"
            prepareRequestSha256 = Get-ProvisionerStrictString `
                -Properties $properties `
                -Name "prepareRequestSha256" `
                -Context "Provisioner intent"
            profileName = Get-ProvisionerStrictString `
                -Properties $properties -Name "profileName" -Context "Provisioner intent"
            packageSid = Get-ProvisionerStrictString `
                -Properties $properties -Name "packageSid" -Context "Provisioner intent"
            profilePath = Get-ProvisionerStrictString `
                -Properties $properties -Name "profilePath" -Context "Provisioner intent"
            createdAtUtc = Get-ProvisionerStrictString `
                -Properties $properties -Name "createdAtUtc" -Context "Provisioner intent"
            updatedAtUtc = Get-ProvisionerStrictString `
                -Properties $properties -Name "updatedAtUtc" -Context "Provisioner intent"
        }
        if ($intent.executionId -cne $ExpectedExecutionId -or
            $intent.executionId -notmatch '^[0-9a-f]{32}$') {
            throw "Provisioner intent execution identity is invalid."
        }
        if ($intent.profileName -cne "ScopeGuardExec_$ExpectedExecutionId") {
            throw "Provisioner intent profile name is not derived from its execution ID."
        }
        if ($intent.prepareRequestSha256 -notmatch '^[0-9a-f]{64}$') {
            throw "Provisioner intent request digest is invalid."
        }
        if ($intent.state -ceq "profile-creation-planned") {
            if ($intent.packageSid -or $intent.profilePath) {
                throw "A planned Provisioner intent cannot contain Profile identity data."
            }
        }
        elseif ($intent.state -ceq "profile-created") {
            if ($intent.packageSid -notmatch '^S-1-15-2-' -or -not $intent.profilePath) {
                throw "A created Provisioner intent must contain Profile identity data."
            }
        }
        else {
            throw "Unsupported Provisioner intent state: $($intent.state)"
        }
        foreach ($timestamp in @($intent.createdAtUtc, $intent.updatedAtUtc)) {
            $parsed = [DateTimeOffset]::MinValue
            if (-not [DateTimeOffset]::TryParse(
                $timestamp,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind,
                [ref]$parsed
            )) {
                throw "Provisioner intent timestamp is invalid."
            }
        }
        return $intent
    }
    finally {
        if ($null -ne $document) { $document.Dispose() }
    }
}

function Set-ProvisionerIntentProfileCreated {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExecutionId,
        [Parameter(Mandatory)][string]$PackageSid,
        [Parameter(Mandatory)][string]$ProfilePath
    )

    $intent = Read-ProvisionerIntent -Path $Path -ExpectedExecutionId $ExecutionId
    if ($intent.state -cne "profile-creation-planned") {
        throw "Provisioner intent is not awaiting Profile creation."
    }
    if ($PackageSid -notmatch '^S-1-15-2-' -or -not $ProfilePath) {
        throw "Provisioner Profile identity is invalid."
    }
    $intent.state = "profile-created"
    $intent.packageSid = $PackageSid
    $intent.profilePath = [IO.Path]::GetFullPath($ProfilePath).TrimEnd('\')
    $intent.updatedAtUtc = [DateTime]::UtcNow.ToString("O")
    Write-SandboxLifecycleLedger -Path $Path -Ledger $intent
    return $intent
}

function Write-ProvisionerRecoveryTombstone {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Intent,
        [Parameter(Mandatory)][string]$Reason
    )

    $tombstone = [pscustomobject][ordered]@{
        schemaVersion = 1
        state = "recovered"
        executionId = $Intent.executionId
        prepareRequestSha256 = $Intent.prepareRequestSha256
        profileName = $Intent.profileName
        reason = $Reason
        recoveredAtUtc = [DateTime]::UtcNow.ToString("O")
        updatedAtUtc = [DateTime]::UtcNow.ToString("O")
    }
    Write-SandboxLifecycleLedger -Path $Path -Ledger $tombstone
    return $tombstone
}

function Read-ProvisionerRecoveryTombstone {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedExecutionId
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt 64KB -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Provisioner recovery tombstone must be a regular file below 64 KiB."
    }
    Assert-RuntimePackSingleHardLink -Path $item.FullName
    $document = $null
    try {
        $document = [System.Text.Json.JsonDocument]::Parse(
            [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8)
        )
        $properties = @(Get-StrictJsonProperties `
            -Element $document.RootElement `
            -ExpectedNames @(
                "schemaVersion",
                "state",
                "executionId",
                "prepareRequestSha256",
                "profileName",
                "reason",
                "recoveredAtUtc",
                "updatedAtUtc"
            ) `
            -Context "Provisioner recovery tombstone")
        $schemaVersion = Get-StrictJsonInt64 `
            -Element (Get-StrictJsonProperty -Properties $properties -Name "schemaVersion") `
            -Context "Provisioner recovery tombstone.schemaVersion"
        $state = Get-ProvisionerStrictString `
            -Properties $properties `
            -Name "state" `
            -Context "Provisioner recovery tombstone"
        $executionId = Get-ProvisionerStrictString `
            -Properties $properties `
            -Name "executionId" `
            -Context "Provisioner recovery tombstone"
        $requestSha256 = Get-ProvisionerStrictString `
            -Properties $properties `
            -Name "prepareRequestSha256" `
            -Context "Provisioner recovery tombstone"
        $profileName = Get-ProvisionerStrictString `
            -Properties $properties `
            -Name "profileName" `
            -Context "Provisioner recovery tombstone"
        if ($schemaVersion -ne 1 -or $state -cne "recovered" -or
            $executionId -cne $ExpectedExecutionId -or
            $requestSha256 -notmatch '^[0-9a-f]{64}$' -or
            $profileName -cne "ScopeGuardExec_$ExpectedExecutionId") {
            throw "Provisioner recovery tombstone identity is invalid."
        }
        $tombstone = [pscustomobject][ordered]@{
            schemaVersion = 1
            state = $state
            executionId = $executionId
            prepareRequestSha256 = $requestSha256
            profileName = $profileName
            reason = Get-ProvisionerStrictString `
                -Properties $properties `
                -Name "reason" `
                -Context "Provisioner recovery tombstone"
            recoveredAtUtc = Get-ProvisionerStrictString `
                -Properties $properties `
                -Name "recoveredAtUtc" `
                -Context "Provisioner recovery tombstone"
            updatedAtUtc = Get-ProvisionerStrictString `
                -Properties $properties `
                -Name "updatedAtUtc" `
                -Context "Provisioner recovery tombstone"
        }
        if ($tombstone.reason -cne "startup-intent-recovery") {
            throw "Provisioner recovery tombstone reason is invalid."
        }
        foreach ($timestamp in @($tombstone.recoveredAtUtc, $tombstone.updatedAtUtc)) {
            $parsed = [DateTimeOffset]::MinValue
            if (-not [DateTimeOffset]::TryParse(
                $timestamp,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind,
                [ref]$parsed
            )) {
                throw "Provisioner recovery tombstone timestamp is invalid."
            }
        }
        return $tombstone
    }
    finally {
        if ($null -ne $document) { $document.Dispose() }
    }
}

function Remove-ProvisionerExecutionRootIfEmpty {
    param([Parameter(Mandatory)][string]$Path)

    if ((Test-Path -LiteralPath $Path) -and
        @(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Assert-ProvisionerLifecycleIdentity {
    param(
        [Parameter(Mandatory)][object]$Ledger,
        [Parameter(Mandatory)][string]$ExecutionId
    )

    if ($Ledger.executionId -cne $ExecutionId -or
        $Ledger.profileName -cne "ScopeGuardExec_$ExecutionId" -or
        $Ledger.packageSid -notmatch '^S-1-15-2-') {
        throw "Provisioner lifecycle identity is not derived from its execution ID."
    }
}

function Invoke-ProvisionerStartupRecovery {
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    $resolvedStateRoot = Resolve-ProvisionerRegisteredPath `
        -Path $StateRoot `
        -Context "Provisioner state root" `
        -Directory
    $items = [System.Collections.Generic.List[object]]::new()
    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($directory in Get-ChildItem -LiteralPath $resolvedStateRoot -Directory -Force) {
        $executionId = $directory.Name
        if ($executionId -notmatch '^[0-9a-f]{32}$' -or
            ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $errors.Add("Provisioner state directory is invalid: $($directory.FullName)")
            continue
        }
        $paths = Get-ProvisionerExecutionPaths `
            -StateRoot $resolvedStateRoot `
            -ExecutionId $executionId
        try {
            $knownNames = @(
                "lifecycle-ledger.json",
                "provisioning-intent.json",
                "recovery-tombstone.json"
            )
            $unexpected = @(
                Get-ChildItem -LiteralPath $directory.FullName -Force |
                    Where-Object { $_.Name -notin $knownNames }
            )
            if ($unexpected.Count -gt 0) {
                throw "Provisioner state directory contains unexpected entries."
            }
            $hasIntent = Test-Path -LiteralPath $paths.intentPath
            $hasLedger = Test-Path -LiteralPath $paths.ledgerPath
            $hasTombstone = Test-Path -LiteralPath $paths.tombstonePath
            if ($hasIntent) {
                $intent = Read-ProvisionerIntent `
                    -Path $paths.intentPath `
                    -ExpectedExecutionId $executionId
            }
            else {
                $intent = $null
            }
            if ($hasTombstone) {
                $tombstone = Read-ProvisionerRecoveryTombstone `
                    -Path $paths.tombstonePath `
                    -ExpectedExecutionId $executionId
            }
            else {
                $tombstone = $null
            }
            if ($hasLedger -and $hasTombstone) {
                throw "Provisioner lifecycle ledger and recovery tombstone cannot coexist."
            }
            if ($hasIntent -and $hasTombstone -and (
                $intent.prepareRequestSha256 -cne $tombstone.prepareRequestSha256 -or
                $intent.profileName -cne $tombstone.profileName
            )) {
                throw "Provisioner intent and recovery tombstone identities do not match."
            }

            if ($hasLedger) {
                $ledger = Read-SandboxLifecycleLedger -Path $paths.ledgerPath
                Assert-ProvisionerLifecycleIdentity `
                    -Ledger $ledger `
                    -ExecutionId $executionId
                if ($hasIntent -and (
                    $intent.state -cne "profile-created" -or
                    $intent.packageSid -cne $ledger.packageSid -or
                    -not $intent.profilePath.Equals(
                        [IO.Path]::GetFullPath($ledger.profilePath).TrimEnd('\'),
                        [StringComparison]::OrdinalIgnoreCase
                    )
                )) {
                    throw "Provisioner intent and lifecycle identities do not match."
                }
                if ($ledger.state -ne "cleaned") {
                    $recovery = Invoke-SandboxLifecycleRecovery `
                        -LedgerPath $paths.ledgerPath `
                        -Launcher $Launcher
                    if (-not $recovery.passed) {
                        throw "Provisioner lifecycle recovery failed."
                    }
                }
                if ($hasIntent) {
                    Remove-Item -LiteralPath $paths.intentPath -Force
                }
                $cleanedLedger = Read-SandboxLifecycleLedger -Path $paths.ledgerPath
                $items.Add([pscustomobject][ordered]@{
                    executionId = $executionId
                    action = if ($ledger.state -eq "cleaned") {
                        "ledger-already-cleaned"
                    }
                    else {
                        "ledger-recovered"
                    }
                    state = $cleanedLedger.state
                    cleanupAttempts = $cleanedLedger.cleanupAttempts
                    profilePathExists = Test-Path -LiteralPath $cleanedLedger.profilePath
                })
                continue
            }

            if ($hasIntent) {
                $derivedProfilePath = ""
                if ($intent.state -ceq "profile-created") {
                    $derivedProfilePath = (& $Launcher profile-path --name $intent.profileName).Trim()
                    if ($LASTEXITCODE -ne 0 -or -not $derivedProfilePath) {
                        throw "Provisioner recovery could not derive the Profile path."
                    }
                    $derivedProfilePath = [IO.Path]::GetFullPath($derivedProfilePath).TrimEnd('\')
                    if (-not $intent.profilePath.Equals(
                        $derivedProfilePath,
                        [StringComparison]::OrdinalIgnoreCase
                    )) {
                        throw "Provisioner intent Profile path does not match its derived identity."
                    }
                }
                & $Launcher delete --name $intent.profileName | Out-Null
                if ($LASTEXITCODE -ne 0 -or
                    ($derivedProfilePath -and (Test-Path -LiteralPath $derivedProfilePath))) {
                    throw "Provisioner intent-only Profile recovery failed."
                }
                $null = Write-ProvisionerRecoveryTombstone `
                    -Path $paths.tombstonePath `
                    -Intent $intent `
                    -Reason "startup-intent-recovery"
                Remove-Item -LiteralPath $paths.intentPath -Force
                $items.Add([pscustomobject][ordered]@{
                    executionId = $executionId
                    action = "intent-recovered"
                    state = "recovered"
                    cleanupAttempts = 1
                    profilePathExists = $false
                })
                continue
            }

            if ($hasTombstone) {
                $items.Add([pscustomobject][ordered]@{
                    executionId = $executionId
                    action = "tombstone-retained"
                    state = "recovered"
                    cleanupAttempts = 0
                    profilePathExists = $false
                })
                continue
            }
            throw "Provisioner state directory contains no recognized state file."
        }
        catch {
            $errors.Add("$executionId`: $($_.Exception.Message)")
        }
    }
    return [pscustomobject][ordered]@{
        passed = $errors.Count -eq 0
        stateRoot = $resolvedStateRoot
        recovered = @($items)
        errors = @($errors)
    }
}

function Invoke-ProvisionerPrepare {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$RegistryPath,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    $paths = Get-ProvisionerExecutionPaths `
        -StateRoot $StateRoot `
        -ExecutionId $Request.executionId
    $ledgerPath = $paths.ledgerPath
    if ((Test-Path -LiteralPath $paths.intentPath) -or
        (Test-Path -LiteralPath $paths.tombstonePath)) {
        throw "Provisioner execution requires startup recovery or has been recovered."
    }
    if (Test-Path -LiteralPath $ledgerPath) {
        $existing = Read-SandboxLifecycleLedger -Path $ledgerPath
        if ($existing.executionId -cne $Request.executionId -or
            $existing.prepareRequestSha256 -cne $Request.payloadSha256) {
            throw "Provisioner execution conflicts with an existing lifecycle."
        }
        if ($existing.state -eq "cleaned") {
            throw "A cleaned Provisioner execution cannot be prepared again."
        }
        if ($existing.state -ne "prepared") {
            throw "Provisioner execution is not in an idempotent prepared state."
        }
        return [pscustomobject][ordered]@{
            passed = $true
            idempotent = $true
            state = $existing.state
            executionId = $existing.executionId
            workspaceId = $existing.workspaceId
            runtimeId = $existing.runtimeId
            profileName = $existing.profileName
            packageSid = $existing.packageSid
            profilePath = $existing.profilePath
            ledgerPath = $ledgerPath
            runtime = $existing.runtime
        }
    }

    $plan = Resolve-ProvisionerPlan -Request $Request -RegistryPath $RegistryPath
    $null = New-ProvisionerIntent `
        -Path $paths.intentPath `
        -Request $Request `
        -ProfileName $plan.profileName
    $ledgerCreated = $false
    try {
        $packageSid = (& $Launcher profile --name $plan.profileName).Trim()
        if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
            throw "Provisioner failed to create the AppContainer profile."
        }
        $profilePath = (& $Launcher profile-path --name $plan.profileName).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
            throw "Provisioner failed to resolve the AppContainer profile path."
        }
        $null = Set-ProvisionerIntentProfileCreated `
            -Path $paths.intentPath `
            -ExecutionId $Request.executionId `
            -PackageSid $packageSid `
            -ProfilePath $profilePath
        $ledger = New-SandboxLifecycleLedger `
            -Path $ledgerPath `
            -ProfileName $plan.profileName `
            -PackageSid $packageSid `
            -ProfilePath $profilePath
        $ledgerCreated = $true
        $ledger | Add-Member -NotePropertyName executionId -NotePropertyValue $Request.executionId
        $ledger | Add-Member -NotePropertyName workspaceId -NotePropertyValue $plan.workspaceId
        $ledger | Add-Member -NotePropertyName runtimeId -NotePropertyValue $plan.runtimeId
        $ledger | Add-Member `
            -NotePropertyName prepareRequestSha256 `
            -NotePropertyValue $Request.payloadSha256
        $ledger | Add-Member -NotePropertyName runtime -NotePropertyValue ([pscustomobject][ordered]@{
            runtimeId = $plan.runtime.runtimeId
            version = $plan.runtime.version
            executablePath = $plan.runtime.executablePath
            packRoot = $plan.runtime.packRoot
            capabilities = @($plan.runtime.capabilities)
            manifestSha256 = $plan.runtime.manifestSha256
            contentSha256 = $plan.runtime.contentSha256
        })
        Write-SandboxLifecycleLedger -Path $ledgerPath -Ledger $ledger
        Remove-Item -LiteralPath $paths.intentPath -Force

        Grant-SandboxAcl `
            -LedgerPath $ledgerPath `
            -Path $plan.workspaceRoot `
            -Grant "(OI)(CI)(M)" `
            -Recursive
        $ancestor = [IO.Directory]::GetParent($plan.workspaceRoot)
        while ($null -ne $ancestor) {
            Grant-SandboxAcl `
                -LedgerPath $ledgerPath `
                -Path $ancestor.FullName `
                -Grant "(RX)"
            $ancestor = $ancestor.Parent
        }
        Grant-SandboxAcl `
            -LedgerPath $ledgerPath `
            -Path $plan.runtime.packRoot `
            -Grant "(OI)(CI)(RX)" `
            -Recursive

        $verifiedAgain = Read-VerifiedRuntimePack `
            -PackRoot $plan.runtime.packRoot `
            -ManifestPath $plan.runtimeManifestPath `
            -ExpectedManifestSha256 $plan.runtime.manifestSha256
        if ($verifiedAgain.contentSha256 -cne $plan.runtime.contentSha256 -or
            $verifiedAgain.executablePath -cne $plan.runtime.executablePath) {
            throw "Provisioner runtime identity changed during preparation."
        }
        $ledger = Read-SandboxLifecycleLedger -Path $ledgerPath
        $ledger.state = "prepared"
        Write-SandboxLifecycleLedger -Path $ledgerPath -Ledger $ledger
        return [pscustomobject][ordered]@{
            passed = $true
            idempotent = $false
            state = "prepared"
            executionId = $Request.executionId
            workspaceId = $plan.workspaceId
            runtimeId = $plan.runtimeId
            profileName = $plan.profileName
            packageSid = $packageSid
            profilePath = $profilePath
            ledgerPath = $ledgerPath
            runtime = $ledger.runtime
        }
    }
    catch {
        $prepareError = $_
        if ($ledgerCreated -and (Test-Path -LiteralPath $ledgerPath)) {
            try {
                $recovery = Invoke-SandboxLifecycleRecovery `
                    -LedgerPath $ledgerPath `
                    -Launcher $Launcher
                if (-not $recovery.passed) {
                    throw "Provisioner lifecycle recovery did not complete."
                }
                if (Test-Path -LiteralPath $paths.intentPath) {
                    Remove-Item -LiteralPath $paths.intentPath -Force
                }
            }
            catch {
                throw "Provisioner prepare failed and recovery also failed: $prepareError; $_"
            }
        }
        else {
            try {
                $intent = Read-ProvisionerIntent `
                    -Path $paths.intentPath `
                    -ExpectedExecutionId $Request.executionId
                & $Launcher delete --name $plan.profileName | Out-Null
                if ($LASTEXITCODE -ne 0 -or
                    ($intent.profilePath -and
                        (Test-Path -LiteralPath $intent.profilePath))) {
                    throw "Provisioner Profile cleanup did not complete."
                }
                Remove-Item -LiteralPath $paths.intentPath -Force
                Remove-ProvisionerExecutionRootIfEmpty -Path $paths.executionRoot
            }
            catch {
                throw "Provisioner prepare failed and Profile cleanup also failed: $prepareError; $_"
            }
        }
        throw $prepareError
    }
}

function Invoke-ProvisionerCleanup {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    if ($Request.operation -cne "cleanup") {
        throw "Only cleanup requests can clean a lifecycle."
    }
    $ledgerPath = Get-ProvisionerLedgerPath `
        -StateRoot $StateRoot `
        -ExecutionId $Request.executionId
    if (-not (Test-Path -LiteralPath $ledgerPath)) {
        throw "Provisioner lifecycle does not exist."
    }
    $ledger = Read-SandboxLifecycleLedger -Path $ledgerPath
    if ($ledger.executionId -cne $Request.executionId) {
        throw "Provisioner cleanup execution ID does not match its ledger."
    }
    if ($ledger.state -eq "cleaned") {
        return [pscustomobject][ordered]@{
            passed = $true
            idempotent = $true
            state = "cleaned"
            cleanupAttempts = $ledger.cleanupAttempts
            executionId = $ledger.executionId
            profileName = $ledger.profileName
            packageSid = $ledger.packageSid
            profilePath = $ledger.profilePath
            profilePathExists = Test-Path -LiteralPath $ledger.profilePath
            ledgerPath = $ledgerPath
            errors = @($ledger.lastCleanupErrors)
        }
    }
    $result = Invoke-SandboxLifecycleRecovery `
        -LedgerPath $ledgerPath `
        -Launcher $Launcher
    $cleanedLedger = Read-SandboxLifecycleLedger -Path $ledgerPath
    if ($cleanedLedger.PSObject.Properties.Name -contains "cleanupRequestSha256") {
        $cleanedLedger.cleanupRequestSha256 = $Request.payloadSha256
    }
    else {
        $cleanedLedger | Add-Member `
            -NotePropertyName cleanupRequestSha256 `
            -NotePropertyValue $Request.payloadSha256
    }
    Write-SandboxLifecycleLedger -Path $ledgerPath -Ledger $cleanedLedger
    return [pscustomobject][ordered]@{
        passed = $result.passed
        idempotent = $false
        state = $result.state
        cleanupAttempts = $result.cleanupAttempts
        executionId = $cleanedLedger.executionId
        profileName = $result.profileName
        packageSid = $result.packageSid
        profilePath = $result.profilePath
        profilePathExists = $result.profilePathExists
        ledgerPath = $ledgerPath
        errors = @($result.errors)
    }
}

function Assert-ProvisionerAclLedger {
    param(
        [Parameter(Mandatory)][object]$Ledger,
        [Parameter(Mandatory)][string]$ExecutionId
    )

    Assert-ProvisionerLifecycleIdentity `
        -Ledger $Ledger `
        -ExecutionId $ExecutionId
    if ($Ledger.PSObject.Properties.Name -notcontains "profileOwner" -or
        $Ledger.profileOwner -cne "broker-user") {
        throw "Provisioner service ledger is not Broker-owned Profile state."
    }
}

function Invoke-ProvisionerAclRecovery {
    param(
        [Parameter(Mandatory)][string]$LedgerPath,
        [Parameter(Mandatory)][string]$Launcher
    )

    return Invoke-SandboxLifecycleRecovery `
        -LedgerPath $LedgerPath `
        -Launcher $Launcher `
        -SkipProfileDelete
}

function Invoke-ProvisionerAclStartupRecovery {
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    $resolvedStateRoot = Resolve-ProvisionerRegisteredPath `
        -Path $StateRoot `
        -Context "Provisioner ACL state root" `
        -Directory
    $items = [System.Collections.Generic.List[object]]::new()
    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($directory in Get-ChildItem -LiteralPath $resolvedStateRoot -Directory -Force) {
        $executionId = $directory.Name
        if ($executionId -notmatch '^[0-9a-f]{32}$' -or
            ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $errors.Add("Provisioner ACL state directory is invalid: $($directory.FullName)")
            continue
        }
        $paths = Get-ProvisionerExecutionPaths `
            -StateRoot $resolvedStateRoot `
            -ExecutionId $executionId
        try {
            $entries = @(Get-ChildItem -LiteralPath $directory.FullName -Force)
            if ($entries.Count -ne 1 -or
                $entries[0].Name -cne "lifecycle-ledger.json") {
                throw "Provisioner ACL state directory must contain exactly one lifecycle ledger."
            }
            $ledger = Read-SandboxLifecycleLedger -Path $paths.ledgerPath
            Assert-ProvisionerAclLedger `
                -Ledger $ledger `
                -ExecutionId $executionId
            if ($ledger.state -ne "cleaned") {
                $recovery = Invoke-ProvisionerAclRecovery `
                    -LedgerPath $paths.ledgerPath `
                    -Launcher $Launcher
                if (-not $recovery.passed) {
                    throw "Provisioner ACL recovery failed."
                }
            }
            $cleanedLedger = Read-SandboxLifecycleLedger -Path $paths.ledgerPath
            $items.Add([pscustomobject][ordered]@{
                executionId = $executionId
                action = if ($ledger.state -eq "cleaned") {
                    "acl-ledger-already-cleaned"
                }
                else {
                    "acl-ledger-recovered"
                }
                state = $cleanedLedger.state
                cleanupAttempts = $cleanedLedger.cleanupAttempts
                profileOwner = $cleanedLedger.profileOwner
            })
        }
        catch {
            $errors.Add("$executionId`: $($_.Exception.Message)")
        }
    }
    return [pscustomobject][ordered]@{
        passed = $errors.Count -eq 0
        stateRoot = $resolvedStateRoot
        recovered = @($items)
        errors = @($errors)
    }
}

function Invoke-ProvisionerAclPrepare {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$RegistryPath,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    if ($Request.operation -cne "prepare") {
        throw "Only prepare requests can prepare service ACL state."
    }
    $paths = Get-ProvisionerExecutionPaths `
        -StateRoot $StateRoot `
        -ExecutionId $Request.executionId
    if (Test-Path -LiteralPath $paths.ledgerPath) {
        $existing = Read-SandboxLifecycleLedger -Path $paths.ledgerPath
        Assert-ProvisionerAclLedger `
            -Ledger $existing `
            -ExecutionId $Request.executionId
        if ($existing.prepareRequestSha256 -cne $Request.payloadSha256) {
            throw "Provisioner ACL execution conflicts with an existing lifecycle."
        }
        if ($existing.state -eq "cleaned") {
            throw "A cleaned Provisioner ACL execution cannot be prepared again."
        }
        if ($existing.state -ne "prepared") {
            throw "Provisioner ACL execution is not in an idempotent prepared state."
        }
        return [pscustomobject][ordered]@{
            passed = $true
            idempotent = $true
            state = $existing.state
            executionId = $existing.executionId
            workspaceId = $existing.workspaceId
            runtimeId = $existing.runtimeId
            profileName = $existing.profileName
            packageSid = $existing.packageSid
            profileOwner = $existing.profileOwner
            profileCleanupRequired = $true
            ledgerPath = $paths.ledgerPath
            runtime = $existing.runtime
        }
    }

    $plan = Resolve-ProvisionerPlan -Request $Request -RegistryPath $RegistryPath
    $packageSid = (& $Launcher sid --name $plan.profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
        throw "Provisioner service failed to derive the AppContainer Package SID."
    }
    $ledger = New-SandboxLifecycleLedger `
        -Path $paths.ledgerPath `
        -ProfileName $plan.profileName `
        -PackageSid $packageSid `
        -ProfilePath ""
    $ledger | Add-Member -NotePropertyName executionId -NotePropertyValue $Request.executionId
    $ledger | Add-Member -NotePropertyName workspaceId -NotePropertyValue $plan.workspaceId
    $ledger | Add-Member -NotePropertyName runtimeId -NotePropertyValue $plan.runtimeId
    $ledger | Add-Member -NotePropertyName profileOwner -NotePropertyValue "broker-user"
    $ledger | Add-Member `
        -NotePropertyName prepareRequestSha256 `
        -NotePropertyValue $Request.payloadSha256
    $ledger | Add-Member -NotePropertyName runtime -NotePropertyValue ([pscustomobject][ordered]@{
        runtimeId = $plan.runtime.runtimeId
        version = $plan.runtime.version
        executablePath = $plan.runtime.executablePath
        packRoot = $plan.runtime.packRoot
        capabilities = @($plan.runtime.capabilities)
        manifestSha256 = $plan.runtime.manifestSha256
        contentSha256 = $plan.runtime.contentSha256
    })
    Write-SandboxLifecycleLedger -Path $paths.ledgerPath -Ledger $ledger
    try {
        Grant-SandboxAcl `
            -LedgerPath $paths.ledgerPath `
            -Path $plan.workspaceRoot `
            -Grant "(OI)(CI)(M)" `
            -Recursive
        $ancestor = [IO.Directory]::GetParent($plan.workspaceRoot)
        while ($null -ne $ancestor) {
            Grant-SandboxAcl `
                -LedgerPath $paths.ledgerPath `
                -Path $ancestor.FullName `
                -Grant "(RX)"
            $ancestor = $ancestor.Parent
        }
        Grant-SandboxAcl `
            -LedgerPath $paths.ledgerPath `
            -Path $plan.runtime.packRoot `
            -Grant "(OI)(CI)(RX)" `
            -Recursive
        $verifiedAgain = Read-VerifiedRuntimePack `
            -PackRoot $plan.runtime.packRoot `
            -ManifestPath $plan.runtimeManifestPath `
            -ExpectedManifestSha256 $plan.runtime.manifestSha256
        if ($verifiedAgain.contentSha256 -cne $plan.runtime.contentSha256 -or
            $verifiedAgain.executablePath -cne $plan.runtime.executablePath) {
            throw "Provisioner runtime identity changed during ACL preparation."
        }
        $ledger = Read-SandboxLifecycleLedger -Path $paths.ledgerPath
        $ledger.state = "prepared"
        Write-SandboxLifecycleLedger -Path $paths.ledgerPath -Ledger $ledger
        return [pscustomobject][ordered]@{
            passed = $true
            idempotent = $false
            state = "prepared"
            executionId = $Request.executionId
            workspaceId = $plan.workspaceId
            runtimeId = $plan.runtimeId
            profileName = $plan.profileName
            packageSid = $packageSid
            profileOwner = "broker-user"
            profileCleanupRequired = $true
            ledgerPath = $paths.ledgerPath
            runtime = $ledger.runtime
        }
    }
    catch {
        $prepareError = $_
        try {
            $recovery = Invoke-ProvisionerAclRecovery `
                -LedgerPath $paths.ledgerPath `
                -Launcher $Launcher
            if (-not $recovery.passed) {
                throw "Provisioner ACL recovery did not complete."
            }
        }
        catch {
            throw "Provisioner ACL prepare failed and recovery also failed: $prepareError; $_"
        }
        throw $prepareError
    }
}

function Invoke-ProvisionerAclCleanup {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    if ($Request.operation -cne "cleanup") {
        throw "Only cleanup requests can clean service ACL state."
    }
    $ledgerPath = Get-ProvisionerLedgerPath `
        -StateRoot $StateRoot `
        -ExecutionId $Request.executionId
    if (-not (Test-Path -LiteralPath $ledgerPath)) {
        throw "Provisioner ACL lifecycle does not exist."
    }
    $ledger = Read-SandboxLifecycleLedger -Path $ledgerPath
    Assert-ProvisionerAclLedger `
        -Ledger $ledger `
        -ExecutionId $Request.executionId
    $idempotent = $ledger.state -eq "cleaned"
    $result = if ($idempotent) {
        [pscustomobject][ordered]@{
            passed = $true
            state = "cleaned"
            cleanupAttempts = $ledger.cleanupAttempts
            errors = @($ledger.lastCleanupErrors)
        }
    }
    else {
        Invoke-ProvisionerAclRecovery `
            -LedgerPath $ledgerPath `
            -Launcher $Launcher
    }
    $cleanedLedger = Read-SandboxLifecycleLedger -Path $ledgerPath
    if ($cleanedLedger.PSObject.Properties.Name -contains "cleanupRequestSha256") {
        $cleanedLedger.cleanupRequestSha256 = $Request.payloadSha256
    }
    else {
        $cleanedLedger | Add-Member `
            -NotePropertyName cleanupRequestSha256 `
            -NotePropertyValue $Request.payloadSha256
    }
    Write-SandboxLifecycleLedger -Path $ledgerPath -Ledger $cleanedLedger
    return [pscustomobject][ordered]@{
        passed = $result.passed
        idempotent = $idempotent
        state = $result.state
        cleanupAttempts = $result.cleanupAttempts
        executionId = $cleanedLedger.executionId
        profileName = $cleanedLedger.profileName
        packageSid = $cleanedLedger.packageSid
        profileOwner = $cleanedLedger.profileOwner
        profileCleanupRequired = $true
        ledgerPath = $ledgerPath
        errors = @($result.errors)
    }
}
