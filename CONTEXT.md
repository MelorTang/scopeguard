# ScopeGuard Domain Glossary

This file defines the current product vocabulary. Architecture and implementation
decisions belong in `docs/adr/`.

**User**:
The person using ScopeGuard and making the final decisions about Workspaces,
Agents, permissions, inputs, and outputs.

**Workspace**:
A user-created boundary for related local files, Agents, Conversations, and
Artifacts. A Workspace may point at a local directory.

**Workspace File**:
An ordinary mutable file inside a Workspace that Agents may inspect, create, or
revise through available Tools and Skills. A Workspace File is not an immutable
Artifact Version.

**Agent**:
A user-configured working identity composed of a role, instructions, available
Tools and Skills, and a selected Model. An Agent is not a person, account, or
permission authority.

**Conversation**:
A persistent interaction with one Agent inside one Workspace. A Conversation
keeps its own history and may be opened beside other Conversations. Its Agent
does not change after creation; its Model may change when the Agent supports the
replacement.

**Run**:
One active execution of an Agent in a Conversation, started by a User message or
an explicit Dispatch. A Conversation has at most one active Run.

**Dispatch**:
An explicit request sent from one Conversation to another existing Conversation
in the same Workspace. A Dispatch identifies its source and destination and does
not implicitly share either Conversation's full history. **Agent Dispatch** is
the user-visible name for this action; `Dispatch` is the canonical entity. The
two names do not identify separate concepts.

**Handoff**:
The broader act of transferring bounded work between Agents or Conversations.
It may be performed manually with a copyable prompt or automatically through a
Dispatch.

**Artifact**:
A durable work product produced, imported, or revised in a Workspace, such as a
document, spreadsheet, presentation, PDF, report, or code change. An Artifact
keeps its identity across captured versions and is distinct from transient chat
output.

**Artifact Version**:
An immutable captured revision of an Artifact with its source identity and
provenance. Editing a related Workspace File may produce a new Artifact Version
but never mutates an existing one.

**Artifact Review**:
The User's inspection of an Artifact and its versions before choosing how to
open, accept, or export a result. Artifact Review is not a document editor.

**Agent File Editing**:
An Agent's use of available Tools, Skills, and mature external toolchains to
inspect, create, or revise Workspace Files. The supported formats and operations
belong to the selected workflow, not to a ScopeGuard-owned Office editor.
_Avoid_: Office Tool Pack, built-in Office editor, Document Runtime

**Skill**:
A reusable package of instructions, scripts, and optional resources that helps
an Agent perform a class of work. Users may install and select Skills.

**Tool**:
A callable capability available to an Agent, such as reading a file, editing a
document, running an approved local operation, or invoking an external service.

**Tool Effect Certainty**:
The product's durable classification of what a Tool may have changed outside the
Agent loop. `effect_unknown` is the canonical terminal Tool-call status when
execution may have started but ScopeGuard has no trustworthy result or receipt
that proves whether the side effect was absent, complete, or partial. A Tool
error, abort, timeout, process exit, or lost host connection does not by itself
prove that no side effect occurred. `denied` or `cancelled` may mean no effect
only when ScopeGuard can prove the Tool was blocked before execution began.

**Model**:
The AI inference model selected for an Agent or Conversation.

**Provider**:
A service and protocol endpoint that makes one or more Models available.
