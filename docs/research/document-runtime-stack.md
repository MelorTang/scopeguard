# Document Runtime Stack Research

> Status: Historical research snapshot retained as input to the Office Tool Pack. Its enterprise assumptions and recommended stack are not current implementation commitments.

Research snapshot: 2026-08-12. This answers [issue #11](https://github.com/MelorTang/scopeguard/issues/11) for the V1 planning map in [issue #2](https://github.com/MelorTang/scopeguard/issues/2). Sources are limited to standards bodies, official vendor documentation, and official project documentation, source, releases, and licenses.

Evidence labels used below:

- **Documented**: the cited owner explicitly describes the capability or limitation.
- **Inference**: a bounded architecture conclusion from documented behavior.
- **Prototype required**: the sources establish that the operation exists, but not that it preserves ScopeGuard's real documents well enough.

No library or converter evaluated here establishes Microsoft Office visual equivalence. Any such acceptance requires the Windows fixture prototype described below.

## Decision Summary

Use a split, local runtime:

1. Keep Electron/Node as the coordinator and review UI.
2. Use a self-contained .NET 10 worker with `DocumentFormat.OpenXml` 3.5.1 for DOCX, XLSX, and PPTX package inspection, normalized structural reads, allowlisted generation/revision, and schema validation.
3. Use a pinned LibreOffice build only as the Office-to-PDF preview/export engine, launched headlessly with an isolated profile and hostile-document controls. Treat every DOCX/XLSX/PPTX rendering result as **prototype required**, not as a fidelity guarantee.
4. Use PDF.js for PDF parsing, text/geometry extraction, and in-window rendering. Use qpdf for bounded page-level transformations such as merge, select, reorder, rotate, overlay, and underlay.
5. Use Tesseract.js with locally bundled `eng` and `chi_sim` `tessdata_fast` models for V1 OCR. Render PDF pages to images with PDF.js first; Tesseract.js does not accept PDF input directly.
6. Use unified/remark/rehype for Markdown and HTML AST operations, `rehype-sanitize` for review projections, Electron Chromium for HTML/Markdown rendering, and `webContents.printToPDF` for fixed-layout export.
7. Build comparison from a format-specific normalized structure diff plus a renderer-specific page-image diff. Use jsdiff for text/token arrays and pixelmatch for raster differences. Never equate a zero structural diff with byte identity, or a low image diff with Microsoft Office fidelity.

The recommended stack is viable on Windows x64 and macOS Apple Silicon. The JavaScript/WASM components are architecture-neutral; .NET publishes explicit `win-x64` and `osx-arm64` workers; LibreOffice publishes Windows and Apple silicon builds. The cost is a large, separately managed Office rendering dependency and a mandatory Windows fidelity gate.

## Product Constraints

The recommendation preserves the established repository decisions:

- [ADR 0004](../adr/0004-local-workspace-enterprise-control-plane.md): document processing and Workspace Files remain on the Desktop. No cloud conversion service is part of V1.
- [ADR 0010](../adr/0010-target-windows-first.md): Windows 10/11 x64 is the release acceptance platform; Apple silicon macOS is development and secondary support.
- [ADR 0015](../adr/0015-share-live-workspaces-with-conflict-detection.md): every editable read records a source hash; writes stop on conflict; Office revisions create new Artifact Versions by default.
- [ADR 0021](../adr/0021-switch-between-workbench-and-artifact-review.md): the runtime must support a large preview and version-comparison canvas, not merely text extraction.
- The V1 map excludes full Office editing. "Structural revision" therefore means an explicit operation allowlist, not a general-purpose Word, Excel, PowerPoint, or PDF editor.

### Confirmed V1 format matrix

The planning context names six formats and the read, generate/revise, render, OCR, compare, and export axes. The following is the implementable interpretation of that matrix.

| Format | Read projection | Structural generation/revision | In-window rendering | OCR | Compare | Export |
| --- | --- | --- | --- | --- | --- | --- |
| DOCX | Paragraphs/runs, styles, lists, tables, sections, headers/footers, notes/comments, media and relationships | New documents and allowlisted changes to text, tables, images, metadata, styles, and page settings; no arbitrary layout reflow | LibreOffice to PDF, then PDF.js; structural fallback only | Not for normal text; optional OCR of selected embedded images | Normalized document structure plus renderer-specific page diff | New DOCX Artifact Version; PDF only after prototype acceptance |
| XLSX | Sheets, cells, types, formulas and cached values, styles, dimensions, merges, names, tables, comments, drawings and relationships | New workbooks and allowlisted cell/sheet/style/table changes; no promise to calculate Excel formulas | LibreOffice to PDF, then PDF.js; data-grid fallback is not a print preview | Not in V1 | Cell/structure diff plus renderer-specific page diff | New XLSX Artifact Version; PDF/CSV for explicit scopes after acceptance |
| PPTX | Slide order, masters/layouts/themes, shapes, text, media, notes, charts and relationships | New decks and allowlisted slide/text/image/shape changes; complex SmartArt, animation, and media edits excluded | LibreOffice to PDF, then PDF.js; outline fallback only | Not in V1 | Slide/shape structure plus renderer-specific page diff | New PPTX Artifact Version; PDF after acceptance |
| PDF | Pages, metadata, text items with geometry, annotations/attachments inventory, and rendered pages | Page select/reorder/merge/split/rotate and overlay/underlay; no flowing-text edit | PDF.js | Yes for image-only or user-selected pages | Text/geometry plus page raster diff; no semantic-equivalence claim | New PDF Artifact Version, page images, and extracted/OCR text |
| MD | CommonMark plus explicitly enabled GFM AST | Full AST/text generation and revision within the supported dialect | Sanitized HTML in sandboxed Chromium | Not applicable | Source text plus mdast diff and optional render diff | MD, sanitized HTML, and Chromium PDF |
| HTML | Parsed HAST/DOM-like structure and text | Static HTML/CSS structure only; scripts and active embeds are not V1 document content | Sanitized, offline, sandboxed Chromium | Not applicable | Source text plus HAST diff and optional render diff | HTML and Chromium PDF |

## Why A Split Runtime Is Necessary

OOXML is a package and markup standard, not a layout engine. ECMA-376 defines the document vocabularies, representation, and Open Packaging Conventions for Office Open XML ([ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)). Microsoft describes Open XML files as ZIP/XML packages and the Open XML SDK as strongly typed access to those packages ([SDK overview](https://learn.microsoft.com/en-us/office/open-xml/open-xml-sdk)).

Microsoft also documents the decisive limitations: the SDK does not replace the Office object model, does not convert to formats such as HTML or XPS, does not guarantee a valid document, and does not implement Word layout or Excel recalculation/data refresh ([design considerations](https://learn.microsoft.com/en-us/office/open-xml/open-xml-sdk-design-considerations)). A renderer and a calculation/fidelity test path are therefore separate concerns.

PDF has the inverse shape. PDF.js is explicitly a parsing and rendering platform ([project README](https://github.com/mozilla/pdf.js/tree/c8fbf33e095945890b4a6699c87becd8603713ee)), while qpdf is explicitly a low-level, content-preserving transformer that does not render or extract text ([qpdf README](https://github.com/qpdf/qpdf/tree/babad179ce5db9a21635c8d1ac17baa59637eada)). Neither is a full PDF content editor.

Markdown and HTML do have maintained JavaScript AST ecosystems. unified defines parse-transform-stringify processing over syntax trees ([unified](https://github.com/unifiedjs/unified/tree/ba1af683ba597228b736566752668e7132295d38)); remark provides CommonMark/GFM-oriented Markdown AST processing ([remark](https://github.com/remarkjs/remark/tree/334415d7552f2ffa359a23efc100345e7ed7a9f7)); and parse5 implements WHATWG-compliant HTML parsing/serialization for Node.js ([parse5](https://github.com/inikulin/parse5/tree/259bd3d5a77d130e811a37cf0a09aa9a6b395e1f)). These formats should stay in the Electron/Node process boundary rather than being routed through LibreOffice.

## Office Structure: Open XML SDK Worker

### Selection

Use `DocumentFormat.OpenXml` 3.5.1 in a .NET 10 LTS console worker.

- **Documented:** the official SDK supports Word, Excel, and PowerPoint package generation and modification, low-level OPC operations, strongly typed markup, and LINQ to XML ([repository](https://github.com/dotnet/Open-XML-SDK), [NuGet 3.5.1](https://www.nuget.org/packages/DocumentFormat.OpenXml/3.5.1)).
- **Documented:** Open XML SDK is MIT-licensed ([license](https://github.com/dotnet/Open-XML-SDK/blob/cd2b359ef824737edb93f1c6157c19551aae1e52/LICENSE)).
- **Documented:** .NET publishes OS/architecture-specific self-contained single-file applications, and the official RID catalog includes `win-x64` and `osx-arm64` ([single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview), [RID catalog](https://learn.microsoft.com/en-us/dotnet/core/rid-catalog)). .NET 10 is the active LTS line through November 2028 at this snapshot ([support policy](https://dotnet.microsoft.com/en-us/platform/support/policy)).
- **Inference:** one typed OOXML worker is a smaller ownership surface than separate JavaScript or Python libraries for each Office format. It also keeps low-level package parsing out of the Electron renderer.

The worker should expose a versioned JSON-lines or length-prefixed local protocol. Commands should be coarse grained: `inspect`, `extract`, `normalize`, `generate`, `revise`, `validate`, and `inventory-active-content`. Do not expose raw arbitrary XPath or filesystem paths supplied by renderer content.

### V1 operation allowlists

**DOCX**

- Generate and revise paragraphs, runs, headings, lists, tables, inline images, hyperlinks, core metadata, headers/footers, section/page settings, and known styles.
- Preserve comments, footnotes/endnotes, tracked revisions, custom XML, charts, embedded objects, and unknown extension parts unless the requested operation explicitly owns them.
- Do not claim a general text search-and-replace operation is layout safe. Word text can be split across runs and fields; replacement must operate on a normalized block model and map back only when the edit contract is unambiguous.
- Do not create Word tracked changes in V1. ScopeGuard's version comparison is its own Artifact comparison, not a promise to author native Word revisions.

**XLSX**

- Generate and revise worksheets, cells, formulas, data types, number formats, styles, row/column dimensions, merges, named ranges, tables, comments, and supported drawings.
- Treat formula text and cached result as distinct fields. Open XML SDK does not calculate formulas. A write may request recalculation on next Excel open, but ScopeGuard must not present a stale cached value as a verified result.
- Preserve pivot tables, slicers, charts, external connections, macros, and unsupported extension parts unless an allowlisted operation owns them. External connections and macros are excluded from execution.
- CSV export is only for an explicit sheet/range and loses formulas, styles, merges, charts, comments, and workbook structure by design.

**PPTX**

- Generate and revise slide order, text, simple shapes, images, notes, metadata, and template-bound placeholders.
- Preserve masters, layouts, themes, charts, SmartArt, animations, transitions, embedded media, and extension parts when they are outside the requested operation.
- Defer complex chart, SmartArt, animation, video, and arbitrary shape-geometry editing. Generation from a controlled template is safer than unconstrained revision.

### Validation is necessary, not sufficient

Run `OpenXmlValidator` on every generated Office artifact and report all newly introduced schema errors. Microsoft documents validator use ([validation example](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-validate-a-word-processing-document)), but also states that SDK use does not guarantee validity or application behavior. Passing validation therefore means only "no detected schema violation for the selected file-format version." It does not prove that Word, Excel, or PowerPoint will open without repair, calculate identically, or render identically.

Do not enable destructive markup-compatibility preprocessing by default. Microsoft documents that compatibility processing can filter unsupported namespaces and choose one `AlternateContent` branch ([markup compatibility](https://learn.microsoft.com/en-us/office/open-xml/general/introduction-to-markup-compatibility)). Narrow edits should retain untouched package parts and unknown markup byte-for-byte where practical; the fixture tests must detect losses.

## Office Rendering And Export: LibreOffice

### Bounded role

Use LibreOffice only to convert DOCX/XLSX/PPTX working copies to PDF for internal preview and explicit PDF export.

LibreOffice officially supports Windows 10/11 and both Intel and Apple silicon macOS; its published disk requirement is up to 1.5 GB on Windows and 800 MB on macOS ([system requirements](https://www.libreoffice.org/system-requirements/)). Its command line documents `--headless`, `--convert-to`, `--outdir`, and a per-process `-env:UserInstallation` profile path ([command-line parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)).

The documented existence of a conversion filter is not evidence of Microsoft Office layout fidelity. Fonts, fields, pagination, charts, formulas, SmartArt, and application-specific extensions may differ. Every required visual class is **prototype required** on Windows with real company fixtures.

### Process contract

For each job:

1. Copy the source Artifact Version to a private job directory; never point LibreOffice at the source path for writing.
2. Create a unique LibreOffice user profile. Configure macro security to `Very High` with no trusted file locations, and link updates to `Never`. LibreOffice documents that `Very High` disables all macros outside trusted locations ([macro security](https://help.libreoffice.org/latest/en-US/text/shared/optionen/macrosecurity_sl.html)) and warns that remote links can transmit local data ([external links](https://help.libreoffice.org/latest/en-US/text/shared/01/02180000.html)).
3. Launch the pinned binary with `--headless --nologo --nodefault --norestore`, the unique `UserInstallation`, an explicit input copy, and an explicit output directory.
4. Deny network access where the Windows execution-boundary research permits it. Preflight and refuse external relationship updates regardless; LibreOffice profile settings are defense in depth, not an OS sandbox guarantee.
5. Enforce a deadline, process-tree cancellation, output-size limit, and small concurrency cap. A unique profile avoids cross-job profile locks, but it does not make the office suite cheap or fully reentrant.
6. Validate that the expected PDF exists, is non-empty, opens in PDF.js, and has the expected page/slide/sheet range before publishing it.
7. Delete the job directory and profile on success, cancellation, or crash; retain only bounded diagnostics without document content.

### Distribution

Do not place LibreOffice inside Electron ASAR. Deliver a pinned, platform-specific "Document Runtime Pack" beside the main application, with hashes, version manifest, code signing/notarization, license and third-party notices, and the corresponding source/compliance materials required by the selected LibreOffice distribution. LibreOffice source is MPL 2.0 and the binary distribution includes components under additional licenses ([licensing information](https://api.libreoffice.org/share/readme/LICENSE.html)). Legal review must approve the exact redistribution package; this document is not a license opinion.

The runtime pack is preferable to discovering an arbitrary system LibreOffice install. Reproducible preview baselines require one tested binary and font inventory. If package size is unacceptable, make the runtime pack an explicit managed prerequisite and expose "layout preview unavailable" until it is installed.

## PDF Runtime

### PDF.js for read and render

Bundle a pinned `pdfjs-dist` release, its worker, CMaps, standard-font data, and any required image decoders locally. PDF.js defines separate core, display, and viewer layers; the display layer renders and exposes document information ([getting started](https://mozilla.github.io/pdf.js/getting_started/)). Its page API exposes rendering, text content, annotations, and JavaScript-action inventory ([PDFPageProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)). The project is Apache-2.0 licensed and active at the research snapshot ([source](https://github.com/mozilla/pdf.js/tree/c8fbf33e095945890b4a6699c87becd8603713ee), [license](https://github.com/mozilla/pdf.js/blob/c8fbf33e095945890b4a6699c87becd8603713ee/LICENSE)).

Use PDF.js for:

- page count, boxes, rotation, metadata, outline, attachment/annotation/action inventory;
- rendered page canvases and thumbnails;
- text items with transform/geometry for search and normalized comparison;
- bitmap input to OCR.

Disable or ignore document JavaScript, launch actions, submissions, and attachment execution. Links should be surfaced as inert metadata and opened only through an explicit, policy-checked Member action.

PDF text extraction is not a reading-order or semantic guarantee. Text may be missing, drawn as paths, split into positioned glyphs, use custom encodings, or have an order different from visual reading order. The normalized projection must carry page and geometry provenance and mark ambiguous ordering.

### qpdf for bounded structural writes

Bundle qpdf as a separately signed native executable built from the official source for each target. qpdf supports content-preserving transformations, page selection, merge/split, rotate, overlay/underlay, inspection, and JSON job input, while explicitly not rendering or extracting text ([project README](https://github.com/qpdf/qpdf), [CLI](https://qpdf.readthedocs.io/en/stable/cli.html), [JSON](https://qpdf.readthedocs.io/en/latest/json.html)). The repository is active and Apache-2.0 licensed at this snapshot ([license](https://github.com/qpdf/qpdf/blob/babad179ce5db9a21635c8d1ac17baa59637eada/LICENSE.txt)).

V1 should expose only typed page operations. Do not pass user-authored qpdf command lines. qpdf documents limitations around document-level structures during page splitting and selection, including outlines, forms, threads, and shared page objects; each exposed operation must have a matching fixture ([page-selection limitations](https://qpdf.readthedocs.io/en/stable/cli.html#page-selection-options)).

PDF content-stream text editing, paragraph reflow, redaction assurance, arbitrary annotation authoring, form design, signature preservation, and PDF/A or PDF/UA conformance are outside the V1 guarantee.

### PDF generation

- Office to PDF: accepted LibreOffice filter only.
- Markdown/HTML to PDF: a hidden, sandboxed Chromium `webContents` using a controlled print stylesheet and Electron's documented `printToPDF` API ([Electron API](https://www.electronjs.org/docs/latest/api/web-contents/#contentsprinttopdfoptions)).
- New composed PDF: generate static HTML from trusted ScopeGuard templates and print it; then use qpdf for page assembly if required.
- Existing PDF overlay/underlay: generate a separate overlay PDF and combine through an allowlisted qpdf job.

Do not select `pdf-lib` as a V1 foundation. Its official README says it cannot extract or edit ordinary page text, does not support HTML/CSS, and does not support encrypted documents ([limitations](https://github.com/Hopding/pdf-lib#limitations), [encryption](https://github.com/Hopding/pdf-lib#encryption-handling)). Its main source branch has not had a substantive commit since 2021 at this snapshot. It may be reconsidered for a small, isolated AcroForm use case, but it cannot own the PDF runtime.

### Poppler evaluation

Poppler is a maintained PDF rendering library with text and raster utilities ([project](https://poppler.freedesktop.org/), [releases](https://poppler.freedesktop.org/releases.html)). It is valuable as an independent prototype/debug oracle for PDFs that differ in PDF.js. It is not the recommended shipped engine because:

- official source is the reliable cross-platform distribution path; Windows packaging would require ScopeGuard-owned builds and dependency maintenance;
- Poppler source interfaces are GPL-2.0-or-later ([official header](https://poppler.freedesktop.org/api/cpp/poppler-global_8h_source.html)), which creates materially different redistribution obligations from the recommended permissive stack;
- adding a second shipped renderer doubles security servicing and can create renderer-dependent comparison results.

Use Poppler in the Windows prototype or CI corpus only after license review. If PDF.js fails an accepted fixture in production, the V1 fallback is external viewing, not silently switching renderers and changing comparison semantics.

## OCR

Use Tesseract.js in a Node worker thread or utility process with local assets only. It wraps a WebAssembly port of Tesseract, supports browser and Node environments, and is Apache-2.0 licensed ([Tesseract.js README](https://github.com/naptha/tesseract.js/tree/a1ca80d9e31c34512d0ded75ff8821ddcf3f2f91)). Its official FAQ states that it does not accept PDF input and recommends rendering PDF pages to images first, including with PDF.js ([FAQ](https://github.com/naptha/tesseract.js/blob/a1ca80d9e31c34512d0ded75ff8821ddcf3f2f91/docs/faq.md)).

V1 pipeline:

1. Attempt native PDF.js text extraction first.
2. Mark a page OCR-eligible when it has no usable text or when the Member explicitly requests OCR.
3. Render the page at a recorded effective DPI, initially 300 DPI for prototype fixtures.
4. Reuse a worker for a page batch. Load bundled `eng` and `chi_sim` models from local paths; never fetch a CDN model at runtime.
5. Store OCR text, confidence, word/line boxes, language/model version, page number, render DPI, and source Artifact Version as a derived projection. Do not rewrite the source PDF.
6. Label OCR output as machine-recognized and preserve access to the source page image.

The native Tesseract project supports UTF-8, more than 100 languages, image input, and text/hOCR/TSV/PDF outputs ([official README](https://github.com/tesseract-ocr/tesseract)). `tessdata_fast` is the official speed-oriented model set and is Apache-2.0 licensed ([model repository](https://github.com/tesseract-ocr/tessdata_fast)). If the WASM prototype misses throughput or memory gates, replace only the OCR worker with ScopeGuard-built native Tesseract binaries for `win-x64` and `osx-arm64`; do not change the OCR contract.

No handwriting, table reconstruction, signature interpretation, or OCR-based factual correctness is promised. The Tesseract.js FAQ explicitly says handwriting is unsupported.

## Markdown And HTML

### Structural runtime

Use one unified pipeline:

- Markdown: `remark-parse`, `remark-gfm` only if the Workspace dialect enables GFM, `remark-stringify`, and mdast utilities.
- HTML: `rehype-parse`/parse5, a ScopeGuard static-document schema, `rehype-sanitize`, and `rehype-stringify`.
- Markdown-to-review HTML: `remark-rehype` followed by sanitization. Raw embedded HTML is disabled by default; if later enabled, parse it and sanitize it before rendering. The official `remark-rehype` guidance demonstrates this order for untrusted raw HTML ([security example](https://github.com/remarkjs/remark-rehype#example-supporting-html-in-markdown-properly)).

`rehype-sanitize` drops content not explicitly allowed by its schema and recommends sanitizing whenever authors or plugins are not fully trusted ([project](https://github.com/rehypejs/rehype-sanitize)). ScopeGuard should use a narrower static-document schema: no scripts, event attributes, iframes, objects, embeds, forms, refresh, `javascript:` URLs, remote stylesheets, or remote media.

### Render and export isolation

Render the sanitized projection, never the original HTML, in a sandboxed `WebContents` with Node integration disabled, context isolation enabled, navigation/window creation denied, a restrictive CSP, and network requests blocked. Electron explicitly advises against processing untrusted content in an unsandboxed process and recommends disabling Node integration with context isolation for untrusted content ([security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)).

Local linked assets must be resolved through an allowlisted, read-only custom protocol scoped to the Artifact Version. Do not permit arbitrary `file:` access. A blocked or missing asset is shown as unavailable; it is not fetched from the network.

Parsing and stringifying can normalize whitespace, quoting, implied elements, and attribute order. Therefore:

- a read-only preview never rewrites source;
- source-mode edits use text ranges where possible;
- structural edits create a new Artifact Version and show both source and AST-level differences;
- a render diff is renderer-specific and does not prove source equivalence.

## Comparison Model

Comparison should emit typed changes with source locations and confidence, then let Artifact Review combine them.

### Normalized structures

| Format | Stable comparison units | Important caveats |
| --- | --- | --- |
| DOCX | Sections, block sequence, paragraphs, list identity, normalized runs, tables/cells, headers/footers, notes/comments, style references, media hashes | Run boundaries are not semantic; fields, tracked revisions, text boxes, and alternate content need explicit handling |
| XLSX | Sheet identity/order, cells by address, value/type/formula/cached result, styles, dimensions, merges, names, tables, comments, drawing/chart relationships | Formula results may be stale; sheet renames and moved ranges need identity heuristics |
| PPTX | Slide identity/order, shape non-visual IDs, placeholders, text, geometry, media hashes, notes, master/layout/theme relationships | Copy/paste can regenerate IDs; grouping, SmartArt, animation, and theme inheritance complicate matching |
| PDF | Page identity/order, page boxes/rotation, normalized text items and geometry, annotation/attachment inventory, raster page | Reading order is heuristic; raster equality depends on renderer, fonts, DPI, color management, and antialiasing |
| MD | Source lines plus mdast nodes and positions | Formatting-only source changes may be AST-equivalent |
| HTML | Source lines plus sanitized HAST nodes and selected computed render facts | Parser normalization and CSS cascade mean AST and visual changes are different signals |

Use jsdiff's token/array APIs for text and normalized-node sequences ([official repository](https://github.com/kpdecker/jsdiff/tree/c207c49728038d385f11a61b7c120785074088a1)). Use pixelmatch only on equal-size rasters from the same pinned renderer, DPI, font inventory, and color settings; its API is a pixel-level image comparison, not a document-semantics engine ([official repository](https://github.com/mapbox/pixelmatch/tree/c6fee35afac3c52576b2cb424bd1061ab6a4bd06)).

### User-facing comparison classes

- **Content change:** inserted/deleted/replaced text, cell value/formula, slide object, image, annotation, or page.
- **Structure change:** style, order, geometry, page settings, merge, relationship, metadata, or format feature.
- **Visual change:** renderer-specific pixel region changed.
- **Unresolved:** the normalizer could not match identities or interpret a feature safely.

An unresolved feature is not "unchanged." It remains visible as an inspection requirement.

## Source-File Protection And Hostile Inputs

The runtime must enforce these rules independently of Agent prompts:

1. **Identify by content and package inventory.** Extension and MIME are hints. OOXML must be an admissible OPC package with the expected main-part content type. PDF must have a valid header and parse under configured limits.
2. **Reject exclusions before conversion.** V1 rejects password/encrypted Office and PDF files and macro-enabled or macro-containing Office packages. OOXML encryption wraps the ECMA-376 package in an `EncryptedPackage` stream described by Microsoft's MS-OFFCRYPTO specification ([EncryptedPackage](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/b60c8b35-2db2-4409-8710-59d88a793f83)). Never try passwords or use an "ignore encryption" switch.
3. **Inventory active content.** Reject VBA projects regardless of extension; do not execute macros, DDE, OLE actions, external data connections, PDF JavaScript, launch actions, or HTML scripts. External relationships are preserved as inert metadata unless an explicit future policy says otherwise.
4. **Bound decompression and parsing.** Enforce compressed size, uncompressed total, entry count, per-entry size, XML depth/text size, page count, pixel count, and operation deadline before large allocations. Reject traversal paths and duplicate/conflicting ZIP entries.
5. **Hash before read.** Record the source path/file identity, byte length, modification metadata, and SHA-256 used by the editable read.
6. **Work on a private copy.** Parsers and converters never receive a writable handle to the source. Temporary data stays local, uses restrictive permissions, and is cleaned after every terminal state.
7. **Publish a new Artifact Version.** Write to a temporary file in the destination volume, close and validate it, render it where required, fsync as supported, recheck the source hash, then atomically rename the new version. A conflict stops publication.
8. **Prove non-mutation.** After every job, re-hash the original and verify its length and modification metadata are unchanged. Never use Office "save in place" as a conversion shortcut.
9. **Treat signatures explicitly.** Signed Office/PDF inputs may be viewed and compared, but any derived revision is a new, unsigned Artifact Version. Do not claim signature preservation or validity after transformation.
10. **Keep diagnostics bounded.** Logs contain operation IDs, versions, timings, exit codes, and sanitized error categories, not extracted document text or raw paths unless the Member requests a diagnostic bundle.

## Packaging And Operations

| Component | Windows x64 | macOS Apple Silicon | Packaging notes |
| --- | --- | --- | --- |
| Electron/Node | Native app target | Native app target | Pin Electron security updates; render untrusted content only in sandboxed processes |
| .NET 10 OOXML worker | Self-contained `win-x64` | Self-contained `osx-arm64` | Ship beside app resources, not ASAR; sign/notarize; protocol handshake reports exact build and SDK versions |
| LibreOffice runtime pack | Pinned x64 directory/install image | Pinned Apple silicon app bundle | Large optional/managed pack; exact filters, fonts, profile seed, licenses, and hashes are part of acceptance |
| PDF.js/Tesseract.js | JS/WASM | JS/WASM | Bundle workers, CMaps, standard fonts, WASM core, and language models locally; no CDN fallback |
| qpdf | ScopeGuard-built x64 executable and required DLLs | ScopeGuard-built arm64 executable and libraries | Build from one pinned source tag; disable unused crypto/features where allowed; sign and hash all binaries |
| unified/remark/rehype | ESM packages | ESM packages | Main/utility process only; sanitized projection crosses into review renderer |

Native executables and worker assets must be included through unpacked application resources. CI produces separate Windows and macOS artifacts from locked source/dependency versions and emits an SBOM plus license/NOTICE bundle. The application must verify the runtime-pack manifest before first use and refuse mixed or unknown component versions.

Operational requirements:

- clean offline startup and processing after installation;
- Unicode, spaces, long paths, read-only folders, and Workspace paths on different volumes;
- bounded queueing and cancellation with no orphan `soffice`, .NET, qpdf, or OCR process;
- crash recovery that removes stale profiles/jobs without deleting source or published Artifact Versions;
- no dependency on Microsoft Office, Java, Python, Homebrew, or a system-installed .NET runtime;
- no automatic runtime-pack update in V1, consistent with the manually installed Windows package decision.

## Alternatives Considered

| Candidate | Evidence | Decision |
| --- | --- | --- |
| Format-specific Node libraries (`docx`, ExcelJS/SheetJS, PptxGenJS) | Useful generation/data APIs, but no one maintained library reads, narrowly revises, and preserves all three existing OOXML formats. PptxGenJS is a generator; spreadsheet libraries do not solve Word/PowerPoint; none supplies Office layout. | Keep available only as isolated generation accelerators if a future template use case proves they preserve the required package. Do not make them the document core. |
| Apache POI | Actively released, Apache-2.0, with XWPF/XSSF/XSLF support for DOCX/XLSX/PPTX ([component map](https://poi.apache.org/components/index.html), [releases](https://poi.apache.org/download.html), [license](https://poi.apache.org/legal.html)). It also has a partial Excel formula evaluator, not Excel itself ([formula evaluation](https://poi.apache.org/components/spreadsheet/eval.html)). | Technically viable structure alternative, but adds a JVM and larger transitive/runtime surface without removing LibreOffice or fidelity testing. Prefer .NET/Open XML SDK because it follows the Microsoft OOXML model directly and packages as a self-contained worker. |
| LibreOffice UNO as the editing API | Broad application model and file filters. | Do not use for structural edits. It would couple every read/write to a heavyweight application process and could normalize untouched content. Restrict LibreOffice to derivative rendering/export on copies. |
| Microsoft Office COM/VBA automation | Word exposes native compare operations such as `CompareDocuments` ([Word API](https://learn.microsoft.com/en-us/office/vba/api/word.application.comparedocuments)), but Office must be installed and the path is Windows-only. Microsoft does not support unattended, non-interactive Office automation because it can deadlock or behave unstably ([Microsoft support statement](https://support.microsoft.com/en-us/visio/considerations-for-server-side-automation-of-office)). | Not a background runtime. "Open in Word/Excel/PowerPoint" is a Member-mediated fallback. The prototype may use interactive Office export as the reference oracle, not as the shipped engine. |
| Poppler | Mature renderer/text/raster utilities, but GPL licensing and ScopeGuard-owned Windows builds. | Prototype/debug oracle only unless a later legal and packaging decision approves it. |
| Aspose.Words/Cells/Slides for .NET | Vendor-documented independent create/modify/render/convert engines; Slides documents Windows and macOS ARM64 support and font dependencies ([Slides requirements](https://docs.aspose.com/slides/net/system-requirements/)). Distribution requires a commercial license type matching the product ([license types](https://purchase.aspose.com/policies/license-types)). | Paid fallback candidate if LibreOffice fails mandatory fixtures. Run the same Windows corpus; do not accept vendor fidelity language as evidence. Procurement, redistribution rights, three-product behavior, and macOS parity must be approved first. |
| Cloud conversion APIs | Could shift rendering complexity to a service. | Rejected for V1 because raw Workspace content must remain local and no always-online document path is accepted. |

## License And Maintenance Snapshot

This table is an engineering inventory, not legal advice. Verify transitive dependencies and exact release artifacts before distribution.

| Component | License/source status at snapshot | Required action |
| --- | --- | --- |
| Open XML SDK 3.5.1 | MIT; active official Microsoft/.NET Foundation repository and March 2026 release | Pin NuGet package and notices |
| LibreOffice | MPL 2.0/LGPL and a binary distribution containing additional licensed components | Legal review of exact runtime pack; ship notices and required source/compliance materials |
| PDF.js | Apache-2.0; active Mozilla repository | Bundle license plus required CMap/font notices |
| qpdf | Apache-2.0 repository; active releases | Build from pinned tag; ship license/NOTICE and dependency notices |
| Tesseract.js / Tesseract / `tessdata_fast` | Apache-2.0; active official repositories | Pin WASM/core/models; include model license and hashes |
| unified/remark/rehype/parse5 | MIT; active maintained repositories | Lock all ESM package versions and transitive licenses |
| jsdiff | BSD-3-Clause; active repository | Include license |
| pixelmatch | ISC; active repository | Include license |
| Poppler, if used outside development | GPL-2.0-or-later source interfaces and mixed component history | Separate legal decision before any distribution |
| Aspose, if selected | Proprietary commercial license | Procurement and redistribution approval before prototype output enters product |

## Recommended V1 Stack

**Ship by default**

- Electron's current supported release line, pinned and serviced for security.
- .NET 10 LTS self-contained OOXML worker.
- `DocumentFormat.OpenXml` 3.5.1.
- PDF.js (`pdfjs-dist`) pinned to the release accepted by the fixture corpus.
- qpdf pinned to the source tag accepted by the fixture corpus.
- Tesseract.js 7.x with pinned local WASM core and `tessdata_fast` `eng` + `chi_sim`.
- unified 11.x, remark/rehype parse/stringify packages, `remark-gfm`, `rehype-sanitize`, and parse5 through the locked HTML stack.
- jsdiff and pixelmatch for typed text/raster comparison primitives.

**Ship as the managed Document Runtime Pack**

- One exact LibreOffice Windows x64 build and one exact Apple silicon build.
- Runtime profile seed with macro security at `Very High`, no trusted locations, and external link updates disabled.
- A tested font manifest. Do not redistribute proprietary Microsoft fonts without rights; record whether a fixture used an installed font, an approved bundled font, or substitution.

**Do not ship in the baseline**

- Microsoft Office automation, Java/JVM, Python, system package managers, Poppler, native Tesseract, `pdf-lib`, or a commercial Office renderer.

## Fallback Paths

1. **OOXML structure unsupported:** preserve the original, produce an explicit partial structural projection, disable revision for the unresolved feature, and offer Member-mediated opening in Office/LibreOffice.
2. **LibreOffice missing:** provide the structural/data/outline projection with a visible "layout preview unavailable" state. Do not render ad hoc HTML and label it as the document.
3. **LibreOffice fails an accepted fixture:** block that format/feature from V1 export. Evaluate Aspose with the same corpus or require external Office. Do not lower the fixture gate silently.
4. **PDF.js cannot render a PDF:** preserve and inventory the source, show an unsupported-render state, and offer external viewing. Use Poppler only in diagnosis unless separately approved for distribution.
5. **Tesseract.js misses resource gates:** substitute the native Tesseract worker with the same output schema and local models. If accuracy fails, mark OCR unavailable; do not promote low-confidence text as authoritative.
6. **Requested revision is outside an allowlist:** generate a proposed change description or derivative content, then require manual editing in the source application. Never attempt a broad package rewrite.
7. **Validation, Office reopen, conflict, or post-write render fails:** keep the source and prior Artifact Version, discard/quarantine the candidate, and return a typed failure with no partial publication.

## Fixture Matrix

Synthetic fixtures are useful for isolation but insufficient. The Windows prototype must include sanitized, representative company documents with known authorship and expected behavior.

| Format | Minimum fixture classes | Required observations |
| --- | --- | --- |
| DOCX | Mixed Chinese/English fonts; headings/lists; nested tables; images; headers/footers; multiple sections/orientations; page breaks; fields/TOC; footnotes/endnotes; comments and tracked revisions; text boxes; chart/SmartArt; embedded object; custom XML; external link; signed; macro-containing; encrypted; large document | Structural extraction, untouched-part preservation, Word reopen without repair, LibreOffice vs Word pagination/layout, missing-font behavior, diff localization, exclusion handling |
| XLSX | Typed values; dates/time zones; number formats; formulas and cached results; merged cells; hidden rows/columns/sheets; freeze panes; names; tables; validation; comments; conditional formatting; charts/images; pivot/slicer; external workbook link/data connection; signed; macro-containing; encrypted; large sparse and dense workbooks | Cell/formula/style diff, recalculation behavior in Excel and LibreOffice, print area/page breaks, chart/layout differences, memory bounds, exclusion handling |
| PPTX | Theme/master/layout inheritance; Chinese/English typography; placeholders; grouped shapes; images/SVG; tables; charts; SmartArt; notes/comments; transitions/animations; audio/video; embedded object; custom fonts; signed; macro-containing; encrypted; large deck | Shape/slide matching, untouched relationship preservation, PowerPoint reopen, static slide render against PowerPoint PDF, missing-font and media behavior, exclusion handling |
| PDF | Born-digital tagged and untagged; multi-column; forms; annotations; attachments; outlines; mixed page sizes/rotations; embedded/subset/missing fonts; transparency; image-only English; image-only Chinese; mixed text/image; malformed but recoverable; signed; JavaScript/launch action; remote link; encrypted; large page count | PDF.js render/text behavior, qpdf page-operation losses, OCR accuracy/boxes, action suppression, visual diff stability, rejection and recovery |
| MD | CommonMark; enabled GFM tables/task lists/footnotes; Chinese/English; code; local images; raw HTML; script/event payloads; remote assets; CRLF/LF; very long lines and large file | AST/source round trip, sanitizer behavior, local-asset scope, print CSS, source and render diff |
| HTML | Standards and malformed HTML; print CSS; page-break rules; local CSS/images/fonts; SVG; tables; Chinese/English; script/iframe/object/form; `javascript:` URL; remote resource canary; DOM-clobbering names; large DOM | parse/stringify normalization, active-content removal, zero network, sandbox behavior, deterministic Chromium PDF and render diff |

Run the full acceptance corpus on Windows 10 and Windows 11 x64 with the exact Microsoft 365 desktop build used as the Office reference recorded in the test manifest. Run structure, packaging, and smoke rendering on at least one supported Apple silicon macOS version. macOS success cannot waive a Windows failure.

## Prototype Acceptance Tests

Issue #8 should implement these tests before issue #9 fixes the final release boundary.

### 1. Admission and exclusions

- Every valid fixture is identified by content, not extension alone.
- Renamed macro-containing OOXML, `.docm`/`.xlsm`/`.pptm`, encrypted OOXML, and encrypted PDF are rejected before any converter starts.
- Signed unencrypted documents are admitted read-only; revision creates a clearly unsigned derivative and never overwrites the signed input.
- Oversize, excessive-entry, high-expansion, deep-XML, and excessive-pixel fixtures hit configured limits with typed errors rather than process crashes. Issue #9 will set final numeric limits from prototype measurements.

### 2. Source protection and conflict behavior

- SHA-256, length, modification metadata, and bytes of every source fixture are unchanged after read, render, OCR, compare, export, cancellation, timeout, worker crash, and app crash recovery.
- All successful edits publish a new Artifact Version through temporary-write plus atomic rename.
- Mutating the source after editable read but before publication produces a conflict and no overwrite.
- Read-only directories, locked files, Unicode/spaces/long paths, symlinks/reparse points, and different-volume destinations fail or succeed according to a recorded policy without escaping the Workspace boundary.

### 3. OOXML structural round trip

- Each allowlisted operation changes only the intended normalized units and package parts. All unrelated parts and relationships remain byte-identical where the implementation claims preservation; otherwise every normalization is enumerated in the test expectation.
- `OpenXmlValidator` reports no new errors.
- Word, Excel, or PowerPoint opens the candidate on Windows without a repair, conversion, trust, or unexpected link-update dialog.
- Saving the candidate once in the corresponding Office application and reopening it produces no newly introduced corruption warning.
- Unsupported features remain present and usable, or the operation is removed from V1.

### 4. Office rendering and export

- For each mandatory visual fixture, export source and revised files to PDF with the pinned LibreOffice runtime and interactively with the recorded Microsoft Office build.
- Human review plus page/slide/sheet-range and raster diagnostics find no lost content, clipped text, unexpected pagination, substituted required font, displaced table/chart/image, formula error, or blank page in a class accepted for V1.
- Renderer differences outside an approved tolerance/mask remain documented per fixture. There is no global "high fidelity" pass based only on a pixel percentage.
- An unaccepted feature class is visibly unsupported or delegated to external Office; it is not included with a warning-only fidelity promise.
- Repeated LibreOffice runs with the same binary, profile seed, fonts, and fixture produce stable page count and stable raster output within the fixture tolerance.

### 5. Comparison

- Seeded text, style, formula, value, shape, image, page-order, metadata, and layout changes appear in the correct typed class and location.
- Formatting-only, relationship-only, and visual-only changes are not collapsed into "no change."
- Unknown/ambiguous identity matches are reported as unresolved, not unchanged.
- Raster diff uses the same renderer, DPI, dimensions, fonts, and color settings for both versions; renderer metadata is stored with the result.
- Large diffs respect a deadline and memory bound and return a partial/unavailable state rather than an incomplete result presented as complete.

### 6. PDF operations

- PDF.js opens and renders every accepted PDF fixture without executing actions or making network requests.
- qpdf select/reorder/rotate/merge/overlay operations preserve the fixture features claimed by the operation contract. Forms, outlines, tags, annotations, attachments, and signatures are checked explicitly; any loss narrows the contract.
- Generated Chromium and LibreOffice PDFs reopen in both PDF.js and the Windows reference viewer, have the expected page geometry, and contain no blank or clipped required content.
- PDF text edits, redaction assurance, signature preservation, PDF/A, and PDF/UA are demonstrably absent from the V1 UI/API.

### 7. OCR

- PDF.js native text extraction wins over OCR when usable text exists.
- On ground-truthed, clean 300-DPI printed fixtures, character accuracy is at least 98% for English and 95% for simplified Chinese; lower-quality fixtures have separately approved thresholds and remain labeled with confidence.
- Word/line boxes map back to the correct source page within the fixture tolerance after rotation.
- OCR makes no network request, reuses workers across pages, cancels promptly, and does not leak page images or text after cleanup.
- Handwriting and table reconstruction fixtures are reported unsupported rather than returned as reliable structured data.

### 8. HTML/Markdown isolation

- Script, event-handler, iframe, object/embed, form submission, `javascript:` URL, external stylesheet/font/image, navigation, pop-up, and DOM-clobbering fixtures cannot execute privileged code or access arbitrary files.
- A canary HTTP server records zero requests during Office, PDF, Markdown, and HTML processing.
- The renderer has `nodeIntegration: false`, `contextIsolation: true`, sandboxing enabled, a restrictive CSP, denied window creation/navigation, and an allowlisted Artifact asset protocol.
- Preview does not alter the source; a structural rewrite produces a new Artifact Version and an inspectable source diff.

### 9. Packaging, lifecycle, and offline operation

- A clean Windows 10 x64 and Windows 11 x64 machine can install the app plus runtime pack and complete the corpus offline without Microsoft Office, Java, Python, .NET, LibreOffice, Poppler, Tesseract, or package managers preinstalled. Microsoft Office is installed only on the separate reference machine used for fidelity comparison.
- A clean supported Apple silicon macOS machine completes the secondary-support smoke corpus with signed/notarized workers.
- Runtime manifest tampering, missing DLL/assets/models, mixed versions, and quarantine/signature failures produce a typed unavailable state before a document is opened.
- Cancellation and forced worker termination leave no child process, locked source, partial Artifact Version, profile lock, or undeleted sensitive job directory.
- The build emits exact component versions/hashes, SBOM, licenses/notices, and the accepted fixture-manifest version.

## Final Recommendation

Proceed to the Windows round-trip prototype with the split stack above. The structural core is Open XML SDK in a .NET 10 worker; LibreOffice is a derivative Office renderer/exporter only; PDF.js and qpdf divide PDF display from page-level transformation; Tesseract.js owns bounded OCR; unified/remark/rehype own Markdown and static HTML; and all comparisons combine typed normalized structure with renderer-specific raster evidence.

Do not approve V1 Office visual fidelity, formula fidelity, or broad structural editing from documentation alone. The mandatory decision point is the real-fixture Windows corpus: if LibreOffice and narrow Open XML revisions pass the acceptance tests, ship the managed runtime pack; if a mandatory class fails, either narrow the V1 operation, delegate it to external Office, or run the same corpus against a commercially licensed renderer before changing the stack.
