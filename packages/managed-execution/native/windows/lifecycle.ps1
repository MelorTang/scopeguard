Set-StrictMode -Version Latest

function Write-SandboxLifecycleLedger {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [object]$Ledger
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $Ledger.updatedAtUtc = [DateTime]::UtcNow.ToString("O")
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $json = $Ledger | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText(
        $temporaryPath,
        $json,
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::Move($temporaryPath, $Path, $true)
}

function Read-SandboxLifecycleLedger {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Sandbox lifecycle ledger does not exist: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 12
}

function New-SandboxLifecycleLedger {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$ProfileName,
        [Parameter(Mandatory)]
        [string]$PackageSid,
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$ProfilePath
    )

    $ledger = [pscustomobject][ordered]@{
        schemaVersion = 1
        state = "provisioning"
        profileName = $ProfileName
        packageSid = $PackageSid
        profilePath = $ProfilePath
        createdAtUtc = [DateTime]::UtcNow.ToString("O")
        updatedAtUtc = [DateTime]::UtcNow.ToString("O")
        aclGrants = @()
        cleanupAttempts = 0
        lastCleanupErrors = @()
    }
    Write-SandboxLifecycleLedger -Path $Path -Ledger $ledger
    return $ledger
}

function Grant-SandboxAcl {
    param(
        [Parameter(Mandatory)]
        [string]$LedgerPath,
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Grant,
        [switch]$Recursive
    )

    $ledger = Read-SandboxLifecycleLedger -Path $LedgerPath
    if ($ledger.state -eq "cleaned") {
        throw "Cannot add an ACL grant to a cleaned sandbox lifecycle."
    }

    $operationId = [guid]::NewGuid().ToString("N")
    $entry = [pscustomobject][ordered]@{
        operationId = $operationId
        path = [IO.Path]::GetFullPath($Path)
        recursive = [bool]$Recursive
        grant = $Grant
        state = "planned"
        error = $null
    }
    $ledger.aclGrants = @($ledger.aclGrants) + $entry
    Write-SandboxLifecycleLedger -Path $LedgerPath -Ledger $ledger

    $arguments = @(
        $entry.path,
        "/grant",
        "*$($ledger.packageSid):$Grant",
        "/C",
        "/Q"
    )
    if ($Recursive) {
        $arguments += "/T"
    }
    $output = (& icacls.exe @arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE

    $grantVerified = $exitCode -eq 0 -and (Test-SandboxSidAcePresentEverywhere `
        -Path $entry.path `
        -PackageSid $ledger.packageSid `
        -Recursive ([bool]$Recursive))

    $ledger = Read-SandboxLifecycleLedger -Path $LedgerPath
    $recordedEntry = @($ledger.aclGrants | Where-Object operationId -EQ $operationId)[0]
    if ($grantVerified) {
        $recordedEntry.state = "applied"
    }
    else {
        $recordedEntry.state = "grant-failed"
        $recordedEntry.error = "exit=$exitCode; verified=$grantVerified; output=$output"
    }
    Write-SandboxLifecycleLedger -Path $LedgerPath -Ledger $ledger

    if (-not $grantVerified) {
        throw "icacls grant failed verification for $Path. $($recordedEntry.error)"
    }
}

function Get-SandboxAclPaths {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [bool]$Recursive
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }
    $paths = [System.Collections.Generic.List[string]]::new()
    $paths.Add([IO.Path]::GetFullPath($Path))
    if ($Recursive) {
        Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop |
            ForEach-Object { $paths.Add($_.FullName) }
    }
    return $paths
}

function Test-SandboxSidAcePresentEverywhere {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$PackageSid,
        [bool]$Recursive
    )

    try {
        $aclPaths = @(Get-SandboxAclPaths -Path $Path -Recursive $Recursive)
    }
    catch {
        return $false
    }
    if ($aclPaths.Count -eq 0) {
        return $false
    }
    foreach ($aclPath in $aclPaths) {
        try {
            $acl = Get-Acl -LiteralPath $aclPath -ErrorAction Stop
        }
        catch {
            return $false
        }
        $found = $false
        foreach ($rule in $acl.Access) {
            $identity = $rule.IdentityReference.Value
            try {
                $identity = $rule.IdentityReference.Translate(
                    [Security.Principal.SecurityIdentifier]
                ).Value
            }
            catch {
                # Deleted AppContainer profiles are represented by their SID string.
            }
            if ($identity -eq $PackageSid) {
                $found = $true
                break
            }
        }
        if (-not $found) {
            return $false
        }
    }
    return $true
}

function Test-SandboxSidAceAbsent {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$PackageSid,
        [bool]$Recursive
    )

    foreach ($aclPath in Get-SandboxAclPaths -Path $Path -Recursive $Recursive) {
        try {
            $acl = Get-Acl -LiteralPath $aclPath -ErrorAction Stop
        }
        catch {
            return $false
        }
        foreach ($rule in $acl.Access) {
            $identity = $rule.IdentityReference.Value
            try {
                $identity = $rule.IdentityReference.Translate(
                    [Security.Principal.SecurityIdentifier]
                ).Value
            }
            catch {
                # Deleted AppContainer profiles are represented by their SID string.
            }
            if ($identity -eq $PackageSid) {
                return $false
            }
        }
    }
    return $true
}

function Invoke-SandboxLifecycleRecovery {
    param(
        [Parameter(Mandatory)]
        [string]$LedgerPath,
        [Parameter(Mandatory)]
        [string]$Launcher,
        [int]$ProfileDeleteAttempts = 3,
        [switch]$SkipProfileDelete
    )

    $ledger = Read-SandboxLifecycleLedger -Path $LedgerPath
    $ledger.state = "cleaning"
    $ledger.cleanupAttempts = [int]$ledger.cleanupAttempts + 1
    $ledger.lastCleanupErrors = @()
    Write-SandboxLifecycleLedger -Path $LedgerPath -Ledger $ledger

    $errors = [System.Collections.Generic.List[string]]::new()
    $grants = @($ledger.aclGrants)
    [array]::Reverse($grants)
    foreach ($entry in $grants) {
        if (-not (Test-Path -LiteralPath $entry.path)) {
            $entry.state = "removed-path-missing"
            Write-SandboxLifecycleLedger -Path $LedgerPath -Ledger $ledger
            continue
        }

        $arguments = @(
            $entry.path,
            "/remove:g",
            "*$($ledger.packageSid)",
            "/C",
            "/Q"
        )
        if ($entry.recursive) {
            $arguments += "/T"
        }
        $output = (& icacls.exe @arguments 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
        $aceAbsent = Test-SandboxSidAceAbsent `
            -Path $entry.path `
            -PackageSid $ledger.packageSid `
            -Recursive $entry.recursive
        if ($exitCode -eq 0 -and $aceAbsent) {
            $entry.state = "removed"
            $entry.error = $null
        }
        else {
            $entry.state = "remove-failed"
            $entry.error = "exit=$exitCode; aceAbsent=$aceAbsent; output=$output"
            $errors.Add("ACL cleanup failed for $($entry.path): $($entry.error)")
        }
        Write-SandboxLifecycleLedger -Path $LedgerPath -Ledger $ledger
    }

    if ($errors.Count -eq 0 -and -not $SkipProfileDelete) {
        $profileDeleted = $false
        for ($attempt = 1; $attempt -le $ProfileDeleteAttempts; $attempt++) {
            $output = (& $Launcher delete --name $ledger.profileName 2>&1 | Out-String).Trim()
            $exitCode = $LASTEXITCODE
            $profileDeleted = $exitCode -eq 0 -and
                -not (Test-Path -LiteralPath $ledger.profilePath)
            if ($profileDeleted) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $profileDeleted) {
            $errors.Add(
                "Profile cleanup failed for $($ledger.profileName): exit=$exitCode; output=$output"
            )
        }
    }

    $ledger.lastCleanupErrors = @($errors)
    $ledger.state = if ($errors.Count -eq 0) { "cleaned" } else { "cleanup-failed" }
    Write-SandboxLifecycleLedger -Path $LedgerPath -Ledger $ledger

    return [pscustomobject][ordered]@{
        passed = $errors.Count -eq 0
        state = $ledger.state
        cleanupAttempts = $ledger.cleanupAttempts
        profileName = $ledger.profileName
        packageSid = $ledger.packageSid
        profilePath = $ledger.profilePath
        profilePathExists = if ($ledger.profilePath) {
            Test-Path -LiteralPath $ledger.profilePath
        }
        else {
            $false
        }
        errors = @($errors)
        aclGrants = $ledger.aclGrants
    }
}
