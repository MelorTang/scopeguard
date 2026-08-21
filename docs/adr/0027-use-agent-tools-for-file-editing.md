# Use Agent Tools and Skills for file editing

Status: Accepted on 2026-08-21. Partially supersedes the Office Tool Pack
clauses in [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md).

ScopeGuard will not implement or ship a format-specific Office editor,
Document Runtime, or uniform DOCX/XLSX/PPTX/PDF operation layer. Agents inspect,
create, and revise ordinary Workspace Files through the same available Tools,
selected Skills, scripts, libraries, and mature external applications they use
for other file work. Each workflow must report its actual toolchain and limits;
ScopeGuard does not turn one successful workflow into a product-wide format
guarantee.

ScopeGuard owns the Artifact lifecycle around those edits: immutable Artifact
Versions, declared Workspace input identity, source and output identity,
provenance, conflict detection, durable failure/effect certainty, Artifact
Review, and opening or exporting the selected result. It may display previews
already available through the Desktop or the selected workflow, but preview
fidelity and Office-format semantics are not a ScopeGuard editing engine.

Phase 4 may use format libraries in a test-only Agent workflow to prove the
lifecycle end to end. Those libraries are development evidence, not product
Runtime dependencies, and package verification must reject them if they enter
the staged application.

Historical document-runtime research remains a snapshot rather than Phase 4
implementation input. A custom format operation may be reconsidered only after
real Agent workflows repeatedly fail and a separate decision proves that owning
the operation is more valuable than using a mature Tool or Skill.
