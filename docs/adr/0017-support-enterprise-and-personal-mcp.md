# Support enterprise and personal MCP connections

ScopeGuard V1 will support an Organization-managed, server-side, read-only MCP
connection for enterprise knowledge as a core acceptance capability. The
Desktop may also connect to Member- or Workspace-configured local stdio and
remote HTTP MCP servers as an advanced extension, with credentials kept in the
operating-system credential store and all exposed tools inheriting the active
Conversation Execution Profile. Local stdio MCP servers are executable code and
must run through the Managed Execution Sandbox in Request Approval and Auto
Approve. Agent Templates may recommend an MCP connection but cannot install it,
configure credentials, or expand its permissions. V1 will not ship first-party
enterprise messaging or business-system connectors, and personal MCP support is
not part of the core business-loop acceptance gate.
