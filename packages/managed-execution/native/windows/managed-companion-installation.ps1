Set-StrictMode -Version Latest

function Assert-ManagedInstallerElevated {
    if (-not $IsWindows) {
        throw "Managed companion installation requires Windows."
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Managed companion installation requires an elevated Administrator token."
    }
}

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-ManagedChildPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Context
    )

    $fullPath = Get-NormalizedPath -Path $Path
    $fullParent = Get-NormalizedPath -Path $Parent
    if (-not $fullPath.StartsWith(
        "$fullParent\",
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "$Context must be below $fullParent."
    }
    return $fullPath
}

function Assert-ManagedNoReparsePoint {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Context
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Context cannot be a reparse point."
    }
    return $item
}

function Assert-ManagedExistingDirectoryNotReparse {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Context
    )

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Assert-ManagedNoReparsePoint -Path $Path -Context $Context
    if (-not $item.PSIsContainer) {
        throw "$Context must be a directory."
    }
}

function Get-ManagedSha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-ManagedUtf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        ($Value | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::Move($temporaryPath, $Path, $true)
}

function Quote-ManagedServiceArgument {
    param([Parameter(Mandatory)][string]$Value)

    if (-not $Value -or $Value.Contains('"')) {
        throw "Service argument is empty or contains a quote."
    }
    return '"' + $Value + '"'
}

function Wait-ManagedServiceState {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet("Running", "Stopped")][string]$State,
        [int]$TimeoutSeconds = 90
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if ($service -and $service.Status.ToString() -ceq $State) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Service $Name did not reach $State."
}

function Remove-ManagedService {
    param([Parameter(Mandatory)][string]$Name)

    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service) { return }
    if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        Wait-ManagedServiceState -Name $Name -State "Stopped"
    }
    & sc.exe delete $Name | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to delete service $Name."
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    while ((Get-Service -Name $Name -ErrorAction SilentlyContinue) -and
        [DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        throw "Service $Name remained registered after deletion."
    }
}

function Set-ManagedInstallAcl {
    param([Parameter(Mandatory)][string]$Path)

    & icacls.exe $Path /inheritance:r /grant:r `
        '*S-1-5-18:(OI)(CI)(F)' `
        '*S-1-5-32-544:(OI)(CI)(F)' `
        '*S-1-5-32-545:(OI)(CI)(RX)' /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to protect the managed installation root."
    }
    & icacls.exe "$Path\*" /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to inherit the managed installation ACL into its payload."
    }
}

function Set-ManagedStateAcl {
    param([Parameter(Mandatory)][string]$Path)

    & icacls.exe $Path /inheritance:r /grant:r `
        '*S-1-5-18:(OI)(CI)(F)' `
        '*S-1-5-32-544:(OI)(CI)(F)' /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to protect the managed state root."
    }
    & icacls.exe "$Path\*" /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to inherit the managed state ACL into its contents."
    }
}

function Copy-ManagedDirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse
    }
}

function Get-ManagedRegistrySnapshot {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-ItemProperty -LiteralPath $Path
    $values = [ordered]@{}
    foreach ($property in $item.PSObject.Properties) {
        if ($property.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$') {
            $values[$property.Name] = $property.Value
        }
    }
    return $values
}

function Restore-ManagedRegistrySnapshot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [AllowNull()][object]$Snapshot
    )

    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    if ($null -eq $Snapshot) { return }
    New-Item -Path $Path -Force | Out-Null
    foreach ($entry in $Snapshot.GetEnumerator()) {
        Set-ItemProperty -LiteralPath $Path -Name $entry.Key -Value $entry.Value
    }
}

function Get-ManagedFileBackup {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllBytes($Path)
}

function Restore-ManagedFileBackup {
    param(
        [Parameter(Mandatory)][string]$Path,
        [AllowNull()][byte[]]$Bytes
    )

    if ($null -eq $Bytes) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        return
    }
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [IO.File]::WriteAllBytes($Path, $Bytes)
}

function Test-ManagedStateClean {
    param([Parameter(Mandatory)][string]$ExecutionStateRoot)

    if (-not (Test-Path -LiteralPath $ExecutionStateRoot)) { return $true }
    try {
        $root = Assert-ManagedNoReparsePoint `
            -Path $ExecutionStateRoot `
            -Context "Managed execution state root"
    }
    catch { return $false }
    if (-not $root.PSIsContainer) { return $false }
    foreach ($directory in Get-ChildItem -LiteralPath $ExecutionStateRoot -Force) {
        if (-not $directory.PSIsContainer -or
            ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $false
        }
        if ($directory.Name -notmatch '^[0-9a-f]{32}$') { return $false }
        $entries = @(Get-ChildItem -LiteralPath $directory.FullName -Force)
        if ($entries.Count -ne 1 -or
            $entries[0].Name -cne "lifecycle-ledger.json" -or
            ($entries[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $false
        }
        $ledgerPath = Join-Path $directory.FullName "lifecycle-ledger.json"
        if (-not (Test-Path -LiteralPath $ledgerPath -PathType Leaf)) { return $false }
        try {
            $ledger = Get-Content -LiteralPath $ledgerPath -Raw | ConvertFrom-Json -Depth 12
            if ($ledger.schemaVersion -ne 1 -or
                $ledger.executionId -cne $directory.Name -or
                $ledger.profileName -cne "ScopeGuardExec_$($directory.Name)" -or
                $ledger.state -cne "cleaned" -or
                @($ledger.lastCleanupErrors).Count -ne 0) {
                return $false
            }
        }
        catch { return $false }
    }
    return $true
}
