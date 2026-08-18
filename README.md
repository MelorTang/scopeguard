# ScopeGuard

ScopeGuard is a personal-first desktop workbench for using multiple AI Agents
on one local Workspace. It is designed for both programming and general office
work without turning every workflow into a developer tool.

The center workbench keeps one to four Conversations visible and running in
parallel. Each Conversation is permanently bound to a user-configured Agent.
Users coordinate work explicitly by copying a Handoff prompt or dispatching a
bounded request to another existing Conversation.

## Project Status

The product contract was reset on 2026-08-18. [ADR 0024](./docs/adr/0024-adopt-a-personal-first-pi-rpc-workbench.md)
defines the product boundary, and [ADR 0025](./docs/adr/0025-adopt-pi-rpc-with-an-extension-approval-bridge.md)
accepts pinned Pi RPC with a controlled approval extension. The Phase 2
candidate replaces the active Native Harness composition with
`@earendil-works/pi-coding-agent@0.84.2` and a fresh personal schema; its final
decision is pending review in [ADR 0026](./docs/adr/0026-replace-the-native-harness-with-pi-runtime.md).

The retired enterprise route remains recoverable at:

- branch `codex/archive-enterprise-v1-2026-08-18`
- tag `enterprise-v1-checkpoint-2026-08-18`

## V1 Product Boundary

- Local Desktop application; the WebUI is a development preview only.
- User-created Workspaces backed by optional local directories.
- User-configured Agents: role, instructions, Model, Tools, and Skills.
- Persistent Conversations with one to four visible at once.
- Manual Handoff prompts and explicit Agent Dispatch; no automatic routing.
- Durable Artifacts and an Office Tool Pack for DOCX, XLSX, PPTX, and PDF.
- Pi RPC for the Agent loop, Providers, runtime Tools, sessions, and compaction.
- Optional external MCP integrations later; enterprise RAG is a separate system.

Organization administration, Agent Templates, an enterprise control plane,
automatic multi-Agent orchestration, cloud Workspace synchronization, and old
development-database migration are not V1 goals.

## Ownership

| ScopeGuard owns | Pi Runtime owns |
| --- | --- |
| Desktop workbench and interaction | Agent loop and streaming |
| Workspace and Agent configuration | Provider protocol execution |
| Conversation-to-session mapping | Runtime Tool behavior |
| Local metadata, Artifacts, Dispatch | Session resume and compaction |
| Office Tool Pack | Runtime event production |

## Development

Requirements: Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm qualify:pi-rpc
pnpm pilot:pi-runtime
pnpm pilot:pi-runtime:staged
pnpm dev:web
pnpm dev
```

`pilot:pi-runtime` runs a disposable Desktop host, deterministic Provider, real
pinned Pi RPC, full host restart, opaque Session resume, and a continued second
turn. The staged variant repeats that proof against the packaged Runtime tree.
Acceptance gates are defined in [VERIFICATION.md](./docs/VERIFICATION.md).

## Documentation

- [Domain glossary](./CONTEXT.md)
- [Target architecture](./docs/V2_ARCHITECTURE.md)
- [Verification and phase gates](./docs/VERIFICATION.md)
- [Architecture decisions](./docs/adr/)
- [Historical research snapshots](./docs/research/)

Current source of truth is, in order: accepted ADRs and `CONTEXT.md`, the active
GitHub Wayfinder map, current architecture and verification documents, then
implementation. Historical research explains prior decisions but is not a
current product requirement.
