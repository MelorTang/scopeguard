# Use task-oriented persistent Conversations

Status: Partially superseded. Only the ADR 0001 principle in [ADR 0024's amendment matrix](./0024-adopt-a-personal-first-pi-rpc-workbench.md#amendment-matrix) remains normative; all conflicting or additional clauses below are historical.

A Conversation is permanently bound to one Agent and organized around one
primary Task. It remains stored, resumable, and open to follow-up revisions, but
new objectives start new Conversations so unrelated transcripts do not become
implicit long-term memory. Workspace context, Artifacts, and explicit Handoffs
carry durable knowledge across Conversations. This keeps the user-facing model
simple and allows the existing separate Task and Thread concepts to be
consolidated during the enterprise-office redesign.
