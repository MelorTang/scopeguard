[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("recover", "request")]
    [string]$Operation,
    [Parameter(Mandatory)][string]$ProvisionerScript,
    [Parameter(Mandatory)][string]$RegistryPath,
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)][string]$Launcher,
    [Parameter(Mandatory)][string]$ResponsePath,
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-ServiceResponse {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $json = $Value | ConvertTo-Json -Depth 16 -Compress
    [IO.File]::WriteAllText(
        $temporaryPath,
        $json,
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::Move($temporaryPath, $Path, $true)
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$serviceIdentity = [ordered]@{
    name = $identity.Name
    sid = $identity.User.Value
    isLocalSystem = $identity.User.IsWellKnown(
        [Security.Principal.WellKnownSidType]::LocalSystemSid
    )
}

try {
    . $ProvisionerScript
    if ($Operation -ceq "recover") {
        $recovery = Invoke-ProvisionerAclStartupRecovery `
            -StateRoot $StateRoot `
            -Launcher $Launcher
        if (-not $recovery.passed) {
            throw "Provisioner startup recovery did not complete: " +
                ($recovery.errors -join ';')
        }
        Write-ServiceResponse -Path $ResponsePath -Value ([ordered]@{
            ok = $true
            operation = "recover"
            serviceIdentity = $serviceIdentity
            result = $recovery
        })
        exit 0
    }

    if (-not $RequestPath -or -not (Test-Path -LiteralPath $RequestPath)) {
        throw "Provisioner service request file is missing."
    }
    $requestItem = Get-Item -LiteralPath $RequestPath -Force
    if ($requestItem.PSIsContainer -or $requestItem.Length -gt 64KB -or
        ($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Provisioner service request file is invalid."
    }
    Assert-RuntimePackSingleHardLink -Path $requestItem.FullName
    $requestBytes = [IO.File]::ReadAllBytes($requestItem.FullName)
    $request = Read-ProvisionerPayload -PayloadBytes $requestBytes
    $result = if ($request.operation -ceq "prepare") {
        Invoke-ProvisionerAclPrepare `
            -Request $request `
            -RegistryPath $RegistryPath `
            -StateRoot $StateRoot `
            -Launcher $Launcher
    }
    else {
        Invoke-ProvisionerAclCleanup `
            -Request $request `
            -StateRoot $StateRoot `
            -Launcher $Launcher
    }
    Write-ServiceResponse -Path $ResponsePath -Value ([ordered]@{
        ok = $true
        operation = $request.operation
        requestId = $request.requestId
        executionId = $request.executionId
        serviceIdentity = $serviceIdentity
        result = $result
    })
    exit 0
}
catch {
    Write-ServiceResponse -Path $ResponsePath -Value ([ordered]@{
        ok = $false
        operation = $Operation
        serviceIdentity = $serviceIdentity
        error = [ordered]@{
            code = "request_rejected"
            message = $_.Exception.Message
        }
    })
    if ($Operation -ceq "recover") { exit 1 }
    exit 0
}
