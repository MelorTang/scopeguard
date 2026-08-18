# Separate durable history from active context

Status: Partially superseded. Only the ADR 0003 principle in [ADR 0024's amendment matrix](./0024-adopt-a-personal-first-pi-rpc-workbench.md#amendment-matrix) remains normative; all conflicting or additional clauses below are historical.

ScopeGuard will keep Organization Knowledge, Workspace Context, Conversation
Transcripts, and Active Context Projections as distinct governed concepts. Full
Conversation history remains durable and searchable, while each Run receives a
bounded projection containing only selected knowledge, explicit Workspace
Context, summaries, and recent content. Compaction changes that projection but
does not delete source history. V1 will not create or inject autonomous
cross-Workspace Agent memory; personal preference memory is deferred until its
approval, provenance, retention, and deletion rules are designed.
