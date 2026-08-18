# Use a Local Core and modular enterprise server

Status: Superseded by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard V1 will concentrate canonical local behavior in one supervised
Desktop Local Core process and deploy identity, Organization configuration,
Provider credentials, Model access, and Organization Knowledge access as one
private modular enterprise server. The Local Core is the only local SQLite
writer and owns Conversation and Run orchestration; Electron Main, Renderer,
workers, and terminals remain adapters or views.

Model inference will pass through a protocol-preserving server Model Gateway.
The Desktop's explicit Provider adapter constructs and parses OpenAI Responses,
OpenAI Chat Completions, or Anthropic Messages traffic; the server validates the
allowed Provider and Model, injects server-held routing and credentials, and
relays the stream without becoming a remote Agent Runtime or persisting prompt
content. This preserves the selected Pi-derived protocol kernel in the Native
Harness while keeping Provider secrets and Organization governance off the
Desktop.

V1 packages will be split only for domain ownership, process or trust
separation, cross-process contracts, native-binary integrations, or substantial
runtime seams. Application capabilities remain cohesive modules behind the
Local Core interface, concrete adapters depend inward on application ports, and
the Desktop and enterprise server remain separate composition roots. This
rejects both the current all-purpose application coordinator and a V1
microservice or package-per-use-case architecture.
