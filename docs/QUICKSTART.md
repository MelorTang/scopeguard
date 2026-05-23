# Quickstart

This guide helps you run ScopeGuard quickly from source and use it against another repository.

Replace `<path-to-scopeguard>` with your local ScopeGuard checkout path.

---

## 1. Build from Source

```powershell
cd <path-to-scopeguard>
pnpm install
pnpm -r build
```

This compiles the CLI, server, and shared packages. **Do not skip this step.**

---

## 2. Choose Your Path

ScopeGuard has two usage modes. Pick the one that matches your goal.

### Path A: Source Repo (Contributor / Developer)

You stay inside the scopeguard checkout. Run CLI commands directly:

```powershell
node apps\cli\bin\scopeguard.js doctor
node apps\cli\bin\scopeguard.js smoke
pnpm typecheck
```

Legacy alias (still available):

```powershell
node apps\cli\bin\agentboard.js doctor
```

Use this path if you are:

- developing or debugging ScopeGuard itself
- running the test suite (`node test/verify-*.js`)
- building the desktop app

### Path B: Target Repo (End User — running ScopeGuard on your own project)

Define a helper function that points to your local ScopeGuard source, then run commands **inside your target project**:

```powershell
# Define a helper (Windows PowerShell)
function scopeguard-dev {
  node <path-to-scopeguard>\apps\cli\bin\scopeguard.js @args
}

# Navigate to your real project
cd my-project

# Initialize ScopeGuard storage
scopeguard-dev init

# Build a project map from your repo structure
scopeguard-dev scan

# Run health checks
scopeguard-dev doctor --json
scopeguard-dev smoke --json
```

Use this path if you are:

- running ScopeGuard against a real codebase
- setting up task orchestration for your own project
- connecting agents through MCP

#### First time using doctor / smoke?

These commands check environment and repository health. They are most useful **after** you have run `init` and `scan`. If you run them without a `.scopeguard` data directory, they will report missing configuration — **that is expected, not a bug**. Run `init` first.

---

## 3. Planning Flow

After `init` and `scan` are complete (Path B), or directly in the scopeguard repo (Path A):

```powershell
scopeguard-dev plan requirements\feature.md
scopeguard-dev validate-plan plan.json
scopeguard-dev import-plan plan.json
scopeguard-dev tasks
scopeguard-dev next
scopeguard-dev schedule
```

---

## 4. Manual Verification Flow

```powershell
scopeguard-dev verify T-001 --working-tree
scopeguard-dev review T-001 --working-tree
scopeguard-dev verify T-001 --working-tree --scope-only
scopeguard-dev verify T-002 --working-tree --include-dependencies
```

---

## 5. Which Verify Mode Should You Use?

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

---

## 6. Task Configuration: allowedFiles / lockedFiles

Every task can define **allowedFiles** (which files the task is permitted to read or modify) and **lockedFiles** (which files need exclusive coordination).

| Field | Meaning |
|-------|---------|
| `allowedFiles` | Files the task is allowed to read or modify. Broader = more freedom. |
| `lockedFiles` | Files that need exclusive write coordination. Narrower = less conflict. |

### Example

```
Task A: "Refactor authentication"
  allowedFiles: ["src/auth/**", "docs/auth.md"]
  lockedFiles: ["src/auth/**"]

Task B: "Write API documentation"
  allowedFiles: ["docs/**", "README.md"]
  lockedFiles: ["docs/**"]
```

Explanation:

- Task A can touch `src/auth/**` and `docs/auth.md`, but only locks `src/auth/**` for exclusive write access.
- Task B can touch anything under `docs/`, and locks all of `docs/`.
- Both tasks can read `docs/auth.md` (it is in both `allowedFiles` sets), but only one can lock it at a time.
- If both tasks tried to lock the same path (e.g., both lock `src/auth/**`), they would need a dependency or sequential ordering — ScopeGuard would not let them run concurrently.

**Rule of thumb:** make `allowedFiles` generous enough for the task to work, but keep `lockedFiles` as narrow as possible to avoid unnecessary blocking.

---

## 7. Connected MCP Handoff

After a task has been queued for a connected agent, an MCP host (Claude, Codex, OpenCode, etc.) can discover, claim, and execute it. Here is the full handoff pattern.

### What the MCP host needs

| Setting | Where to find it |
|---------|------------------|
| **base URL** | `http://localhost:<port>` (shown in desktop app or server startup log) |
| **token** | Desktop `Settings > Connected Agents / MCP > Copy token` |
| **executor id** | The value set when the agent connected (e.g., `claude-cli`, `codex-cli`) |

### Agent-side workflow (copy-paste friendly)

Once the MCP bridge is configured, an agent follows this cycle:

```text
# 1. Check connection status
scopeguard_status

# 2. Find queued tasks for this executor
scopeguard_list_pending

# 3. Claim one assignment (returns structured handoff with goal, allowedFiles, criteria)
scopeguard_claim_assignment

# 4. Execute the task
#     - Read allowedFiles for context
#     - Make changes within allowedFiles
#     - Run commands if specified
#     - Verify against acceptanceCriteria

# 5. Report results back
scopeguard_finish_assignment
  taskId: "<task-id>"
  resultSummary: "Done. Added login form validation."
  changedFiles: ["src/auth/login.tsx"]
  success: true
```

### End-to-end success chain

```
User queues task  →  Agent sees it via scopeguard_list_pending
                  →  Agent claims via scopeguard_claim_assignment
                  →  Agent executes (edits code, runs commands)
                  →  Agent finishes via scopeguard_finish_assignment
                  →  Results appear in ScopeGuard desktop
                  →  Review and approve in ScopeGuard desktop
```

This four-step cycle (`status → list_pending → claim → finish`) is the primary agent interaction pattern. ScopeGuard handles auth, queue ordering, handoff serialization, and result recording — the agent focuses on the actual coding work.

---

## 8. Notes

- `scopeguard` is the primary CLI.
- `agentboard` is a legacy alias.
- `.scopeguard` is primary storage.
- `.agentboard` remains compatibility-only legacy storage.
