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
    $payloadDocument = $null
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

        $payloadJson = [Text.Encoding]::UTF8.GetString($payloadBytes)
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
            payloadSha256 = Get-ProvisionerSha256Hex -Bytes $payloadBytes
        }
    }
    finally {
        if ($null -ne $payloadDocument) { $payloadDocument.Dispose() }
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
    $resolvedStateRoot = Resolve-ProvisionerRegisteredPath `
        -Path $StateRoot `
        -Context "Provisioner state root" `
        -Directory
    return Join-Path (Join-Path $resolvedStateRoot $ExecutionId) "lifecycle-ledger.json"
}

function Invoke-ProvisionerPrepare {
    param(
        [Parameter(Mandatory)][object]$Request,
        [Parameter(Mandatory)][string]$RegistryPath,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$Launcher
    )

    Assert-ProvisionerElevated
    $ledgerPath = Get-ProvisionerLedgerPath `
        -StateRoot $StateRoot `
        -ExecutionId $Request.executionId
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
    $packageSid = (& $Launcher profile --name $plan.profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageSid -notmatch '^S-1-15-2-') {
        throw "Provisioner failed to create the AppContainer profile."
    }
    $profilePath = (& $Launcher profile-path --name $plan.profileName).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $profilePath) {
        & $Launcher delete --name $plan.profileName | Out-Null
        throw "Provisioner failed to resolve the AppContainer profile path."
    }
    $ledgerCreated = $false
    try {
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
                $null = Invoke-SandboxLifecycleRecovery `
                    -LedgerPath $ledgerPath `
                    -Launcher $Launcher
            }
            catch {
                throw "Provisioner prepare failed and recovery also failed: $prepareError; $_"
            }
        }
        else {
            & $Launcher delete --name $plan.profileName | Out-Null
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
