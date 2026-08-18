# Separate durable history from active context

Status: Active in principle; amended by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard will keep Organization Knowledge, Workspace Context, Conversation
Transcripts, and Active Context Projections as distinct governed concepts. Full
Conversation history remains durable and searchable, while each Run receives a
bounded projection containing only selected knowledge, explicit Workspace
Context, summaries, and recent content. Compaction changes that projection but
does not delete source history. V1 will not create or inject autonomous
cross-Workspace Agent memory; personal preference memory is deferred until its
approval, provenance, retention, and deletion rules are designed.
