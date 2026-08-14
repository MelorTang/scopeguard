[CmdletBinding()]
param(
    [string]$FixtureDirectory = (Join-Path $PSScriptRoot "fixtures"),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "out"),
    [string]$SofficePath = "",
    [string]$PdfToPpmPath = "",
    [string]$QpdfPath = "",
    [string]$PythonPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-Executable {
    param(
        [string]$ExplicitPath,
        [string[]]$Names,
        [string[]]$KnownPaths = @(),
        [string[]]$SearchRoots = @()
    )

    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "Executable does not exist: $ExplicitPath"
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    foreach ($knownPath in $KnownPaths) {
        $matches = Get-ChildItem -Path $knownPath -File -ErrorAction SilentlyContinue
        if ($matches) {
            return $matches[0].FullName
        }
    }

    foreach ($searchRoot in $SearchRoots) {
        if (-not (Test-Path -LiteralPath $searchRoot)) {
            continue
        }
        $match = Get-ChildItem -LiteralPath $searchRoot -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -in $Names } |
            Select-Object -First 1
        if ($match) {
            return $match.FullName
        }
    }

    throw "Required executable was not found: $($Names -join ', ')"
}

function Invoke-Checked {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )

    $nativeOutput = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $nativeOutput) {
        Write-Host $line
    }
    if ($exitCode -ne 0) {
        throw "$Executable exited with code $exitCode."
    }
}

function Convert-OfficeToPdf {
    param(
        [string]$InputPath,
        [string]$DestinationDirectory,
        [string]$ProfileDirectory
    )

    New-Item -ItemType Directory -Path $DestinationDirectory, $ProfileDirectory -Force | Out-Null
    $profileUri = ([Uri]((Resolve-Path -LiteralPath $ProfileDirectory).Path)).AbsoluteUri
    Invoke-Checked -Executable $script:Soffice -Arguments @(
        "--headless",
        "--nologo",
        "--nodefault",
        "--norestore",
        "-env:UserInstallation=$profileUri",
        "--convert-to",
        "pdf",
        "--outdir",
        $DestinationDirectory,
        $InputPath
    )
    $pdfPath = Join-Path $DestinationDirectory "$([IO.Path]::GetFileNameWithoutExtension($InputPath)).pdf"
    if (-not (Test-Path -LiteralPath $pdfPath)) {
        throw "LibreOffice did not create the expected PDF: $pdfPath"
    }
    return $pdfPath
}

function Render-Pdf {
    param(
        [string]$PdfPath,
        [string]$OutputPrefix
    )

    Invoke-Checked -Executable $script:PdfToPpm -Arguments @(
        "-png",
        "-r",
        "150",
        $PdfPath,
        $OutputPrefix
    )
    $rendered = Get-ChildItem -Path "$OutputPrefix-*.png" -File -ErrorAction SilentlyContinue
    if (-not $rendered) {
        throw "PDF rendering produced no pages for $PdfPath."
    }
}

function Compare-Renders {
    param(
        [string]$BeforePrefix,
        [string]$AfterPrefix,
        [string]$ReportPath,
        [double]$MaxChangedRatio,
        [switch]$RequireChange
    )

    $arguments = @(
        (Join-Path $PSScriptRoot "visual_diff.py"),
        "--before-prefix",
        $BeforePrefix,
        "--after-prefix",
        $AfterPrefix,
        "--output",
        $ReportPath,
        "--max-changed-ratio",
        $MaxChangedRatio.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    if ($RequireChange) {
        $arguments += "--require-change"
    }
    Invoke-Checked -Executable $script:Python -Arguments $arguments
    return Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
}

if (-not (Test-Path -LiteralPath $FixtureDirectory)) {
    throw "Fixture directory does not exist: $FixtureDirectory"
}

$script:Soffice = Resolve-Executable -ExplicitPath $SofficePath -Names @("soffice", "soffice.exe") -KnownPaths @(
    "C:\Program Files\LibreOffice\program\soffice.exe"
)
$script:PdfToPpm = Resolve-Executable -ExplicitPath $PdfToPpmPath -Names @("pdftoppm", "pdftoppm.exe") -KnownPaths @(
    "C:\ProgramData\chocolatey\bin\pdftoppm.exe",
    "C:\ProgramData\chocolatey\lib\poppler\tools\poppler-*\Library\bin\pdftoppm.exe"
) -SearchRoots @(
    "C:\ProgramData\chocolatey\lib\poppler\tools"
)
$script:Qpdf = Resolve-Executable -ExplicitPath $QpdfPath -Names @("qpdf", "qpdf.exe") -KnownPaths @(
    "C:\Program Files\qpdf*\bin\qpdf.exe"
)
$script:Python = Resolve-Executable -ExplicitPath $PythonPath -Names @("python", "python.exe", "python3")
$dotnet = Resolve-Executable -ExplicitPath "" -Names @("dotnet", "dotnet.exe")

$FixtureDirectory = (Resolve-Path -LiteralPath $FixtureDirectory).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
    Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$workerProject = Join-Path $PSScriptRoot "worker\ScopeGuard.DocumentRoundTrip.csproj"
Invoke-Checked -Executable $dotnet -Arguments @("build", $workerProject, "--configuration", "Release")
$workerDll = Join-Path $PSScriptRoot "worker\bin\Release\net8.0\ScopeGuard.DocumentRoundTrip.dll"
if (-not (Test-Path -LiteralPath $workerDll)) {
    throw "Document worker build output is missing: $workerDll"
}

$results = [Collections.Generic.List[object]]::new()
$officeFixtures = Get-ChildItem -LiteralPath $FixtureDirectory -File | Where-Object {
    $_.Extension.ToLowerInvariant() -in @(".docx", ".xlsx", ".pptx")
}

foreach ($fixture in $officeFixtures) {
    $caseDirectory = Join-Path $OutputDirectory $fixture.BaseName
    $editedPath = Join-Path $caseDirectory "edited\$($fixture.BaseName)-edited$($fixture.Extension)"
    $structureReportPath = Join-Path $caseDirectory "structure.json"
    New-Item -ItemType Directory -Path (Split-Path -Parent $editedPath) -Force | Out-Null

    Invoke-Checked -Executable $dotnet -Arguments @(
        $workerDll,
        "roundtrip",
        $fixture.FullName,
        $editedPath,
        $structureReportPath
    )
    $structure = Get-Content -LiteralPath $structureReportPath -Raw | ConvertFrom-Json

    $sourceHashBeforeRender = (Get-FileHash -LiteralPath $fixture.FullName -Algorithm SHA256).Hash
    $beforePdf = Convert-OfficeToPdf `
        -InputPath $fixture.FullName `
        -DestinationDirectory (Join-Path $caseDirectory "before-pdf") `
        -ProfileDirectory (Join-Path $caseDirectory "before-profile")
    $afterPdf = Convert-OfficeToPdf `
        -InputPath $editedPath `
        -DestinationDirectory (Join-Path $caseDirectory "after-pdf") `
        -ProfileDirectory (Join-Path $caseDirectory "after-profile")
    $sourceHashAfterRender = (Get-FileHash -LiteralPath $fixture.FullName -Algorithm SHA256).Hash

    $beforePrefix = Join-Path $caseDirectory "render\before"
    $afterPrefix = Join-Path $caseDirectory "render\after"
    New-Item -ItemType Directory -Path (Split-Path -Parent $beforePrefix) -Force | Out-Null
    Render-Pdf -PdfPath $beforePdf -OutputPrefix $beforePrefix
    Render-Pdf -PdfPath $afterPdf -OutputPrefix $afterPrefix
    $visual = Compare-Renders `
        -BeforePrefix $beforePrefix `
        -AfterPrefix $afterPrefix `
        -ReportPath (Join-Path $caseDirectory "visual.json") `
        -MaxChangedRatio 0.05 `
        -RequireChange

    $sourceUnchangedAfterRender = $sourceHashBeforeRender -eq $sourceHashAfterRender
    $passed = [bool]$structure.passed -and [bool]$visual.passed -and $sourceUnchangedAfterRender
    $results.Add([ordered]@{
        fixture = $fixture.Name
        format = $fixture.Extension.TrimStart(".").ToLowerInvariant()
        structurePassed = [bool]$structure.passed
        visualPassed = [bool]$visual.passed
        sourceUnchangedAfterRender = $sourceUnchangedAfterRender
        changedParts = @($structure.changedParts)
        validationErrorsBefore = $structure.validationErrorsBefore
        validationErrorsAfter = $structure.validationErrorsAfter
        newValidationErrorCount = @($structure.newValidationErrors).Count
        renderedPageCount = $visual.afterPageCount
        changedPixelRatio = $visual.changedPixelRatio
        passed = $passed
    })
}

$pdfFixture = Get-ChildItem -LiteralPath $FixtureDirectory -Filter "*.pdf" -File | Select-Object -First 1
if (-not $pdfFixture) {
    throw "Fixture directory must contain one PDF fixture."
}

$pdfCaseDirectory = Join-Path $OutputDirectory $pdfFixture.BaseName
New-Item -ItemType Directory -Path $pdfCaseDirectory -Force | Out-Null
$pdfSourceHashBefore = (Get-FileHash -LiteralPath $pdfFixture.FullName -Algorithm SHA256).Hash
$pdfPassThrough = Join-Path $pdfCaseDirectory "$($pdfFixture.BaseName)-passthrough.pdf"
$pdfRotated = Join-Path $pdfCaseDirectory "$($pdfFixture.BaseName)-rotated.pdf"
Invoke-Checked -Executable $script:Qpdf -Arguments @($pdfFixture.FullName, $pdfPassThrough)
Invoke-Checked -Executable $script:Qpdf -Arguments @($pdfFixture.FullName, "--rotate=+90:2", "--", $pdfRotated)
Invoke-Checked -Executable $script:Qpdf -Arguments @("--check", $pdfPassThrough)
Invoke-Checked -Executable $script:Qpdf -Arguments @("--check", $pdfRotated)
$pdfSourceHashAfter = (Get-FileHash -LiteralPath $pdfFixture.FullName -Algorithm SHA256).Hash

$pdfBeforePrefix = Join-Path $pdfCaseDirectory "render\before"
$pdfAfterPrefix = Join-Path $pdfCaseDirectory "render\after"
New-Item -ItemType Directory -Path (Split-Path -Parent $pdfBeforePrefix) -Force | Out-Null
Render-Pdf -PdfPath $pdfFixture.FullName -OutputPrefix $pdfBeforePrefix
Render-Pdf -PdfPath $pdfPassThrough -OutputPrefix $pdfAfterPrefix
$pdfVisual = Compare-Renders `
    -BeforePrefix $pdfBeforePrefix `
    -AfterPrefix $pdfAfterPrefix `
    -ReportPath (Join-Path $pdfCaseDirectory "visual.json") `
    -MaxChangedRatio 0.0001

$pdfSourceUnchanged = $pdfSourceHashBefore -eq $pdfSourceHashAfter
$pdfPassed = [bool]$pdfVisual.passed -and $pdfSourceUnchanged
$results.Add([ordered]@{
    fixture = $pdfFixture.Name
    format = "pdf"
    structurePassed = $true
    visualPassed = [bool]$pdfVisual.passed
    sourceUnchangedAfterRender = $pdfSourceUnchanged
    changedParts = @()
    validationErrorsBefore = 0
    validationErrorsAfter = 0
    newValidationErrorCount = 0
    renderedPageCount = $pdfVisual.afterPageCount
    changedPixelRatio = $pdfVisual.changedPixelRatio
    rotatedOutputCreated = (Test-Path -LiteralPath $pdfRotated)
    passed = $pdfPassed
})

$failed = @($results | Where-Object { -not $_.passed })
$summary = [ordered]@{
    passed = $failed.Count -eq 0
    productionReady = $false
    platform = [Environment]::OSVersion.VersionString
    fixtureDirectory = [IO.Path]::GetFileName($FixtureDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar))
    fixtureCount = $results.Count
    failedFixtureCount = $failed.Count
    tools = [ordered]@{
        dotnet = (& $dotnet --version).Trim()
        soffice = $script:Soffice
        pdftoppm = $script:PdfToPpm
        qpdf = (& $script:Qpdf --version | Select-Object -First 1).Trim()
        python = (& $script:Python --version).Trim()
    }
    results = $results
}
$summaryPath = Join-Path $OutputDirectory "result.json"
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $summaryPath -Encoding utf8
$summary | ConvertTo-Json -Depth 10

if (-not $summary.passed) {
    throw "$($failed.Count) document fixtures failed. See $summaryPath."
}
