# ScopeGuard Domain Glossary

This file defines the current product vocabulary. Architecture and implementation
decisions belong in `docs/adr/`.

**User**:
The person using ScopeGuard and making the final decisions about Workspaces,
Agents, permissions, inputs, and outputs.

**Workspace**:
A user-created boundary for related local files, Agents, Conversations, and
Artifacts. A Workspace may point at a local directory.

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
document, spreadsheet, presentation, PDF, report, or code change. An Artifact is
distinct from transient chat output.

**Skill**:
A reusable package of instructions and optional resources that helps an Agent
perform a class of work. Users may install and select Skills.

**Tool**:
A callable capability available to an Agent, such as reading a file, editing a
document, running an approved local operation, or invoking an external service.

**Model**:
The AI inference model selected for an Agent or Conversation.

**Provider**:
A service and protocol endpoint that makes one or more Models available.
