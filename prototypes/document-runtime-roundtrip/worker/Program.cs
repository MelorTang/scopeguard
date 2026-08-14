using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using DocumentFormat.OpenXml.Validation;
using A = DocumentFormat.OpenXml.Drawing;
using W = DocumentFormat.OpenXml.Wordprocessing;

namespace ScopeGuard.DocumentRoundTrip;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 4 || !string.Equals(args[0], "roundtrip", StringComparison.Ordinal))
            {
                Console.Error.WriteLine("Usage: ScopeGuard.DocumentRoundTrip roundtrip <input> <output> <report>");
                return 2;
            }

            RunRoundTrip(
                Path.GetFullPath(args[1]),
                Path.GetFullPath(args[2]),
                Path.GetFullPath(args[3]));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void RunRoundTrip(string inputPath, string outputPath, string reportPath)
    {
        if (!File.Exists(inputPath))
        {
            throw new FileNotFoundException("Input document does not exist.", inputPath);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);

        var sourceHashBefore = HashFile(inputPath);
        var packageBefore = ReadPackageManifest(inputPath);
        var validationBefore = Validate(inputPath);

        File.Copy(inputPath, outputPath, overwrite: true);
        var edit = ApplyNarrowEdit(outputPath);

        var packageAfter = ReadPackageManifest(outputPath);
        var validationAfter = Validate(outputPath);
        var sourceHashAfter = HashFile(inputPath);

        var beforeNames = packageBefore.Keys.ToHashSet(StringComparer.Ordinal);
        var afterNames = packageAfter.Keys.ToHashSet(StringComparer.Ordinal);
        var addedParts = afterNames.Except(beforeNames, StringComparer.Ordinal).Order().ToArray();
        var removedParts = beforeNames.Except(afterNames, StringComparer.Ordinal).Order().ToArray();
        var changedParts = beforeNames.Intersect(afterNames, StringComparer.Ordinal)
            .Where(name => !string.Equals(packageBefore[name], packageAfter[name], StringComparison.Ordinal))
            .Order()
            .ToArray();
        var unexpectedChangedParts = changedParts
            .Where(name => !string.Equals(name, edit.PartName, StringComparison.Ordinal))
            .ToArray();

        var beforeErrorKeys = validationBefore.Issues
            .Select(issue => issue.Key)
            .ToHashSet(StringComparer.Ordinal);
        var newValidationErrors = validationAfter.Issues
            .Where(issue => !beforeErrorKeys.Contains(issue.Key))
            .ToArray();

        var sourceUnchanged = string.Equals(sourceHashBefore, sourceHashAfter, StringComparison.Ordinal);
        var intendedPartChanged = changedParts.Contains(edit.PartName, StringComparer.Ordinal);
        var passed = sourceUnchanged
            && intendedPartChanged
            && addedParts.Length == 0
            && removedParts.Length == 0
            && unexpectedChangedParts.Length == 0
            && newValidationErrors.Length == 0;

        var report = new RoundTripReport(
            InputName: Path.GetFileName(inputPath),
            OutputName: Path.GetFileName(outputPath),
            Format: Path.GetExtension(inputPath).TrimStart('.').ToLowerInvariant(),
            Operation: "replace-first-visible-text-with-same-length-marker",
            EditedPart: edit.PartName,
            EditedLocation: edit.Location,
            OriginalTextLength: edit.OriginalTextLength,
            ReplacementTextLength: edit.ReplacementTextLength,
            SourceHashBefore: sourceHashBefore,
            SourceHashAfter: sourceHashAfter,
            SourceUnchanged: sourceUnchanged,
            PackagePartCountBefore: packageBefore.Count,
            PackagePartCountAfter: packageAfter.Count,
            AddedParts: addedParts,
            RemovedParts: removedParts,
            ChangedParts: changedParts,
            UnexpectedChangedParts: unexpectedChangedParts,
            IntendedPartChanged: intendedPartChanged,
            ValidationErrorsBefore: validationBefore.Issues.Length,
            ValidationErrorsAfter: validationAfter.Issues.Length,
            NewValidationErrors: newValidationErrors,
            Passed: passed);

        File.WriteAllText(reportPath, JsonSerializer.Serialize(report, JsonOptions));
        Console.WriteLine(JsonSerializer.Serialize(report, JsonOptions));

        if (!passed)
        {
            throw new InvalidOperationException($"Round-trip checks failed. See {reportPath}.");
        }
    }

    private static EditResult ApplyNarrowEdit(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".docx" => EditWord(path),
            ".xlsx" => EditSpreadsheet(path),
            ".pptx" => EditPresentation(path),
            _ => throw new NotSupportedException("Only DOCX, XLSX, and PPTX are accepted by this worker."),
        };
    }

    private static EditResult EditWord(string path)
    {
        using var document = WordprocessingDocument.Open(path, true);
        var mainPart = document.MainDocumentPart
            ?? throw new InvalidDataException("DOCX has no main document part.");
        var root = mainPart.Document
            ?? throw new InvalidDataException("DOCX main document part has no root element.");
        var text = root.Descendants<W.Text>()
            .FirstOrDefault(candidate => ContainsEditableCharacter(candidate.Text));
        if (text is null)
        {
            throw new InvalidDataException("DOCX has no eligible visible text in the main document part.");
        }

        var original = text.Text;
        text.Text = CreateSameLengthMarker(original);
        root.Save();

        return new EditResult(
            NormalizePartName(mainPart.Uri),
            BuildElementLocation(text),
            original.Length,
            text.Text.Length);
    }

    private static EditResult EditSpreadsheet(string path)
    {
        var plan = PlanSpreadsheetEdit(path);
        using var document = SpreadsheetDocument.Open(path, true);
        var workbookPart = document.WorkbookPart
            ?? throw new InvalidDataException("XLSX has no workbook part.");

        if (plan.SharedStringIndex is int sharedStringIndex)
        {
            var sharedStringPart = workbookPart.SharedStringTablePart
                ?? throw new InvalidDataException("Planned shared string part is missing.");
            var sharedStringTable = sharedStringPart.SharedStringTable
                ?? throw new InvalidDataException("Shared string part has no root element.");
            var item = sharedStringTable.Elements<SharedStringItem>().ElementAtOrDefault(sharedStringIndex)
                ?? throw new InvalidDataException("Planned shared string item is missing.");
            var text = item.Descendants<DocumentFormat.OpenXml.Spreadsheet.Text>()
                .FirstOrDefault(candidate => ContainsEditableCharacter(candidate.Text))
                ?? throw new InvalidDataException("Planned shared string text is missing.");
            var original = text.Text;
            text.Text = CreateSameLengthMarker(original);
            sharedStringTable.Save();
            return new EditResult(
                NormalizePartName(sharedStringPart.Uri),
                $"{NormalizePartName(sharedStringPart.Uri)}#si[{sharedStringIndex}]",
                original.Length,
                text.Text.Length);
        }

        var targetPart = workbookPart.WorksheetParts.SingleOrDefault(
            part => string.Equals(NormalizePartName(part.Uri), plan.WorksheetPartName, StringComparison.Ordinal))
            ?? throw new InvalidDataException("Planned worksheet part is missing.");
        var root = targetPart.Worksheet
            ?? throw new InvalidDataException("XLSX worksheet part has no root element.");
        var cell = root.Descendants<Cell>().SingleOrDefault(candidate =>
            string.Equals(candidate.CellReference?.Value, plan.CellReference, StringComparison.Ordinal))
            ?? throw new InvalidDataException("Planned worksheet cell is missing.");
        var originalCellText = ReadCellText(cell, sharedStrings: null);
        var replacement = CreateSameLengthMarker(originalCellText);
        cell.CellValue = null;
        cell.InlineString = new InlineString(
            new DocumentFormat.OpenXml.Spreadsheet.Text(replacement)
            {
                Space = SpaceProcessingModeValues.Preserve,
            });
        cell.DataType = CellValues.InlineString;
        root.Save();

        return new EditResult(
            NormalizePartName(targetPart.Uri),
            $"{NormalizePartName(targetPart.Uri)}#{cell.CellReference?.Value ?? "unknown-cell"}",
            originalCellText.Length,
            replacement.Length);
    }

    private static SpreadsheetEditPlan PlanSpreadsheetEdit(string path)
    {
        using var document = SpreadsheetDocument.Open(path, false);
        var workbookPart = document.WorkbookPart
            ?? throw new InvalidDataException("XLSX has no workbook part.");
        var sharedStringTable = workbookPart.SharedStringTablePart?.SharedStringTable;

        if (sharedStringTable is not null)
        {
            var referenceCounts = new Dictionary<int, int>();
            foreach (var worksheetPart in workbookPart.WorksheetParts)
            {
                var worksheet = worksheetPart.Worksheet
                    ?? throw new InvalidDataException("XLSX worksheet part has no root element.");
                foreach (var cell in worksheet.Descendants<Cell>())
                {
                    if (cell.DataType?.Value == CellValues.SharedString
                        && int.TryParse(cell.CellValue?.Text, out var index))
                    {
                        referenceCounts[index] = referenceCounts.GetValueOrDefault(index) + 1;
                    }
                }
            }

            var items = sharedStringTable.Elements<SharedStringItem>().ToArray();
            for (var index = 0; index < items.Length; index++)
            {
                var text = items[index].Descendants<DocumentFormat.OpenXml.Spreadsheet.Text>()
                    .FirstOrDefault(candidate => ContainsEditableCharacter(candidate.Text));
                if (text is not null && referenceCounts.GetValueOrDefault(index) == 1)
                {
                    return new SpreadsheetEditPlan(index, WorksheetPartName: null, CellReference: null);
                }
            }

            throw new InvalidDataException("XLSX has no uniquely referenced editable shared string.");
        }

        foreach (var worksheetPart in workbookPart.WorksheetParts)
        {
            var root = worksheetPart.Worksheet
                ?? throw new InvalidDataException("XLSX worksheet part has no root element.");
            var cell = root.Descendants<Cell>()
                .FirstOrDefault(candidate =>
                    candidate.CellFormula is null
                    && ContainsEditableCharacter(ReadCellText(candidate, sharedStrings: null)));
            if (cell is not null)
            {
                return new SpreadsheetEditPlan(
                    SharedStringIndex: null,
                    WorksheetPartName: NormalizePartName(worksheetPart.Uri),
                    CellReference: cell.CellReference?.Value
                        ?? throw new InvalidDataException("Editable cell has no reference."));
            }
        }

        throw new InvalidDataException("XLSX has no eligible non-formula cell value.");
    }

    private static EditResult EditPresentation(string path)
    {
        using var document = PresentationDocument.Open(path, true);
        var presentationPart = document.PresentationPart
            ?? throw new InvalidDataException("PPTX has no presentation part.");

        foreach (var slidePart in presentationPart.SlideParts.OrderBy(part => part.Uri.ToString(), StringComparer.Ordinal))
        {
            var root = slidePart.Slide
                ?? throw new InvalidDataException("PPTX slide part has no root element.");
            var text = root.Descendants<A.Text>()
                .FirstOrDefault(candidate => ContainsEditableCharacter(candidate.Text));
            if (text is null)
            {
                continue;
            }

            var original = text.Text;
            text.Text = CreateSameLengthMarker(original);
            root.Save();

            return new EditResult(
                NormalizePartName(slidePart.Uri),
                BuildElementLocation(text),
                original.Length,
                text.Text.Length);
        }

        throw new InvalidDataException("PPTX has no eligible visible slide text.");
    }

    private static string ReadCellText(Cell cell, SharedStringTablePart? sharedStrings)
    {
        if (cell.InlineString is not null)
        {
            return cell.InlineString.InnerText;
        }

        var value = cell.CellValue?.Text ?? string.Empty;
        if (cell.DataType?.Value != CellValues.SharedString
            || sharedStrings?.SharedStringTable is null
            || !int.TryParse(value, out var index))
        {
            return value;
        }

        var item = sharedStrings.SharedStringTable.Elements<SharedStringItem>().ElementAtOrDefault(index);
        return item?.InnerText ?? string.Empty;
    }

    private static ValidationResult Validate(string path)
    {
        using var package = OpenPackage(path, editable: false);
        var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
        var issues = validator.Validate(package)
            .Select(error => new ValidationIssue(
                Id: error.Id,
                ErrorType: error.ErrorType.ToString(),
                Part: error.Path?.PartUri?.ToString() ?? error.Part?.Uri.ToString() ?? string.Empty,
                Path: error.Path?.XPath ?? string.Empty))
            .OrderBy(issue => issue.Key, StringComparer.Ordinal)
            .ToArray();
        return new ValidationResult(issues);
    }

    private static OpenXmlPackage OpenPackage(string path, bool editable)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".docx" => WordprocessingDocument.Open(path, editable),
            ".xlsx" => SpreadsheetDocument.Open(path, editable),
            ".pptx" => PresentationDocument.Open(path, editable),
            _ => throw new NotSupportedException("Unsupported Open XML extension."),
        };
    }

    private static SortedDictionary<string, string> ReadPackageManifest(string path)
    {
        var manifest = new SortedDictionary<string, string>(StringComparer.Ordinal);
        using var archive = ZipFile.OpenRead(path);
        foreach (var entry in archive.Entries.OrderBy(entry => entry.FullName, StringComparer.Ordinal))
        {
            if (entry.FullName.EndsWith("/", StringComparison.Ordinal))
            {
                continue;
            }

            if (manifest.ContainsKey(entry.FullName))
            {
                throw new InvalidDataException($"Duplicate ZIP entry is not accepted: {entry.FullName}");
            }

            using var stream = entry.Open();
            manifest.Add(entry.FullName, Convert.ToHexString(SHA256.HashData(stream)));
        }

        return manifest;
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static bool ContainsEditableCharacter(string? value)
    {
        return value?.Any(char.IsLetterOrDigit) == true;
    }

    private static string CreateSameLengthMarker(string value)
    {
        var characters = value.ToCharArray();
        for (var index = 0; index < characters.Length; index++)
        {
            if (char.IsDigit(characters[index]))
            {
                characters[index] = characters[index] == '9' ? '8' : '9';
                return new string(characters);
            }

            if (char.IsLetter(characters[index]))
            {
                characters[index] = characters[index] == 'X' ? 'Y' : 'X';
                return new string(characters);
            }
        }

        throw new InvalidDataException("Text has no editable letter or digit.");
    }

    private static string BuildElementLocation(OpenXmlElement element)
    {
        var path = new XmlPath(element);
        return $"{path.PartUri}{path.XPath}";
    }

    private static string NormalizePartName(Uri uri)
    {
        return uri.ToString().TrimStart('/');
    }

    private sealed record EditResult(
        string PartName,
        string Location,
        int OriginalTextLength,
        int ReplacementTextLength);

    private sealed record SpreadsheetEditPlan(
        int? SharedStringIndex,
        string? WorksheetPartName,
        string? CellReference);

    private sealed record ValidationResult(ValidationIssue[] Issues);

    private sealed record ValidationIssue(string Id, string ErrorType, string Part, string Path)
    {
        public string Key => $"{Id}|{ErrorType}|{Part}|{Path}";
    }

    private sealed record RoundTripReport(
        string InputName,
        string OutputName,
        string Format,
        string Operation,
        string EditedPart,
        string EditedLocation,
        int OriginalTextLength,
        int ReplacementTextLength,
        string SourceHashBefore,
        string SourceHashAfter,
        bool SourceUnchanged,
        int PackagePartCountBefore,
        int PackagePartCountAfter,
        string[] AddedParts,
        string[] RemovedParts,
        string[] ChangedParts,
        string[] UnexpectedChangedParts,
        bool IntendedPartChanged,
        int ValidationErrorsBefore,
        int ValidationErrorsAfter,
        ValidationIssue[] NewValidationErrors,
        bool Passed);
}
