# Configure Providers explicitly

Status: Superseded by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard V1 will support explicitly configured OpenAI Responses, OpenAI Chat
Completions, and Anthropic Messages Providers. An Administrator supplies the
Provider name, base URL, server-held API key, protocol, and manually curated
Model IDs, display names, and context limits, then verifies the connection.
ScopeGuard will not infer a protocol from a URL, discover arbitrary Models,
support personal OAuth accounts, automatically route or fail over between
Providers, or expose Provider credentials to the Desktop. Agent Templates may
allow multiple Models, and a Conversation may switch among those Models without
changing its bound Agent.
