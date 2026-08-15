[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "out"),
    [string]$ReportPath = (Join-Path $OutputDirectory "office-reopen-result.json")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Release-ComObject {
    param([AllowNull()][object]$Value)

    if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
    }
}

function Get-EditedFiles {
    param([string]$Root)

    $files = Get-ChildItem -LiteralPath $Root -Directory | ForEach-Object {
        $editedDirectory = Join-Path $_.FullName "edited"
        if (Test-Path -LiteralPath $editedDirectory -PathType Container) {
            Get-ChildItem -LiteralPath $editedDirectory -File | Where-Object {
                $_.Extension.ToLowerInvariant() -in @(".docx", ".xlsx", ".pptx")
            }
        }
    }
    $grouped = $files | Group-Object { $_.Extension.ToLowerInvariant() }
    foreach ($extension in @(".docx", ".xlsx", ".pptx")) {
        if (-not ($grouped | Where-Object Name -eq $extension)) {
            throw "Office reopen corpus is missing an edited $extension fixture."
        }
    }
    return @($files | Sort-Object Name)
}

function New-Result {
    param(
        [IO.FileInfo]$File,
        [string]$Application,
        [string]$HashBefore
    )

    return [ordered]@{
        fixture = $File.Name
        format = $File.Extension.TrimStart(".").ToLowerInvariant()
        application = $Application
        openedReadOnly = $false
        openAndRepairRequested = $false
        sourceUnchanged = $false
        hashBefore = $HashBefore
        hashAfter = $null
        structure = [ordered]@{}
        error = $null
        passed = $false
    }
}

function Test-WordFiles {
    param([IO.FileInfo[]]$Files)

    $application = $null
    try {
        $application = New-Object -ComObject Word.Application
        $application.Visible = $false
        $application.DisplayAlerts = 0
        $application.AutomationSecurity = 3
        foreach ($file in $Files) {
            $hashBefore = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $result = New-Result -File $file -Application "Word" -HashBefore $hashBefore
            $document = $null
            try {
                $document = $application.Documents.Open(
                    $file.FullName,
                    $false,
                    $true,
                    $false
                )
                $result.openedReadOnly = [bool]$document.ReadOnly
                $result.structure = [ordered]@{
                    pages = [int]$document.ComputeStatistics(2)
                    paragraphs = [int]$document.Paragraphs.Count
                    tables = [int]$document.Tables.Count
                    revisions = [int]$document.Revisions.Count
                    comments = [int]$document.Comments.Count
                    compatibilityMode = [int]$document.CompatibilityMode
                }
            } catch {
                $result.error = $_.Exception.Message
            } finally {
                if ($null -ne $document) {
                    $document.Close(0)
                    Release-ComObject $document
                }
                $result.hashAfter = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                $result.sourceUnchanged = $result.hashBefore -eq $result.hashAfter
                $result.passed = $result.openedReadOnly -and $result.sourceUnchanged -and -not $result.error
                $script:Results.Add($result)
            }
        }
    } finally {
        if ($null -ne $application) {
            $application.Quit()
            Release-ComObject $application
        }
    }
}

function Test-ExcelFiles {
    param([IO.FileInfo[]]$Files)

    $application = $null
    try {
        $application = New-Object -ComObject Excel.Application
        $application.Visible = $false
        $application.DisplayAlerts = $false
        $application.AskToUpdateLinks = $false
        $application.AutomationSecurity = 3
        foreach ($file in $Files) {
            $hashBefore = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $result = New-Result -File $file -Application "Excel" -HashBefore $hashBefore
            $workbook = $null
            try {
                $workbook = $application.Workbooks.Open($file.FullName, 0, $true)
                $chartCount = 0
                $pivotTableCount = 0
                foreach ($worksheet in @($workbook.Worksheets)) {
                    $chartObjects = $null
                    $pivotTables = $null
                    try {
                        $chartObjects = $worksheet.ChartObjects()
                        $pivotTables = $worksheet.PivotTables()
                        $chartCount += [int]$chartObjects.Count
                        $pivotTableCount += [int]$pivotTables.Count
                    } finally {
                        Release-ComObject $chartObjects
                        Release-ComObject $pivotTables
                        Release-ComObject $worksheet
                    }
                }
                $result.openedReadOnly = [bool]$workbook.ReadOnly
                $result.structure = [ordered]@{
                    worksheets = [int]$workbook.Worksheets.Count
                    names = [int]$workbook.Names.Count
                    charts = $chartCount
                    pivotTables = $pivotTableCount
                    calculationVersion = [int]$workbook.CalculationVersion
                }
            } catch {
                $result.error = $_.Exception.Message
            } finally {
                if ($null -ne $workbook) {
                    $workbook.Close($false)
                    Release-ComObject $workbook
                }
                $result.hashAfter = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                $result.sourceUnchanged = $result.hashBefore -eq $result.hashAfter
                $result.passed = $result.openedReadOnly -and $result.sourceUnchanged -and -not $result.error
                $script:Results.Add($result)
            }
        }
    } finally {
        if ($null -ne $application) {
            $application.Quit()
            Release-ComObject $application
        }
    }
}

function Test-PowerPointFiles {
    param([IO.FileInfo[]]$Files)

    $application = $null
    try {
        $application = New-Object -ComObject PowerPoint.Application
        $application.AutomationSecurity = 3
        foreach ($file in $Files) {
            $hashBefore = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $result = New-Result -File $file -Application "PowerPoint" -HashBefore $hashBefore
            $presentation = $null
            try {
                $presentation = $application.Presentations.Open(
                    $file.FullName,
                    -1,
                    0,
                    0
                )
                $shapeCount = 0
                $animationCount = 0
                $commentCount = 0
                foreach ($slide in @($presentation.Slides)) {
                    $shapeCount += [int]$slide.Shapes.Count
                    $animationCount += [int]$slide.TimeLine.MainSequence.Count
                    $commentCount += [int]$slide.Comments.Count
                    Release-ComObject $slide
                }
                $result.openedReadOnly = [bool]$presentation.ReadOnly
                $result.structure = [ordered]@{
                    slides = [int]$presentation.Slides.Count
                    shapes = $shapeCount
                    animations = $animationCount
                    comments = $commentCount
                }
            } catch {
                $result.error = $_.Exception.Message
            } finally {
                if ($null -ne $presentation) {
                    $presentation.Close()
                    Release-ComObject $presentation
                }
                $result.hashAfter = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                $result.sourceUnchanged = $result.hashBefore -eq $result.hashAfter
                $result.passed = $result.openedReadOnly -and $result.sourceUnchanged -and -not $result.error
                $script:Results.Add($result)
            }
        }
    } finally {
        if ($null -ne $application) {
            $application.Quit()
            Release-ComObject $application
        }
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "Microsoft Office reopen checks require Windows."
}
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    throw "Round-trip output directory does not exist: $OutputDirectory"
}

$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
$officeConfiguration = Get-ItemProperty `
    -LiteralPath "HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration" `
    -ErrorAction Stop
$files = Get-EditedFiles -Root $OutputDirectory
$script:Results = [Collections.Generic.List[object]]::new()

Test-WordFiles -Files @($files | Where-Object Extension -eq ".docx")
Test-ExcelFiles -Files @($files | Where-Object Extension -eq ".xlsx")
Test-PowerPointFiles -Files @($files | Where-Object Extension -eq ".pptx")

$failed = @($script:Results | Where-Object { -not $_.passed })
$report = [ordered]@{
    passed = $failed.Count -eq 0
    productionReady = $false
    platform = [Environment]::OSVersion.VersionString
    office = [ordered]@{
        version = [string]$officeConfiguration.VersionToReport
        products = [string]$officeConfiguration.ProductReleaseIds
        architecture = [string]$officeConfiguration.Platform
        culture = [string]$officeConfiguration.ClientCulture
    }
    fixtureCount = $script:Results.Count
    failedFixtureCount = $failed.Count
    results = $script:Results
}

New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding utf8
$report | ConvertTo-Json -Depth 10

[GC]::Collect()
[GC]::WaitForPendingFinalizers()

if (-not $report.passed) {
    throw "$($failed.Count) edited Office fixtures failed the Microsoft Office reopen check."
}
