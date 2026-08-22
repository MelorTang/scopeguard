# Phase 4 DOCX fixtures

These files are fixed binary inputs for the Artifact Review Pilot. They verify
that an Agent-created output can be captured with exact input and output
identities, revised from the prior output, reopened, and exported without
introducing a ScopeGuard-owned document runtime.

Both fixtures come from the Open XML SDK repository at commit
`cd2b359ef824737edb93f1c6157c19551aae1e52`:

- `source-v1.docx`: `test/DocumentFormat.OpenXml.Tests.Assets/TestFiles/wordprocessing/complexDocx/complexity.docx`
- `source-v2.docx`: `test/DocumentFormat.OpenXml.Tests.Assets/TestFiles/wordprocessing/revision/revision.docx`

They are redistributed under the MIT license copied in
`OPEN_XML_SDK_LICENSE.txt`. They are Phase 4 test data only; no code or runtime
from the historical document-runtime prototype is part of the product route.
