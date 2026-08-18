# Separate the Admin Console from the Desktop

Status: Superseded by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard will provide the Member workbench only through the Desktop and host a
separate web Admin Console on the enterprise server. Administrators use the
Console to manage Members, Agent Templates, Providers and Models, Organization
Skills, and the enterprise knowledge MCP connection; the Desktop exposes only
the active Organization configuration and connection state. The Console has no
public registration path and is intended for company-controlled network access.
The renderer-only WebUI remains a development preview of the Desktop rather than
a supported Member product.
