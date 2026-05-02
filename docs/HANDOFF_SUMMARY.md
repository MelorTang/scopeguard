# ScopeGuard Handoff Summary

## Current State

- Current preview line: `v0.4.0-preview`
- `scopeguard smoke` completed
- `scopeguard smoke --json` completed
- Legacy `agentboard smoke` works

## Recommended Next Phase

- Validate the public preview flow against one external repository.

## Current Validation Commands

```powershell
pnpm build
pnpm --filter @scopeguard/cli dev -- smoke
pnpm --filter @scopeguard/cli dev -- smoke --json
pnpm --filter @scopeguard/cli dev -- doctor
node apps\cli\bin\scopeguard.js smoke
node apps\cli\bin\agentboard.js smoke
git status --short
```

## Compatibility Notes

- `scopeguard` is the primary CLI.
- `agentboard` remains a legacy CLI alias.
- `.scopeguard` is the primary data directory.
- `.agentboard` remains supported as legacy compatibility.
