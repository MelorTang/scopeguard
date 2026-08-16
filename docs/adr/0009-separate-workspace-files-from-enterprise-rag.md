# Separate local Workspace files from enterprise RAG

ScopeGuard will treat local Workspace access and enterprise knowledge retrieval
as separate capabilities. The Desktop will inspect Workspace Files on demand
through document-aware listing, search, structural reading, rendering, and
revision tools, using only local parse caches rather than a Workspace vector
index. A separately developed enterprise knowledge service will own ingestion,
parsing, indexing, RAG, and source management, and ScopeGuard will consume its
read-only retrieval capability through an Administrator-configured MCP
connection. ScopeGuard therefore owns the MCP client, Member authorization
boundary, result presentation, and Active Context Projection, but not the
enterprise RAG implementation. V1 uses one Organization-level read-only MCP
credential held only by the enterprise server, gives every Member the same
knowledge access, and requires retrieval results to include displayable source
titles and locations. The Member authorization boundary remains explicit so a
future release can replace the shared credential with per-Member credentials
without changing Conversation or Agent ownership.
