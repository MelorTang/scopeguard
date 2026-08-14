# Document runtime round-trip prototype

This prototype supports issue #8. It measures narrow DOCX, XLSX, PPTX, and PDF
operations without claiming that the synthetic corpus represents company
documents or Microsoft Office fidelity.

## What it proves

- A DOCX/XLSX/PPTX edit changes one expected package part only.
- The source file hash remains unchanged through edit and render jobs.
- No package parts are added or removed.
- Open XML SDK validation introduces no new error fingerprints relative to the
  source file. Existing source errors remain visible and are not projected as a
  clean result.
- LibreOffice can render source and edited copies to the same page count and
  dimensions, with the intended edit constrained to a bounded pixel ratio.
- qpdf can perform a content-preserving rewrite and a typed page rotation while
  leaving the source PDF unchanged.

The report does not contain document text. Rendered PNG/PDF outputs do contain
the document content and must be handled at the same sensitivity as the source.

## Windows prerequisites

- PowerShell 7
- .NET 8 SDK
- Python 3 with `Pillow==12.3.0`
- LibreOffice Fresh 26.2.3
- Poppler 26.6.0 (`pdftoppm`)
- qpdf 12.3.2

The versions above are the pinned prototype baseline, not the final product
runtime pack.

## Run the public corpus

```powershell
python -m pip install -r prototypes/document-runtime-roundtrip/requirements.txt
pwsh -File prototypes/document-runtime-roundtrip/run.ps1
```

Results are written to `prototypes/document-runtime-roundtrip/out/result.json`.
The output directory is ignored by Git.

## Run private company fixtures

Place DOCX, XLSX, PPTX, and one PDF in a directory outside the repository, then
run locally:

```powershell
pwsh -File prototypes/document-runtime-roundtrip/run.ps1 `
  -FixtureDirectory "D:\private\scopeguard-document-fixtures" `
  -OutputDirectory "$env:TEMP\scopeguard-document-results"
```

Do not use GitHub Actions for private fixtures. The final Windows acceptance
also requires opening every edited Office file in the installed Microsoft Word,
Excel, or PowerPoint version and recording whether the application reports a
repair, compatibility loss, changed pagination, stale formulas, or altered
animation/SmartArt/chart behavior.

## Non-claims

- OpenXmlValidator success does not prove Office opens or renders identically.
- LibreOffice source/output similarity does not prove Microsoft Office fidelity.
- The pixel threshold detects broad regressions; it does not classify the
  intended text edit semantically.
- Pivot tables, charts, SmartArt, animations, tracked revisions, and unknown
  extension parts are preservation targets only. This prototype does not edit
  them.
- PDF pass-through and page rotation do not prove text editing, reflow,
  redaction, signature preservation, PDF/A, or PDF/UA support.
