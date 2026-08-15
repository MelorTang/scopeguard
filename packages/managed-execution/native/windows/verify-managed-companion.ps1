[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [switch]$RequireTrustedSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The managed execution companion package must be verified on Windows."
}

if (-not ("ScopeGuard.NativeStreamInspector" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ScopeGuard {
    public static class NativeStreamInspector {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FindStreamData {
            public long StreamSize;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)]
            public string StreamName;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindFirstStreamW(
            string fileName,
            int informationLevel,
            out FindStreamData findStreamData,
            int flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindNextStreamW(
            IntPtr findStream,
            out FindStreamData findStreamData);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindClose(IntPtr findFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out FileInformation information);

        public static string[] List(string path) {
            var nativePath = path.StartsWith(@"\\", StringComparison.Ordinal)
                ? @"\\?\UNC\" + path.Substring(2)
                : @"\\?\" + path;
            var streams = new List<string>();
            FindStreamData data;
            var handle = FindFirstStreamW(nativePath, 0, out data, 0);
            if (handle == new IntPtr(-1)) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Failed to enumerate file streams: " + path);
            }
            try {
                streams.Add(data.StreamName);
                while (FindNextStreamW(handle, out data)) {
                    streams.Add(data.StreamName);
                }
                var error = Marshal.GetLastWin32Error();
                if (error != 38) {
                    throw new Win32Exception(error, "Failed to enumerate file streams: " + path);
                }
            }
            finally {
                FindClose(handle);
            }
            return streams.ToArray();
        }

        public static uint LinkCount(string path) {
            using (var handle = File.OpenHandle(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                FileOptions.None)) {
                FileInformation information;
                if (!GetFileInformationByHandle(handle, out information)) {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Failed to inspect file identity: " + path);
                }
                return information.NumberOfLinks;
            }
        }
    }
}
'@
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Context
    )

    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count -or
        (Compare-Object -ReferenceObject $wanted -DifferenceObject $actual)) {
        throw "$Context properties must be exactly: $($Expected -join ', ')."
    }
}

function Assert-RelativePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Context
    )

    if (-not $Path -or $Path.Contains('\') -or $Path.Contains(':') -or
        [IO.Path]::IsPathRooted($Path)) {
        throw "$Context must be a forward-slash relative path."
    }
    $segments = @($Path.Split('/'))
    if (@($segments | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "$Context contains an empty or traversal segment."
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-NoDuplicateJsonProperties {
    param(
        [Parameter(Mandatory)][System.Text.Json.JsonElement]$Element,
        [Parameter(Mandatory)][string]$Context
    )

    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $names.Add($property.Name)) {
                throw "$Context contains duplicate property '$($property.Name)'."
            }
            Assert-NoDuplicateJsonProperties `
                -Element $property.Value `
                -Context "$Context.$($property.Name)"
        }
    }
    elseif ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        $index = 0
        foreach ($item in $Element.EnumerateArray()) {
            Assert-NoDuplicateJsonProperties -Element $item -Context "$Context[$index]"
            $index++
        }
    }
}

$PackageRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PackageRoot).Path).TrimEnd('\')
$rootItem = Get-Item -LiteralPath $PackageRoot -Force
if (-not $rootItem.PSIsContainer -or
    ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "PackageRoot must be a regular directory."
}

$manifestPath = Join-Path $PackageRoot "managed-companion-manifest.json"
$manifestItem = Get-Item -LiteralPath $manifestPath -Force
if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $manifestItem.Length -gt 8MB) {
    throw "The companion manifest is not a bounded regular file."
}
$manifestJson = Get-Content -LiteralPath $manifestPath -Raw
$manifestDocument = [System.Text.Json.JsonDocument]::Parse($manifestJson)
try {
    Assert-NoDuplicateJsonProperties -Element $manifestDocument.RootElement -Context "Companion manifest"
}
finally {
    $manifestDocument.Dispose()
}
$manifest = $manifestJson | ConvertFrom-Json -Depth 12
Assert-ExactProperties -Value $manifest -Expected @(
    "schemaVersion", "component", "version", "platform", "architecture",
    "layout", "entrypoints", "runtimes", "releasePolicy", "contentDigest", "files"
) -Context "Companion manifest"
if ($manifest.schemaVersion -ne 1 -or
    $manifest.component -cne "scopeguard-managed-execution" -or
    $manifest.platform -cne "windows" -or
    $manifest.architecture -cne "x64" -or
    $manifest.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Companion manifest identity is invalid."
}

Assert-ExactProperties -Value $manifest.layout -Expected @(
    "installRoot", "stateRoot", "installRootOwner", "desktopAccess",
    "desktopWriteAllowed", "serviceIdentity"
) -Context "Companion layout"
if ($manifest.layout.installRoot -cne "%ProgramFiles%\ScopeGuard\ManagedExecution" -or
    $manifest.layout.stateRoot -cne "%ProgramData%\ScopeGuard\ManagedExecution" -or
    $manifest.layout.installRootOwner -cne "installer-administrators" -or
    $manifest.layout.desktopAccess -cne "read-execute" -or
    $manifest.layout.desktopWriteAllowed -ne $false -or
    $manifest.layout.serviceIdentity -cne "LocalSystem") {
    throw "Companion layout weakens the machine-owned trust boundary."
}

$entrypointNames = @(
    "service", "serviceClient", "launcher", "lifetimeBroker", "powershell",
    "worker", "provisioner", "lifecycle", "runtimePackVerifier"
)
Assert-ExactProperties -Value $manifest.entrypoints -Expected $entrypointNames -Context "Companion entrypoints"
if ($manifest.entrypoints.service -cne $manifest.entrypoints.serviceClient) {
    throw "The service client must use the pinned Provisioner service image."
}

Assert-ExactProperties -Value $manifest.releasePolicy -Expected @(
    "authenticodeRequired", "signedInstallerRequired", "unsignedDevelopmentArtifact"
) -Context "Companion release policy"
if ($manifest.releasePolicy.authenticodeRequired -ne $true -or
    $manifest.releasePolicy.signedInstallerRequired -ne $true) {
    throw "Companion release policy must retain signing gates."
}
if ($RequireTrustedSignature -and $manifest.releasePolicy.unsignedDevelopmentArtifact -ne $false) {
    throw "A development package cannot satisfy trusted release verification."
}

$items = @(
    Get-Item -LiteralPath $PackageRoot -Force
    Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse
)
foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Companion package contains a reparse point: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
        $streams = @([ScopeGuard.NativeStreamInspector]::List($item.FullName) |
            Where-Object { $_ -cne ':$DATA' -and $_ -cne '::$DATA' })
        if ($streams.Count -gt 0) {
            throw "Companion package contains an alternate data stream: $($item.FullName)"
        }
        if ([ScopeGuard.NativeStreamInspector]::LinkCount($item.FullName) -ne 1) {
            throw "Companion package contains a multiply linked file: $($item.FullName)"
        }
    }
}

$actualFiles = @(
    Get-ChildItem -LiteralPath $PackageRoot -File -Force -Recurse |
        Where-Object FullName -CNE $manifestPath |
        ForEach-Object {
            [pscustomobject]@{
                path = [IO.Path]::GetRelativePath($PackageRoot, $_.FullName).Replace('\', '/')
                item = $_
            }
        } |
        Sort-Object path
)
if ($manifest.files.Count -ne $actualFiles.Count -or $manifest.files.Count -lt 10) {
    throw "Companion payload file count does not match its manifest."
}

$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$verifiedFiles = [Collections.Generic.List[object]]::new()
for ($index = 0; $index -lt $manifest.files.Count; $index++) {
    $record = $manifest.files[$index]
    Assert-ExactProperties -Value $record -Expected @("path", "size", "sha256") -Context "Payload file $index"
    Assert-RelativePath -Path $record.path -Context "Payload file $index path"
    if (-not $record.path.StartsWith('payload/', [StringComparison]::Ordinal) -or
        -not $seen.Add($record.path)) {
        throw "Payload file $index is outside the closed payload or duplicated."
    }
    $actual = $actualFiles[$index]
    if ($record.path -cne $actual.path -or
        $record.size -ne $actual.item.Length -or
        $record.sha256 -notmatch '^[0-9a-f]{64}$' -or
        $record.sha256 -cne (Get-Sha256 -Path $actual.item.FullName)) {
        throw "Payload file verification failed for $($record.path)."
    }
    $verifiedFiles.Add($record)
}

$contentIndex = ($verifiedFiles | ForEach-Object {
    "$($_.path)`0$($_.size)`0$($_.sha256)"
}) -join "`n"
$contentDigest = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($contentIndex))
).ToLowerInvariant()
if ($manifest.contentDigest -notmatch '^[0-9a-f]{64}$' -or
    $manifest.contentDigest -cne $contentDigest) {
    throw "Companion content digest does not match the verified payload."
}

$manifestPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($path in $manifest.files.path) {
    $null = $manifestPaths.Add($path)
}
foreach ($name in $entrypointNames) {
    $path = $manifest.entrypoints.$name
    Assert-RelativePath -Path $path -Context "Entrypoint $name"
    if (-not $manifestPaths.Contains($path)) {
        throw "Entrypoint $name is absent from the payload manifest."
    }
}
if ($manifest.entrypoints.service -cne "payload/bin/scopeguard-provisioner-service.exe" -or
    $manifest.entrypoints.launcher -cne "payload/bin/scopeguard-appcontainer.exe" -or
    $manifest.entrypoints.lifetimeBroker -cne "payload/bin/scopeguard-lifetime-broker.exe" -or
    $manifest.entrypoints.powershell -cne "payload/runtimes/powershell/pwsh.exe") {
    throw "Companion native entrypoints do not match the installation contract."
}

$runtimeIds = @($manifest.runtimes.id)
$sortedRuntimeIds = @($runtimeIds | Sort-Object) -join ','
$expectedRuntimeIds = @("scopeguard.node", "scopeguard.provisioner-powershell") -join ','
if ($manifest.runtimes.Count -ne 2 -or
    $sortedRuntimeIds -cne $expectedRuntimeIds) {
    throw "Companion runtimes must contain the exact Node and Provisioner PowerShell packs."
}
foreach ($runtime in $manifest.runtimes) {
    if ($runtime.id -ceq "scopeguard.node") {
        Assert-ExactProperties -Value $runtime -Expected @(
            "id", "root", "manifest", "version", "capabilities"
        ) -Context "Node runtime"
        if ($runtime.root -cne "payload/runtimes/node" -or
            $runtime.manifest -cne "payload/metadata/node-runtime.json" -or
            @($runtime.capabilities).Count -ne 1 -or
            $runtime.capabilities[0] -cne "registryRead") {
            throw "Node runtime descriptor is invalid."
        }
    }
    elseif ($runtime.id -ceq "scopeguard.provisioner-powershell") {
        Assert-ExactProperties -Value $runtime -Expected @(
            "id", "root", "executable", "version", "capabilities"
        ) -Context "Provisioner PowerShell runtime"
        if ($runtime.root -cne "payload/runtimes/powershell" -or
            $runtime.executable -cne $manifest.entrypoints.powershell -or
            @($runtime.capabilities).Count -ne 0) {
            throw "Provisioner PowerShell runtime descriptor is invalid."
        }
    }
    else {
        throw "Companion contains an unsupported runtime."
    }
}

$nodeManifestPath = Join-Path $PackageRoot $manifest.runtimes[0].manifest
if (-not (Test-Path -LiteralPath $nodeManifestPath -PathType Leaf)) {
    throw "Node runtime manifest is missing."
}
$nodeManifestJson = Get-Content -LiteralPath $nodeManifestPath -Raw
$nodeManifestDocument = [System.Text.Json.JsonDocument]::Parse($nodeManifestJson)
try {
    Assert-NoDuplicateJsonProperties -Element $nodeManifestDocument.RootElement -Context "Node runtime manifest"
}
finally {
    $nodeManifestDocument.Dispose()
}
$nodeManifest = $nodeManifestJson | ConvertFrom-Json -Depth 8
Assert-ExactProperties -Value $nodeManifest -Expected @(
    "schemaVersion", "runtimeId", "version", "architecture", "executable",
    "capabilities", "files"
) -Context "Node runtime manifest"
if ($nodeManifest.schemaVersion -ne 1 -or
    $nodeManifest.runtimeId -cne "scopeguard.node" -or
    $nodeManifest.architecture -cne "x64" -or
    $nodeManifest.executable -cne "node.exe" -or
    $nodeManifest.files.Count -ne 1 -or
    $nodeManifest.files[0].path -cne "node.exe") {
    throw "Node runtime manifest identity is invalid."
}
$nodePath = Join-Path $PackageRoot "payload/runtimes/node/node.exe"
if ($nodeManifest.files[0].size -ne (Get-Item -LiteralPath $nodePath).Length -or
    $nodeManifest.files[0].sha256 -cne (Get-Sha256 -Path $nodePath)) {
    throw "Node runtime manifest does not bind the packaged executable."
}

$signedPaths = @(
    $manifest.entrypoints.service,
    $manifest.entrypoints.launcher,
    $manifest.entrypoints.lifetimeBroker,
    $manifest.entrypoints.powershell,
    "payload/runtimes/node/node.exe"
)
$signatureEvidence = @($signedPaths | ForEach-Object {
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $PackageRoot $_)
    [pscustomobject][ordered]@{
        path = $_
        status = $signature.Status.ToString()
        signer = if ($signature.SignerCertificate) {
            $signature.SignerCertificate.Subject
        }
        else { $null }
    }
})
if ($RequireTrustedSignature -and
    @($signatureEvidence | Where-Object status -CNE "Valid").Count -gt 0) {
    throw "One or more required companion executables lack a trusted Authenticode signature."
}

[pscustomobject][ordered]@{
    schemaVersion = 1
    passed = $true
    packageRoot = $PackageRoot
    version = $manifest.version
    contentDigest = $contentDigest
    payloadFileCount = $verifiedFiles.Count
    payloadBytes = ($verifiedFiles | Measure-Object size -Sum).Sum
    trustedSignaturesRequired = [bool]$RequireTrustedSignature
    signatures = $signatureEvidence
} | ConvertTo-Json -Depth 5
