# Preview Limitations

ScopeGuard is currently in Developer Preview.

## Platform and Deployment

- Local-first only.
- No cloud service.
- No authentication or multi-tenant access control.
- No npm publish flow yet (source-run workflow is primary).

## Integrations

- No GitHub PR integration yet.
- No VS Code extension yet.
- No Cursor extension yet.

## Runtime and Agent Execution

- Codex runner is optional and may not be installed on all environments.
- Manual working-tree verification workflow is supported and expected during dogfooding.
- Merge flow is intentionally conservative and safety-first.

## Verification and Scheduling Scope

- Dependency-aware working-tree verification currently supports direct dependencies only.
- Glob matching and overlap detection are intentionally simple and conservative.

## UI Scope

- Web UI intentionally does not expose Run, Approve, or Merge actions.
- CLI remains the primary surface for higher-risk operations.

## Product Maturity

- Expect rough edges.
- Expect dogfood-driven command UX and workflow changes.
