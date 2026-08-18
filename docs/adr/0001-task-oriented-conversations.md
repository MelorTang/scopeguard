# Use task-oriented persistent Conversations

Status: Active in principle; amended by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

A Conversation is permanently bound to one Agent and organized around one
primary Task. It remains stored, resumable, and open to follow-up revisions, but
new objectives start new Conversations so unrelated transcripts do not become
implicit long-term memory. Workspace context, Artifacts, and explicit Handoffs
carry durable knowledge across Conversations. This keeps the user-facing model
simple and allows the existing separate Task and Thread concepts to be
consolidated during the enterprise-office redesign.
