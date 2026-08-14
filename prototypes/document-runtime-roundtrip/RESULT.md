# Document runtime round-trip checkpoint

Date: 2026-08-14  
Issue: [#8](https://github.com/MelorTang/scopeguard/issues/8)  
Branch: `codex/prototype-document-runtime`  
Commit: `3e007e2534dcebee73a853c99d6b4a49e3694842`  
Windows run: [31769937375](https://github.com/MelorTang/scopeguard/actions/runs/31769937375)

## Result

The public-corpus checkpoint passes. It does not close issue #8 and does not
claim production readiness. Private company fixtures and installed Microsoft
Office remain required acceptance gates.

The final Windows Server 2022 run passed all seven fixtures with no source-file
mutation, no unexpected Open XML package-part changes, no new validation
errors, stable render page counts and dimensions, and bounded visual changes.

| Fixture | Intended changed part | Pages | Changed pixel ratio | Result |
| --- | --- | ---: | ---: | --- |
| `excel-pivot.xlsx` | `xl/sharedStrings.xml` | 11 | 0.000020 | Pass |
| `excel-workbook.xlsx` | `xl/sharedStrings.xml` | 85 | 0.000018 | Pass |
| `powerpoint-chart-animation.pptx` | `ppt/slides/slide1.xml` | 1 | 0.005240 | Pass |
| `powerpoint-smartart.pptx` | `ppt/slides/slide1.xml` | 1 | 0.003086 | Pass |
| `word-complexity.docx` | `word/document.xml` | 11 | 0.000048 | Pass |
| `word-revisions.docx` | `word/document.xml` | 1 | 0.001292 | Pass |
| `pdf-operations-brief.pdf` | None; qpdf rewrite | 3 | 0.000000 | Pass |

The PDF case also produced and validated a page-rotation output. Representative
Windows renders for the pivot workbook, SmartArt presentation, and synthetic
PDF were inspected manually and were nonblank and coherently framed.

The same six Open XML fixtures passed the structure and LibreOffice render
matrix on macOS. The worker also built locally with .NET SDK 8.0.424 with zero
warnings and zero errors.

## Preliminary V1 boundary

Evidence currently supports these narrow operations:

- inspect DOCX, XLSX, and PPTX package structure without changing the source;
- replace text only when the operation can name and constrain the intended XML
  part, then reject added, removed, or unexpected changed parts;
- generate a LibreOffice-based preview as a convenience view, with explicit
  disclosure that it is not Microsoft Office fidelity;
- inspect, copy, render, and perform typed page operations such as rotation on
  PDF files while preserving the source;
- emit a machine-readable report that excludes document text.

This checkpoint does not support arbitrary Office editing, pivot/chart/
SmartArt/animation mutation, PDF text editing, redaction, signature
preservation, or claims of exact Microsoft Office rendering.

## Findings from the Windows run

- The Chocolatey `poppler` 26.6.0 package contained source code rather than
  `pdftoppm.exe`; the prototype now uses pinned PyMuPDF 1.28.2 for rendering.
- `soffice.exe` can return before conversion output is visible on Windows; the
  prototype uses `soffice.com` and a bounded output wait.
- Git line-ending conversion corrupts PDF cross-reference offsets. Repository
  attributes now force DOCX, XLSX, PPTX, PDF, and PNG files to remain binary.
- The worker targets `net8.0`. The Windows runner installed SDK 8.0.424 but
  selected its preinstalled SDK 10.0.302; production packaging must pin the
  effective SDK as well as the target framework.

## Remaining acceptance gate

Run the matrix locally on a Windows 10/11 workstation with private company
fixtures stored outside the repository. Then open every edited Office file in
the installed company versions of Word, Excel, and PowerPoint and record:

- whether Office reports repair or compatibility loss;
- pagination, print-area, formula, and calculated-value changes;
- chart, pivot, SmartArt, animation, comment, and tracked-revision behavior;
- fonts, embedded objects, macros, signatures, links, and external data losses;
- the exact Office version and Windows build.

Only after that evidence is attached to #8 should #9 define the release-grade
operation and fallback contract.
