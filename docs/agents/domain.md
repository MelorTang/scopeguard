# Domain Documentation

ScopeGuard uses a single domain context across its desktop application and
packages.

## Before Planning Or Implementation

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant decisions under `docs/adr/` when they exist.
- Proceed silently when either location does not yet exist. Domain documentation
  is created when a real term or durable decision needs to be recorded.

## Vocabulary

Use terms exactly as defined in `CONTEXT.md` in issues, specifications, tests,
and implementation. If a required concept is absent, determine whether the new
term represents a real domain distinction before adding it.

## Architecture Decisions

Record hard-to-reverse system decisions under `docs/adr/`. If proposed work
conflicts with an existing ADR, surface the conflict explicitly and decide
whether the ADR should be superseded instead of silently overriding it.

## Layout

```text
/
|- CONTEXT.md
|- docs/
|  |- adr/
|  `- agents/
|- apps/
`- packages/
```
