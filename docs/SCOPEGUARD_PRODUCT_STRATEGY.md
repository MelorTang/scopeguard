# ScopeGuard Product Strategy

## Product Definition

ScopeGuard is a task orchestration and delivery coordination layer for multi-agent software work.

It is designed to:

- turn project goals into structured tasks
- route tasks to the right executor
- preserve task scope and review context
- collect results back into shared project state

It is not designed to be:

- a coding model
- a replacement IDE
- a universal local CLI runtime
- a platform whose main value is launching shell commands

## Core Problem

Coding agents are good at performing one task.
They are much less reliable at coordinating project work across multiple tasks and executors.

The gap shows up in four places:

1. project goals do not naturally become structured tasks
2. multiple executors do not share one consistent task protocol
3. execution results do not naturally flow back into project state
4. users end up acting as the manual scheduler

ScopeGuard exists to close that gap.

## Core Product Promise

ScopeGuard should give users one stable loop:

`project goal -> planned tasks -> queued assignment -> executor work -> result -> review -> next step`

If that loop is reliable, the product is valuable.
If that loop breaks, no amount of local runtime plumbing will save the product.

## Three Product Layers

### 1. Orchestration Core

This is the core of the product and should receive the highest priority.

It includes:

- project conversations
- task planning
- task schema
- dependencies, priority, and parallelism
- `assignedExecutor`
- structured handoff generation
- assignment lifecycle
- review and approval state
- project memory

This is the layer that defines ScopeGuard.

### 2. Standard Connected Interface

This is the standard integration surface for external agents and hosts.

It includes:

- connected HTTP API
- token auth
- connected client registry
- pending assignment queue
- claim / finish / complete lifecycle
- MCP bridge

This should be the default execution path.

### 3. Automation Enhancements

These are useful enhancements built on top of the connected layer.

They include:

- skill / command workflows
- MCP prompts
- optional companion workers
- experimental local CLI launch

These should remain optional.
They should not redefine the product.

## What ScopeGuard Owns

ScopeGuard owns:

- project and task state
- executor routing
- handoff contracts
- queue and assignment semantics
- review semantics
- result reporting semantics
- orchestration context

Executors own:

- code generation
- command execution
- task-specific implementation work

Humans own:

- project goals
- review and approval decisions
- escalation and trust boundaries

## Main Workflow

The intended primary workflow is:

1. user describes a project goal
2. ScopeGuard generates tasks
3. each task gets an executor identity
4. a connected agent becomes available
5. the task is queued for that agent
6. the agent claims and executes the task
7. the result returns to ScopeGuard
8. the project state and next step become visible

This is the workflow that must remain coherent across UI, API, MCP, and documentation.

## Preferred Execution Hierarchy

### Primary

Connected / MCP-style execution.

This is the route the product should optimize for first:

- connected agents
- pending queue
- claim / finish / complete
- generic MCP bridge
- skill / prompt workflows

### Secondary

Skill or plugin-style workflows on top of MCP.

This is the most ecosystem-friendly way to guide agents through one full task-processing loop without requiring a background daemon.

### Tertiary

Optional companion workers.

These may become useful for stronger automation, but they should be treated as an enhancement, not as the default integration contract.

### Experimental / Fallback

Local CLI launch from inside ScopeGuard.

This should remain available for debugging and fallback, but it should not be treated as the main execution story.

## Product Principles

### Principle 1: Orchestrator, not executor

ScopeGuard coordinates work.
It should not try to become every executor's runtime.

### Principle 2: Connected-first

Connected / MCP-friendly integration is the standard path.
Local launch is fallback.

### Principle 3: Project-first, not prompt-first

The user should experience ScopeGuard as a project and task system, not as a pile of unrelated prompts and scripts.

### Principle 4: Result feedback matters as much as execution

The product is only useful if execution outcomes return to a durable shared state.

### Principle 5: Optional automation stays optional

Automation layers such as workers are valuable, but they should not become a hidden requirement for standard ecosystem integration.

## Current Non-Goals

ScopeGuard should not currently optimize for:

- host-specific deep automation at any cost
- universal background daemon acceptance by every IDE
- replacing Claude, Codex, or OpenCode with its own runtime
- treating shell launch compatibility as the product's main moat

## Success Metrics

### Short-term

- users can reliably create tasks from project goals
- tasks carry executor semantics clearly
- a connected agent can claim and report one full task cycle
- users do not need copy/paste handoff for the primary path

### Mid-term

- MCP bridge works in at least one major host
- skill / prompt workflows are stable for one full task-processing loop
- queue / claim / review states are easy to understand in the UI

### Long-term

- multiple agents can plug into one orchestration model
- teams can treat ScopeGuard as shared task infrastructure rather than a one-off tool

## Decision Filter

For future product decisions, ask:

1. does this improve project/task orchestration?
2. does this improve connected execution and result feedback?
3. does this only paper over one host or CLI runtime quirk?
4. if we skip this, does the main connected workflow still survive?

If the answer is mostly 1 or 2, it is probably core.
If the answer is mostly 3, it is probably adapter work or a lower-priority enhancement.

## Bottom Line

ScopeGuard is most meaningful as:

- a project-level orchestration layer
- a task coordination model
- a connected-agent integration surface

That is the product direction this repository should continue to reinforce.

---

## Current Capability Baseline

A detailed capability matrix is maintained in
[`SCOPEGUARD_CAPABILITY_MATRIX.md](./SCOPEGUARD_CAPABILITY_MATRIX.md).

It covers:

- Planning / Proposal
- Single-task orchestration
- Review actor
- Multi-task orchestration (dependsOn, parallelizable)
- Connected session / MCP presence
- Assignment lifecycle / recovery (complete, cancel)
- Multi-executor routing
- Project-level batch queue / dispatch UX

Each capability is marked as:
- ✅ Established — genuinely working and verified
- ⚠️ Minimal — functional but not fully productized
- ❌ Not yet — explicitly not supported in the current baseline
