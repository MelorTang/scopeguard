# Vendor selected Pi runtime source

ScopeGuard will vendor a pinned snapshot of selected MIT-licensed Pi source for
Provider protocol handling, streaming, tool-call normalization, and the minimal
Agent loop. ScopeGuard will expose this code only through its own runtime
interfaces and will continue to own Workspace, Conversation, context projection,
RAG, permissions, document tools, Artifacts, and persistence. Pi's CLI, TUI,
session and memory models, coding tools, unrestricted filesystem or shell tools,
OAuth flows, and application configuration will not be imported. The vendored
code must retain its license and upstream revision, isolate local patches, and
pass ScopeGuard-owned Provider contract tests before an upstream update is
accepted.
