# ScopeGuard

ScopeGuard is a privately deployable, multi-provider workspace where company
Members delegate knowledge work to governed AI Agents while retaining control
over context, data boundaries, and side effects.

## Language

**Organization**:
The company boundary within which people, Agents, knowledge, Models, and
governance are administered.
_Avoid_: Tenant, account, customer

**Administrator**:
A person who governs an Organization's Models, enterprise knowledge connection,
Agent Templates, and access policies.
_Avoid_: Owner, superuser

**Member**:
A person who performs knowledge work inside an Organization through private
Workspaces governed by that Organization.
_Avoid_: End user, seat, account

**Workspace**:
A Member-owned boundary that groups related Agents, Tasks, conversations,
context, and Artifacts. Its contents are private unless explicitly shared.
_Avoid_: Project, team room, shared chat

**Organization Knowledge**:
Company-managed information exposed by a separately operated enterprise
knowledge service and retrievable only through the requesting Member's effective
access. V1 gives every Member the same access.
_Avoid_: Global memory, shared transcript, unrestricted knowledge base

**Knowledge Collection**:
A logical group of Organization Knowledge documents managed by the enterprise
knowledge service. Access follows the requesting Member, never the selected
Agent.
_Avoid_: Agent knowledge, Workspace File, permission role

**Workspace Context**:
Versioned background, constraints, summaries, and Artifact references explicitly
accepted for reuse across Conversations in one Workspace.
_Avoid_: Workspace memory, implicit chat history

**Workspace File**:
A file explicitly added to or created inside a Workspace and available for
selection by any Conversation in that Workspace.
_Avoid_: Conversation Attachment, Organization Knowledge, implicit local file

**Workspace Terminal**:
An unmanaged, Member-operated local shell opened at a Workspace root for direct
use of command-line tools. It is not a Conversation, Agent, or Harness.
_Avoid_: Agent tool, managed CLI Agent, Conversation console

**Agent**:
A Member-specific instance of an Agent Template, permanently carrying that
template's bounded role and authority while allowing permitted personalization.
_Avoid_: Bot, model, persona

**Agent Template**:
An Administrator-published definition of an Agent's role, instructions,
tools, supported Models, and Agent Policy.
_Avoid_: Prompt preset, Agent instance, model profile

**Model**:
An AI inference engine available to an Agent under Organization policy. Changing
the Model does not change the Agent's identity, authority, or context.
_Avoid_: Agent, provider, assistant

**Provider**:
An Organization-approved service endpoint that makes one or more Models
available for Agent execution through an explicitly configured protocol.
_Avoid_: Model, Agent, relay

**MCP Connection**:
A configured MCP endpoint that exposes bounded tools or knowledge to a
Conversation. Enterprise knowledge connections are Organization-managed;
personal and Workspace connections are Member-managed local extensions.
_Avoid_: Provider, Skill, unrestricted integration

**Agent Policy**:
The Organization-controlled boundary defining which Models, tools, and side
effects an Agent may use.
_Avoid_: Prompt, role description, model settings

**Conversation Execution Profile**:
The Member-selected local permission mode that governs how one Conversation may
read or change Workspace and computer resources, execute commands or Skills, and
access the network. It may change without changing the bound Agent.
_Avoid_: Agent Policy, Skill permission, operating-system account

**Managed Execution Sandbox**:
The operating-system-enforced process boundary used for every Agent-triggered
executable, command, script, executable Skill, or local stdio MCP process in
Request Approval and Auto Approve. It is shared infrastructure whose policy is
selected by the Conversation Execution Profile, not a property of an Agent.
_Avoid_: Approval policy, Electron renderer sandbox, Workspace Terminal

**Skill**:
A reusable package of instructions, assets, templates, or executable workflows
available at built-in, Organization, Member, or Workspace scope. A Skill
inherits the Conversation Execution Profile and cannot grant itself additional
authority.
_Avoid_: Agent, Tool, permission profile, prompt fragment

**Conversation**:
A durable, task-oriented interaction history created inside a Workspace and
permanently bound to one Agent. It may switch among Models supported by that
Agent and may be resumed after its primary objective is completed.
_Avoid_: Agent, permanent chat, model session

**Conversation Transcript**:
The complete, durable record of messages and tool activity in one Conversation.
It is not automatically shared with other Conversations.
_Avoid_: Active context, Workspace Context, memory

**Conversation Attachment**:
A file supplied to one Conversation and unavailable to other Conversations
unless a Member explicitly promotes it to a Workspace File.
_Avoid_: Workspace File, shared upload, Organization Knowledge

**Active Context Projection**:
The bounded set of instructions, selected knowledge, Workspace Context,
summaries, and recent Conversation content sent to a Model for one Run.
_Avoid_: Conversation Transcript, long-term memory, deletion result

**Task**:
The primary work objective pursued through a Conversation.
_Avoid_: Prompt, message, run, separate chat container

**Artifact**:
A durable, traceable work product produced by an Agent for a Task. Revisions
create new Artifact Versions instead of silently replacing source files.
_Avoid_: Response, attachment, output blob

**Artifact Version**:
An immutable revision of an Artifact that identifies the exact input or output
used by a Conversation or Handoff.
_Avoid_: Autosave, overwritten file, Conversation message

**Manual Delivery**:
A Member-mediated transfer of selected input into a Workspace or of an Artifact
from a Workspace to an external business system.
_Avoid_: Integration, automatic synchronization, Agent Handoff

**Handoff**:
An explicit transfer of a bounded Task package from one Conversation to another
for continued work, performed either manually with a Handoff Prompt or
automatically with an Agent Dispatch.
_Avoid_: Shared memory, transcript sharing, input-box drag and drop

**Handoff Prompt**:
A portable plain-text Task package generated inside a Conversation and rendered
in a copyable prompt block for a Member to paste into another Conversation or
external Agent.
_Avoid_: Handoff draft, shared transcript, hidden context

**Agent Dispatch**:
An internal Agent action that sends an attributed Task package and explicitly
selected file or Artifact references directly to another Conversation in the
same Workspace and starts its bound Agent.
_Avoid_: Automatic routing, Agent replacement, unrestricted delegation
