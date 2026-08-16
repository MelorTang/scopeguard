# Keep workspaces local and governance on the enterprise server

ScopeGuard will use a local-first hybrid architecture. The Desktop owns
Workspace Files, Conversation Transcripts, Artifact Versions, document
processing, and local file operations; the enterprise server owns Member
identity, Agent Templates, Provider configuration, and Provider credentials,
and proxies Model requests without permanently synchronizing raw Workspace
content. Each Run sends only its Active Context Projection through the server.
This keeps local document work and Provider secrets in their appropriate trust
boundaries, at the cost of deferring multi-device Workspace synchronization and
making always-on work unavailable when the Desktop is offline.
