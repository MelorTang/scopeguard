# Authorize knowledge by Member, not Agent

Status: Superseded by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

Organization Knowledge retrieval will be authorized against the logged-in
Member's effective access, never against the selected Agent or Agent Template.
V1 gives every Member access to all knowledge exposed by the configured
enterprise knowledge service, while preserving the Member-based boundary for
future access rules. Agent instructions may influence relevance or source
selection but cannot grant, revoke, or replace knowledge access; this prevents
changing Agents from changing a person's data authority and deliberately defers
department- and document-level permissions.
