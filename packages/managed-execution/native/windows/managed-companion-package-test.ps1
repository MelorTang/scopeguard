[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The managed companion package matrix must run on Windows."
}

$PackageRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PackageRoot).Path).TrimEnd('\')
$verifier = Join-Path $PSScriptRoot "verify-managed-companion.ps1"
$manifestPath = Join-Path $PackageRoot "managed-companion-manifest.json"
$scriptPath = Join-Path $PackageRoot "payload\scripts\provisioner-service-worker.ps1"
$checks = [Collections.Generic.List[object]]::new()

function Invoke-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$ShouldPass,
        [Parameter(Mandatory)][scriptblock]$Mutation,
        [Parameter(Mandatory)][scriptblock]$Restore,
        [string[]]$VerifierArguments = @()
    )

    try {
        & $Mutation
        $output = @(& pwsh.exe -NoLogo -NoProfile -File $verifier `
            -PackageRoot $PackageRoot @VerifierArguments 2>&1)
        $passed = $LASTEXITCODE -eq 0
        $checks.Add([pscustomobject][ordered]@{
            name = $Name
            passed = $passed -eq $ShouldPass
            verifierPassed = $passed
            detail = ($output | Out-String).Trim()
        })
    }
    finally {
        & $Restore
    }
}

$manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
$scriptBytes = [IO.File]::ReadAllBytes($scriptPath)
$extraPath = Join-Path $PackageRoot "payload\unexpected.txt"
$linkPath = Join-Path $PackageRoot "payload\scripts-link"
$streamName = "scopeguard-package-test"
$streamPath = "${scriptPath}:$streamName"

Invoke-Check -Name "valid-package" -ShouldPass $true -Mutation {} -Restore {}
Invoke-Check `
    -Name "unsigned-release-rejected" `
    -ShouldPass $false `
    -Mutation {} `
    -Restore {} `
    -VerifierArguments @("-RequireTrustedSignature")
Invoke-Check -Name "extra-file-rejected" -ShouldPass $false -Mutation {
    [IO.File]::WriteAllText($extraPath, "unexpected", [Text.UTF8Encoding]::new($false))
} -Restore {
    Remove-Item -LiteralPath $extraPath -Force -ErrorAction SilentlyContinue
}
Invoke-Check -Name "payload-tamper-rejected" -ShouldPass $false -Mutation {
    [IO.File]::AppendAllText($scriptPath, "`n# tampered", [Text.UTF8Encoding]::new($false))
} -Restore {
    [IO.File]::WriteAllBytes($scriptPath, $scriptBytes)
}
Invoke-Check -Name "manifest-schema-drift-rejected" -ShouldPass $false -Mutation {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 12
    $manifest | Add-Member -NotePropertyName unexpected -NotePropertyValue $true
    [IO.File]::WriteAllText(
        $manifestPath,
        ($manifest | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
    )
} -Restore {
    [IO.File]::WriteAllBytes($manifestPath, $manifestBytes)
}
Invoke-Check -Name "duplicate-manifest-property-rejected" -ShouldPass $false -Mutation {
    $json = [IO.File]::ReadAllText($manifestPath)
    [IO.File]::WriteAllText(
        $manifestPath,
        $json.Insert(1, '"schemaVersion":1,'),
        [Text.UTF8Encoding]::new($false)
    )
} -Restore {
    [IO.File]::WriteAllBytes($manifestPath, $manifestBytes)
}
Invoke-Check -Name "alternate-data-stream-rejected" -ShouldPass $false -Mutation {
    [IO.File]::WriteAllText($streamPath, "unexpected", [Text.UTF8Encoding]::new($false))
} -Restore {
    Remove-Item -LiteralPath $scriptPath -Stream $streamName -Force -ErrorAction SilentlyContinue
}

$linkCreated = $false
try {
    New-Item `
        -ItemType Junction `
        -Path $linkPath `
        -Target (Split-Path -Parent $scriptPath) `
        -ErrorAction Stop | Out-Null
    $linkCreated = $true
}
catch {
    $checks.Add([pscustomobject][ordered]@{
        name = "reparse-point-rejected"
        passed = $false
        verifierPassed = $false
        detail = "Test setup could not create a junction: $($_.Exception.Message)"
    })
}
if ($linkCreated) {
    Invoke-Check -Name "reparse-point-rejected" -ShouldPass $false -Mutation {} -Restore {
        Remove-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    }
}

$failed = @($checks | Where-Object { -not $_.passed })
$result = [pscustomobject][ordered]@{
    schemaVersion = 1
    passed = $failed.Count -eq 0
    checks = $checks
}
$result | ConvertTo-Json -Depth 6
if ($failed.Count -gt 0) {
    throw "$($failed.Count) managed companion package checks failed."
}
