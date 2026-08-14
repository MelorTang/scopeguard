Set-StrictMode -Version Latest

$script:RuntimePackCapabilities = @(
    "lpacAppExperience",
    "registryRead",
    "lpacInstrumentation"
)

function Get-RuntimePackSha256 {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StrictJsonProperties {
    param(
        [Parameter(Mandatory)]
        [System.Text.Json.JsonElement]$Element,
        [Parameter(Mandatory)]
        [string[]]$ExpectedNames,
        [Parameter(Mandatory)]
        [string]$Context
    )

    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        throw "$Context must be a JSON object."
    }
    $properties = [System.Collections.Generic.List[object]]::new()
    $names = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    foreach ($property in $Element.EnumerateObject()) {
        if (-not $names.Add($property.Name)) {
            throw "$Context contains duplicate property '$($property.Name)'."
        }
        $properties.Add($property)
    }
    $actual = @($names | Sort-Object)
    $expected = @($ExpectedNames | Sort-Object)
    if ($actual.Count -ne $expected.Count -or
        (Compare-Object -ReferenceObject $expected -DifferenceObject $actual)) {
        throw "$Context properties must be exactly: $($ExpectedNames -join ', ')."
    }
    return $properties
}

function Get-StrictJsonProperty {
    param(
        [Parameter(Mandatory)]
        [object[]]$Properties,
        [Parameter(Mandatory)]
        [string]$Name
    )

    $property = @($Properties | Where-Object Name -CEQ $Name)
    if ($property.Count -ne 1) {
        throw "Required JSON property '$Name' is missing or ambiguous."
    }
    return $property[0].Value
}

function Get-StrictJsonString {
    param(
        [Parameter(Mandatory)]
        [System.Text.Json.JsonElement]$Element,
        [Parameter(Mandatory)]
        [string]$Context
    )

    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
        throw "$Context must be a JSON string."
    }
    return $Element.GetString()
}

function Get-StrictJsonInt64 {
    param(
        [Parameter(Mandatory)]
        [System.Text.Json.JsonElement]$Element,
        [Parameter(Mandatory)]
        [string]$Context
    )

    $value = [long]0
    if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or
        -not $Element.TryGetInt64([ref]$value)) {
        throw "$Context must be a JSON integer."
    }
    return $value
}

function Assert-RuntimePackRelativePath {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Context
    )

    if (-not $Path -or $Path.Contains("\") -or $Path.Contains(":")) {
        throw "$Context must use a non-empty forward-slash relative path."
    }
    if ([IO.Path]::IsPathRooted($Path)) {
        throw "$Context must be relative."
    }
    $segments = @($Path.Split('/'))
    if ($segments.Count -eq 0 -or
        @($segments | Where-Object { -not $_ -or $_ -eq "." -or $_ -eq ".." }).Count -gt 0) {
        throw "$Context contains an empty or traversal segment."
    }
}

function Assert-RuntimePackNoReparsePoints {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    $items = @(
        Get-Item -LiteralPath $Root -Force -ErrorAction Stop
        Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop
    )
    foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Runtime pack contains a reparse point: $($item.FullName)"
        }
        $namedStreams = @(
            Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction Stop |
                Where-Object Stream -CNE ':$DATA'
        )
        if ($namedStreams.Count -gt 0) {
            throw "Runtime pack contains an alternate data stream: $($item.FullName)"
        }
    }
}

function Assert-RuntimePackSingleHardLink {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $output = @(& fsutil.exe hardlink list $Path 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Runtime pack hard-link identity could not be verified: $Path"
    }
    $links = @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object {
        $_.StartsWith('\', [StringComparison]::Ordinal)
    })
    if ($links.Count -ne 1) {
        throw "Runtime pack payload has multiple hard links: $Path"
    }
}

function Get-RuntimePackContentDigest {
    param(
        [Parameter(Mandatory)]
        [object[]]$Files
    )

    $index = ($Files | Sort-Object path | ForEach-Object {
        "$($_.path)`0$($_.size)`0$($_.sha256)"
    }) -join "`n"
    $bytes = [Text.Encoding]::UTF8.GetBytes($index)
    return [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($bytes)
    ).ToLowerInvariant()
}

function Read-VerifiedRuntimePack {
    param(
        [Parameter(Mandatory)]
        [string]$PackRoot,
        [Parameter(Mandatory)]
        [string]$ManifestPath,
        [Parameter(Mandatory)]
        [string]$ExpectedManifestSha256
    )

    if ($ExpectedManifestSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Expected runtime manifest SHA-256 is invalid."
    }
    $rootItem = Get-Item -LiteralPath $PackRoot -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) {
        throw "Runtime pack root must be a directory."
    }
    $root = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\')
    $manifestItem = Get-Item -LiteralPath $ManifestPath -Force -ErrorAction Stop
    if ($manifestItem.PSIsContainer) {
        throw "Runtime pack manifest must be a file."
    }
    if ($manifestItem.Length -gt 2MB) {
        throw "Runtime pack manifest exceeds the 2 MiB limit."
    }
    $manifestSha256 = Get-RuntimePackSha256 -Path $manifestItem.FullName
    if ($manifestSha256 -cne $ExpectedManifestSha256.ToLowerInvariant()) {
        throw "Runtime pack manifest digest mismatch."
    }

    Assert-RuntimePackNoReparsePoints -Root $root
    $raw = [IO.File]::ReadAllText($manifestItem.FullName, [Text.Encoding]::UTF8)
    $document = $null
    try {
        $document = [System.Text.Json.JsonDocument]::Parse($raw)
        $rootProperties = @(Get-StrictJsonProperties `
            -Element $document.RootElement `
            -ExpectedNames @(
                "schemaVersion",
                "runtimeId",
                "version",
                "architecture",
                "executable",
                "capabilities",
                "files"
            ) `
            -Context "Runtime pack manifest")

        $schemaVersion = Get-StrictJsonInt64 `
            -Element (Get-StrictJsonProperty -Properties $rootProperties -Name "schemaVersion") `
            -Context "schemaVersion"
        if ($schemaVersion -ne 1) {
            throw "Unsupported runtime pack schemaVersion: $schemaVersion"
        }
        $runtimeId = Get-StrictJsonString `
            -Element (Get-StrictJsonProperty -Properties $rootProperties -Name "runtimeId") `
            -Context "runtimeId"
        if ($runtimeId -notmatch '^scopeguard\.[a-z][a-z0-9.-]{0,63}$') {
            throw "runtimeId is invalid."
        }
        $version = Get-StrictJsonString `
            -Element (Get-StrictJsonProperty -Properties $rootProperties -Name "version") `
            -Context "version"
        if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
            throw "Runtime version is invalid."
        }
        $architecture = Get-StrictJsonString `
            -Element (Get-StrictJsonProperty -Properties $rootProperties -Name "architecture") `
            -Context "architecture"
        if ($architecture -cne "x64") {
            throw "Only x64 runtime packs are accepted by this prototype."
        }
        $executable = Get-StrictJsonString `
            -Element (Get-StrictJsonProperty -Properties $rootProperties -Name "executable") `
            -Context "executable"
        Assert-RuntimePackRelativePath -Path $executable -Context "executable"

        $capabilityElement = Get-StrictJsonProperty `
            -Properties $rootProperties `
            -Name "capabilities"
        if ($capabilityElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Array) {
            throw "capabilities must be a JSON array."
        }
        $capabilities = [System.Collections.Generic.List[string]]::new()
        $capabilityNames = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal
        )
        $lastCapabilityIndex = -1
        foreach ($entry in $capabilityElement.EnumerateArray()) {
            $capability = Get-StrictJsonString -Element $entry -Context "capability"
            $capabilityIndex = [Array]::IndexOf($script:RuntimePackCapabilities, $capability)
            if ($capabilityIndex -lt 0) {
                throw "Unsupported runtime Capability: $capability"
            }
            if (-not $capabilityNames.Add($capability)) {
                throw "Duplicate runtime Capability: $capability"
            }
            if ($capabilityIndex -le $lastCapabilityIndex) {
                throw "Runtime Capabilities are not in canonical order."
            }
            $lastCapabilityIndex = $capabilityIndex
            $capabilities.Add($capability)
        }

        $fileElement = Get-StrictJsonProperty -Properties $rootProperties -Name "files"
        if ($fileElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Array) {
            throw "files must be a JSON array."
        }
        $files = [System.Collections.Generic.List[object]]::new()
        $fileNames = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase
        )
        foreach ($fileEntry in $fileElement.EnumerateArray()) {
            $fileProperties = @(Get-StrictJsonProperties `
                -Element $fileEntry `
                -ExpectedNames @("path", "size", "sha256") `
                -Context "Runtime pack file entry")
            $relativePath = Get-StrictJsonString `
                -Element (Get-StrictJsonProperty -Properties $fileProperties -Name "path") `
                -Context "Runtime pack file path"
            Assert-RuntimePackRelativePath `
                -Path $relativePath `
                -Context "Runtime pack file path"
            if (-not $fileNames.Add($relativePath)) {
                throw "Duplicate runtime pack file path: $relativePath"
            }
            $size = Get-StrictJsonInt64 `
                -Element (Get-StrictJsonProperty -Properties $fileProperties -Name "size") `
                -Context "Runtime pack file size"
            if ($size -lt 0) {
                throw "Runtime pack file size cannot be negative."
            }
            $sha256 = Get-StrictJsonString `
                -Element (Get-StrictJsonProperty -Properties $fileProperties -Name "sha256") `
                -Context "Runtime pack file SHA-256"
            if ($sha256 -notmatch '^[0-9a-f]{64}$') {
                throw "Runtime pack file SHA-256 must be lowercase hexadecimal."
            }
            $files.Add([pscustomobject][ordered]@{
                path = $relativePath
                size = $size
                sha256 = $sha256
            })
        }
        if ($files.Count -eq 0) {
            throw "Runtime pack file list cannot be empty."
        }
        if (-not $fileNames.Contains($executable)) {
            throw "Runtime executable is not present in the file manifest."
        }

        $actualFiles = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase
        )
        foreach ($item in Get-ChildItem -LiteralPath $root -File -Force -Recurse -ErrorAction Stop) {
            $relativePath = [IO.Path]::GetRelativePath($root, $item.FullName).Replace('\', '/')
            $actualFiles.Add($relativePath) | Out-Null
        }
        if ($actualFiles.Count -ne $fileNames.Count -or
            @($actualFiles | Where-Object { -not $fileNames.Contains($_) }).Count -gt 0) {
            throw "Runtime pack payload does not exactly match the file manifest."
        }

        foreach ($file in $files) {
            $windowsPath = $file.path.Replace('/', '\')
            $fullPath = [IO.Path]::GetFullPath((Join-Path $root $windowsPath))
            $rootPrefix = "$root\"
            if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Runtime pack file escaped the pack root: $($file.path)"
            }
            $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
            if ($item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Runtime pack payload is not a regular file: $($file.path)"
            }
            Assert-RuntimePackSingleHardLink -Path $item.FullName
            if ($item.Length -ne $file.size) {
                throw "Runtime pack file size mismatch: $($file.path)"
            }
            if ((Get-RuntimePackSha256 -Path $item.FullName) -cne $file.sha256) {
                throw "Runtime pack file digest mismatch: $($file.path)"
            }
        }

        $verifiedCapabilities = @($capabilities | ForEach-Object { $_ })
        $verifiedFiles = @($files | ForEach-Object { $_ })
        $executablePath = [IO.Path]::GetFullPath((Join-Path $root $executable.Replace('/', '\')))
        return [pscustomobject][ordered]@{
            schemaVersion = 1
            runtimeId = $runtimeId
            version = $version
            architecture = $architecture
            packRoot = $root
            executable = $executable
            executablePath = $executablePath
            capabilities = $verifiedCapabilities
            manifestSha256 = $manifestSha256
            contentSha256 = Get-RuntimePackContentDigest -Files $verifiedFiles
            files = $verifiedFiles
        }
    }
    finally {
        if ($null -ne $document) {
            $document.Dispose()
        }
    }
}
