# Adopt a personal-first Pi RPC workbench

Status: Accepted on 2026-08-18.

The Office Tool Pack ownership and format-specific Tool Pack clauses are
superseded by [ADR 0027](./0027-use-agent-tools-for-file-editing.md). The rest of
this decision remains active.

Supersedes ADR 0002, 0004, 0005, 0006, 0009, 0012, 0013, 0014, 0017,
0018, 0019, 0020, 0022, and 0023. It amends the terminology and product
boundary of ADR 0001, 0003, 0008, 0010, 0011, 0015, and 0016, while preserving
their applicable principles. ADR 0007 and 0021 remain active.

## Amendment Matrix

For each partially superseded ADR below, exactly one principle remains
normative. The old ADR body remains unchanged as historical evidence, but every
role, term, implementation requirement, and additional policy not included in
the retained-principle column is non-normative for the new V1.

| ADR | Sole retained principle | Retired clauses |
| --- | --- | --- |
| 0001 | A Conversation is persistent and permanently bound to one Agent. | A required primary Task, the rule that every new objective must create a Conversation, the old Task/Thread consolidation rationale, and enterprise-office terminology. |
| 0003 | Durable Conversation history is not deleted by runtime compaction; compaction changes only the model-visible working context. | Organization Knowledge, governed Workspace Context and Active Context Projection as ScopeGuard-owned runtime abstractions, and the old memory-policy requirements. Pi owns session and compaction behavior under this ADR. |
| 0008 | Cross-Conversation coordination is explicit and bounded: the User either copies a Handoff prompt or sends a Dispatch to an existing Conversation without implicitly sharing the source history. | Member, Template authorization, Task packages, Conversation Attachment rules, per-action disclosure policy, and any claim that the old ScopeGuard runtime starts the target Agent. |
| 0010 | Windows 10/11 x64 remains the V1 release-acceptance platform, with macOS Apple Silicon as the development and secondary-support platform. | Member terminology and fixed packaging, profile-location, installation, or update mechanics that have not passed the new Phase 5 gate. |
| 0011 | Local Workspace files, Conversation access, and Artifacts remain usable when Model or external-service access is unavailable. | Mandatory enterprise login, Organization/Member identity binding, enterprise-server authentication, enterprise knowledge availability rules, and the old local-encryption design. Credential and identity behavior must be requalified for Pi RPC. |
| 0015 | Conversations share the live Workspace directory, and conflicting writes stop rather than silently overwrite a changed file. | Member terminology, the exact hash/temp-file algorithm, default Artifact Version behavior, and Git-worktree product commitments until revalidated under the new runtime. |
| 0016 | Skills use an open `SKILL.md`-rooted package that a User may install and select. | Organization/Member scopes and precedence, the old Conversation Execution Profile and Managed Execution Sandbox requirements, and unvalidated schema, update, signing, or marketplace policy. |

ADR 0007 and 0021 are reaffirmed without amendment. All ADRs listed as
superseded above are wholly historical and non-normative.

## Decision

ScopeGuard V1 is a personal-first, local desktop workbench for programming and
general office work. A User creates a Workspace, configures Agents, and keeps
one to four Conversations visible and running in parallel. Coordination is
explicit: the User may copy a bounded Handoff prompt or ask one Agent to
Dispatch work to another existing Conversation. ScopeGuard does not
automatically route work or silently share Conversation history.

Pi RPC is the preferred Agent Runtime boundary. ScopeGuard will integrate with
a pinned, qualified Pi RPC release instead of maintaining a second native Agent
loop or vendoring selected Pi source. The Phase 1 prototype must prove process
lifecycle, streaming, tool calls, interruption, session resume, and compaction
before the existing runtime is replaced. If a required contract cannot be
mapped reliably, ScopeGuard will expose that limitation rather than imitate a
uniform capability.

ScopeGuard owns the Desktop workbench and its interaction model, Workspace and
Agent configuration, Conversation-to-runtime-session mapping, local metadata,
Artifact lifecycle and review, explicit Dispatch records, and the Office Tool
Pack. Pi owns the Agent loop, Provider protocol execution, runtime Tool and
session behavior, and context compaction. ScopeGuard may project Pi events for
display and recovery, but it will not create a competing session or compaction
truth.

Office support is local and Artifact-oriented. The initial Tool Pack is limited
to DOCX, XLSX, PPTX, and PDF in addition to formats Models already handle well,
such as plain text, Markdown, and HTML. Enterprise knowledge bases and RAG are
separate products or services that may later be connected through MCP; they are
not part of ScopeGuard V1's core runtime.

The reset is a breaking refactor in this repository. There is no long-lived old
and new product track, no compatibility layer for the retired enterprise domain,
and no migration for old development databases because there is no production
user data. The pre-reset implementation remains recoverable through Git history,
the `codex/archive-enterprise-v1-2026-08-18` branch, and the
`enterprise-v1-checkpoint-2026-08-18` tag.

## Consequences

- Organization, Administrator, Member, Agent Template, Organization Knowledge,
  enterprise Agent Policy, Admin Console, and enterprise control-plane concepts
  are outside the new V1 domain.
- User-installed Skills and configurable Agents are first-class local product
  capabilities.
- Runtime permissions must be expressed honestly from Pi RPC's actual contract;
  the retired Native Harness and Managed Execution design is not a V1 gate.
- Existing useful UI, persistence, Office research, conflict-detection, and
  verification assets may be reused only after they are reconciled with this
  ownership boundary.
- Historical research and superseded ADR bodies remain in the repository as
  snapshots, not current requirements.
