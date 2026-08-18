# Support manual prompts and Agent Dispatch

Status: Partially superseded. Only the ADR 0008 principle in [ADR 0024's amendment matrix](./0024-adopt-a-personal-first-pi-rpc-workbench.md#amendment-matrix) remains normative; all conflicting or additional clauses below are historical.

ScopeGuard will support two explicit Handoff paths. For manual coordination, an
Agent can produce a structured Handoff Prompt rendered as a plain-text block
with a one-click copy action, allowing the Member to paste it into any visible
Conversation or external Agent. For automated coordination, a source Agent can
use a ScopeGuard-owned internal tool to send the same bounded Task package,
source attribution, and selected file or Artifact references directly to an
existing target Conversation in the same Workspace and start its bound Agent.
Agent Dispatch cannot create a Conversation, select or replace an Agent, or
cross a Workspace boundary. Neither path shares the source Conversation
Transcript, and automated dispatch does not manipulate or stage content in the
target input box. A Template-authorized Agent may dispatch without per-action
confirmation after a one-time disclosure; both Conversations show the dispatch
immediately and the Member can stop the target Run. Only Workspace Files and
explicitly selected Artifact Versions may travel with a dispatch, never a
Conversation Attachment.
