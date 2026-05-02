# Quickstart

This guide helps you run ScopeGuard quickly from source and dogfood it against another repository.

Replace `<path-to-scopeguard>` with your local ScopeGuard checkout path.

## 1. Build ScopeGuard from Source

```powershell
cd <path-to-scopeguard>
pnpm install
pnpm build
```

## 2. Run Local CLI Directly

```powershell
node apps\cli\bin\scopeguard.js doctor
node apps\cli\bin\scopeguard.js smoke
```

Legacy alias is still available:

```powershell
node apps\cli\bin\agentboard.js doctor
node apps\cli\bin\agentboard.js smoke
```

## 3. Run ScopeGuard Against Another Repository

In Windows PowerShell, define a helper that points to your local ScopeGuard source checkout:

```powershell
function scopeguard-dev {
  node <path-to-scopeguard>\apps\cli\bin\scopeguard.js @args
}
```

Then in the external repository:

```powershell
scopeguard-dev init
scopeguard-dev scan
scopeguard-dev doctor
scopeguard-dev smoke
```

## 4. Planning Flow

```powershell
scopeguard-dev plan requirements\feature.md
scopeguard-dev validate-plan plan.json
scopeguard-dev import-plan plan.json
scopeguard-dev tasks
scopeguard-dev next
scopeguard-dev schedule
```

## 5. Manual Verification Flow

```powershell
scopeguard-dev verify T-001 --working-tree
scopeguard-dev review T-001 --working-tree
scopeguard-dev verify T-001 --working-tree --scope-only
scopeguard-dev verify T-002 --working-tree --include-dependencies
```

## 6. Which Verify Mode Should You Use?

Use normal verify:
- `scopeguard verify T-001`
- For task worktree validation with command execution.

Use `--working-tree`:
- `scopeguard verify T-001 --working-tree`
- For manual edits made in the current repo working tree.

Use `--scope-only`:
- `scopeguard verify T-001 --working-tree --scope-only`
- For file-boundary validation when you want to skip command execution.

Use `--include-dependencies`:
- `scopeguard verify T-002 --working-tree --include-dependencies`
- For working-tree validation where dependency task files are also present and needed for command execution.
- Current preview supports direct dependencies only.

## 7. Notes

- `scopeguard` is the primary CLI.
- `agentboard` is a legacy alias.
- `.scopeguard` is primary storage.
- `.agentboard` remains compatibility-only legacy storage.
