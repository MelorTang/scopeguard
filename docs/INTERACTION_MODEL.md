# ScopeGuard Interaction Model

**ScopeGuard is orchestration-first, not chat-first.**

This document defines how the product is meant to be used, so the team has a shared
reference when deciding what to build, what to keep, and what to deprioritize.

---

## 1. Orchestration-First

ScopeGuard's primary job is to move a task through a defined lifecycle:

```text
plan -> queue -> claim -> execute -> report -> review
```

Every UI element, API endpoint, and integration surface exists to serve this pipeline.
Chat is present, but it serves the pipeline, not the other way around.

**What this means in practice:**

- The happy path is a task flowing from project plan to connected agent execution to
  review result. Anything that does not serve this path is secondary.
- The product is measured by whether tasks complete and results come back, not by
  whether conversations are satisfying.

---

## 2. Project Page Responsibilities

The project page (home view) is the **planning and coordination surface**.

### What it owns

- **Planning** - The `/plan` command turns a goal into structured tasks with executors,
  scope, criteria, and commands.
- **Plan proposal review** - Planning creates a proposal first. Users can edit,
  remove, discard, import, or commit proposal items before they become formal tasks.
- **Proposal normalization** - Imported, generated, and manually added proposal items
  can be normalized through ScopeGuard's planning schema before they are committed.
- **Task visibility** - The task list shows every task in the project, plus its current
  state badge (draft, ready, queued, running, awaiting review, approved, etc.).
- **Connected status** - The project header shows the project-specific bearer token and
  which connected agents are online. This is the first place to check when a task is not
  being picked up.
- **Project-local token** - Connected access is scoped to the current project. Each
  project has its own bearer token, and connected agents must use the token shown on
  that project's page to see its queued tasks.
- **Coordination context** - The project activity thread captures goal discussion, plan
  decisions, and cross-task coordination. It is not a general-purpose chat room.

### What it does not own

- Task execution details, per-task logs, or handoff content. Those live on the task page.

---

## 3. Task Page Responsibilities

The task page is the **execution and review surface**.

### What it owns

- **Execution state** - A single prominent status badge shows exactly where the task is:
  Draft -> Needs Setup -> Ready to Queue -> Queued -> Running -> Awaiting Review ->
  Approved / Needs Attention.
- **Queue action** - When a matching connected agent is online, a `Queue for connected
  agent` button appears. This is the primary action on the page.
- **Latest execution** - After a connected agent finishes, the run result (output,
  changed files, summary) appears inline. This is the primary information source for
  review.
- **Review** - Review status, approve/reject actions, and review comments live here.
- **Follow-up (secondary)** - The task activity thread allows discussion, but it is
  positioned below the status and execution sections. Follow-up messages should lead to
  actionable outcomes (refine, re-queue, adjust scope), not open-ended conversation.

### What it does not own

- Cross-task planning, project-level coordination, or agent connectivity status.
  Those belong on the project page.

---

## 4. Connected / MCP - The Primary Route

Connected agents are ScopeGuard's primary execution path.

### The contract

1. An agent connects via the external API (HTTP) or MCP bridge (stdio), authenticating
   with the project's bearer token.
2. Once connected, the agent appears in the project's connected client list.
3. When a task has a matching `assignedExecutor` and is fully set up (scope, criteria,
   commands), it becomes `Ready to Queue`.
4. The user queues the task. It enters the assignment queue.
5. The connected agent discovers the pending assignment (via `scopeguard_list_pending`
   or `GET /external/pending`), claims it, and receives a structured handoff.
6. The agent executes within the handoff constraints and reports results back.
7. Results appear on the task page for review.

### Why this is primary

- **Structured handoffs** prevent scope drift. The agent gets a precise goal, allowed
  files, forbidden files, acceptance criteria, and commands, not a chat transcript.
- **Results are reviewable** - stdout, stderr, exit code, changed files, and a summary
  are all captured and displayed.
- **Queue ordering** ensures tasks are picked up in the right sequence, even with
  multiple agents.

---

## 5. Planning Engines

ScopeGuard is responsible for the planning contract, not for being the strongest model.

### Default path

The default `/plan` path uses the configured ScopeGuard desktop LLM to produce a
structured plan proposal. ScopeGuard then normalizes that proposal into its own schema:

- `title` and `goal` define the task.
- `allowedFiles`, `acceptanceCriteria`, and `preferredExecutor` determine whether the
  proposal is ready to commit.
- `commands`, `assignedExecutor`, `dependsOn`, `parallelizable`, and `priority` can be
  filled conservatively when they are missing.

### Proposal workflow

Planning is not a direct task creation command. The expected flow is:

```text
generate or import proposal -> edit -> normalize -> commit to formal tasks
```

Proposals may come from the local desktop LLM, a connected agent, a pasted JSON plan,
or a Markdown task list. ScopeGuard accepts those inputs as candidates, then applies
the same readiness states:

- `Ready to Commit` means the proposal can become formal tasks.
- `Needs Review` means the proposal has enough structure but should be checked.
- `Too Vague` means the proposal cannot be committed until it is refined.

This keeps ScopeGuard in charge of the task contract even when another tool produces
the initial plan.

### Stronger planner path

For complex work, connected Claude/Codex-style agents may produce better plans. Those
plans should still enter ScopeGuard as proposals and pass through the same validation,
normalization, and commit flow.

### Fallback path

Local CLI planning is a fallback. It can help when the desktop LLM is unavailable, but
it should not define the product model.

---

## 6. Local CLI - Experimental / Fallback

ScopeGuard can launch local CLI processes (Codex CLI, Claude CLI) directly from the UI.
This path exists for debugging, testing, and environments where a connected agent is
not available.

### Constraints

- The CLI must be installed and configured on the host machine.
- There is no structured handoff enforcement - the process gets whatever context the
  CLI provides.
- Result reporting is limited to what the CLI returns via stdout/err.

### When to use

- Verifying that an executor configuration works (test button in Settings).
- Quick one-off tasks in a controlled environment.
- Debugging handoff content before routing it to a connected agent.

### When not to use

- Production project work. Use a connected agent instead.
- Multi-step workflows where queue ordering matters.

---

## 7. Chat - Supporting Role

Chat (activity threads) exists on both the project page and the task page. It is
retained because:

- **Planning and refinement** benefit from natural language. A project goal is easier
  to describe in prose than in form fields.
- **Review comments** need a place to live. Approval summaries and feedback fit the
  thread format.
- **Debugging** during setup - questions like "why is no agent picking this up?" or
  "what does this handoff contain?" are natural chat interactions.

### Boundaries

- Chat does **not** replace the status badge, the queue button, the run result display,
  or the review panel. Those are structural UI and always take priority.
- Chat is **not** the execution surface. Typing a message to a task does not run it.
  Execution requires queueing for a connected agent or using the local CLI path.
- Chat threads are **scoped** - project chat for project coordination, task chat for
  task discussion. Cross-project chat does not exist.

---

## Summary

| Layer | Primary surface | Responsibility |
|---|---|---|
| Orchestration | State machine + status badge | Move task through lifecycle |
| Planning | Project page + proposal workspace | Turn goals into editable plan proposals |
| Execution | Task page + Queue button | Route task to connected agent |
| Result | Task page + Run result display | Show what happened |
| Review | Task page + Review panel | Approve or request changes |
| Chat | Activity threads (both pages) | Support planning, refinement, review |

The question when designing any new feature should not be "does this make the chat
better?" but "does this make the pipeline more reliable?"
