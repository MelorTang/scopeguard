# ScopeGuard Desktop Architecture Draft

## Purpose

This document maps the desktop MVP UI to ScopeGuard's existing CLI and backend capabilities.

It exists to answer:

- what the desktop app is responsible for
- what ScopeGuard Core is responsible for
- which user actions map to existing commands
- which operations should remain automatic and hidden from the user

This is an MVP architecture draft, not a final implementation contract.

## Design Goal

ScopeGuard Desktop should be a friendly local application shell over ScopeGuard Core.

The desktop app should:

- feel conversational
- hide internal workflow complexity by default
- reuse current ScopeGuard task, review, and verification machinery
- avoid inventing a second workflow separate from the CLI

## Product Position

ScopeGuard Desktop should be treated as the user-facing orchestration workspace.

It should not become:

- a second IDE
- a dashboard full of backend controls
- a fake executor that pretends to run code itself

It should be:

- the main conversation surface
- the home of project and task state
- the place where review and approval decisions are made
- the adapter layer between repositories, LLMs, and executors

## Division Of Labor

The architecture should preserve one simple split:

- ScopeGuard orchestrates
- executors execute

Examples of executors:

- Codex CLI
- Claude Code / Claude CLI
- API-based model providers

## Recommended High-Level Shape

Use a 4-layer structure:

1. Desktop Shell
2. Desktop App Runtime
3. ScopeGuard Orchestration Service
4. Executor Adapter Layer

## Layer 1: Desktop Shell

This layer is the native application wrapper.

Candidate implementations:

- Electron
- Tauri
- local web shell

Responsibilities:

- application window
- desktop menus
- folder picker
- local storage for UI preferences
- launching the frontend app

This layer should not contain ScopeGuard business logic.

## Layer 2: Desktop App Runtime

This is the main application UI and conversation orchestration layer.

Responsibilities:

- render Home and Task Conversation screens
- maintain active project/task selection
- render conversation history
- show inline review and approval prompts
- translate quick prompt buttons into structured user intents
- request project/task/context data from the adapter layer

This layer owns the product experience.

It should not directly shell out to many CLI commands from random UI components.

## Layer 3: ScopeGuard Orchestration Service

This layer translates desktop actions into ScopeGuard operations and LLM-assisted workflow decisions.

Responsibilities:

- discover repo root and ScopeGuard state
- read project/task metadata
- assemble project/task/context payloads for the active model
- invoke existing ScopeGuard CLI capabilities
- normalize command results into UI-friendly data
- decide which operations are foreground vs background

This layer is where desktop and current CLI meet.

It should also own:

- project-level conversation orchestration
- task-level conversation orchestration
- action extraction from model responses
- task state transitions
- review and approval flow decisions

## Layer 4: Executor Adapter Layer

This layer is where real execution backends are integrated.

Responsibilities:

- invoke Codex CLI or other executors
- normalize execution requests into backend-specific formats
- capture stdout, stderr, and structured results
- return execution artifacts to the orchestration layer

This layer should stay replaceable.

## Recommended Adapter Boundary

The desktop runtime should ideally call a small local service or typed adapter API, not shell commands everywhere in the UI.

Suggested internal API surface:

- `openProjectFolder(folderPath)`
- `listProjects()`
- `listTasks(projectId)`
- `getTask(taskId)`
- `getTaskConversation(taskId)`
- `startProjectConversation(projectId, userGoal)`
- `startTaskConversation(projectId, userGoal)`
- `generateHandoff(taskId, targetAgent)`
- `summarizeTask(taskId)`
- `reviewTask(taskId)`
- `approveTaskStep(taskId, stepId)`
- `getTaskContext(taskId)`
- `getTaskActivity(taskId)`
- `sendAssistantTurn(scope, targetId, userText)`
- `runExecutor(taskId, executorId)`
- `getProjectMemory(projectId)`
- `storeProjectMemory(projectId, record)`

These can initially be backed by CLI calls plus file reads.

## Existing ScopeGuard Capabilities To Reuse

The current CLI already exposes the main workflow pieces:

- `init`
- `scan`
- `plan`
- `validate-plan`
- `import-plan`
- `tasks`
- `next`
- `schedule`
- `run`
- `verify`
- `review`
- `approve`
- `merge`
- `close`
- `reopen`
- `discard`

Desktop should not replace these semantics. It should present them more gently.

## Folder Opening Flow

This is the most important desktop entry path.

### User action

User clicks:

- `Open Project Folder`
- or `Open Folder and Start`

### Desktop behavior

1. prompt for folder
2. locate git root
3. detect whether `.scopeguard/` already exists
4. if not found:
   - create/load project context
   - open project conversation
   - stay in workspace mode
   - offer managed-mode enablement only when needed
5. if found:
   - load existing project metadata
   - populate sidebar tasks
   - open project home
   - allow starting a new task conversation immediately

### Core mapping

- detect repo root when available
- support non-git local folders in workspace mode
- run `scopeguard init` only when managed mode is enabled
- run `scopeguard scan` if project map is missing or stale
- read `.scopeguard/tasks/*` for managed projects

## Home Screen Mapping

The Home screen is not a command center.

It is a conversation launcher and project continuation surface.

### UI responsibilities

- show current projects in sidebar
- explain folder opening semantics
- accept natural language goal
- start a new conversation

### Core behavior

When user submits a goal on Home:

- if current folder is a new project, begin project-level conversation
- if current folder is an existing project, create a new task conversation seed

### Initial MVP implementation

For MVP, a "task conversation" can be seeded by:

- creating a desktop conversation record
- optionally generating a planner prompt with `scopeguard plan`
- or creating a lightweight draft task object before full CLI import

This is one of the few places where the desktop app may need a thin app-level concept before it hands off to the full CLI lifecycle.

## Sidebar Mapping

The sidebar should be driven by project/task metadata.

### Data source

For MVP, task list data can come from:

- `.scopeguard/tasks/*.json`
- `scopeguard tasks`

Recommended approach:

- use file reads for fast sidebar hydration
- use CLI output where state derivation is safer or more stable

### Sidebar state model

Desktop should map existing CLI/task states into simplified UI states.

Suggested mapping:

- `ready` -> `Draft`
- `in_progress` -> `In Progress`
- `needs_review` -> `Needs Review`
- `test_failed` -> `Blocked`
- `conflict` -> `Blocked`
- `approved` -> `Needs Review` or later `Ready to Merge`
- `merged` -> not primary in MVP sidebar, can be archived/hidden
- `closed` -> hidden by default or shown in archived view later

The desktop UI should prefer simplified states even if internal ScopeGuard states remain more detailed.

## Task Conversation Mapping

Task Conversation is the main desktop workspace.

It should not be implemented as a separate workflow from ScopeGuard Core.

It should be a conversational wrapper around the same lifecycle:

- prepare
- execute
- verify
- review
- approve
- merge recommendation

### Stage A: Task Start

Desktop loads:

- goal
- current status
- constraints
- suggested next action

Data source:

- task metadata files
- generated context files
- adapter-generated summary

### Stage B: Execution Prep

User may ask for:

- task summary
- route explanation
- handoff generation
- constraints explanation

Core mapping:

- read task spec
- read project map
- read current state
- optionally use `scopeguard plan`-derived artifacts if available

### Stage C: Execution Trigger

If desktop later supports execution dispatch, this should map to:

- `scopeguard run <task-id> --runner <runner>`

For MVP, execution may still happen outside the desktop app while the desktop acts as the coordinating conversation layer.

### Stage D: Review

Desktop should reuse:

- `scopeguard verify`
- `scopeguard review`

But it should present results inline as natural conversation, not as raw command output.

### Stage E: Approval

Desktop should reuse:

- `scopeguard approve <task-id>`

However, the approval interaction should appear as an inline chat event.

### Stage F: Merge Recommendation

Desktop may present merge readiness in conversation even if the actual merge is deferred.

Core mapping:

- `scopeguard merge <task-id>`

This can stay outside the MVP foreground flow if needed.

## Review And Approval Handling

These should remain inline in the task conversation.

### What stays visible to the user

- summary of what changed
- summary of remaining risk
- plain-language approval prompt

### What stays hidden in the adapter layer

- exact verification command chain
- detailed out-of-scope checks
- raw review markdown generation flow

Desktop should consume those results and translate them into conversational UI.

## Context Drawer Mapping

The context drawer is reference-only.

Suggested sources:

- task JSON
- allowed/forbidden files
- generated review files
- verification records
- activity/event records

It should stay collapsed by default.

It should not trigger main workflow actions.

## What Should Remain Automatic

The desktop app should not ask the user to manually run internal safety machinery unless something is wrong.

These should remain background responsibilities:

- scope enforcement during run/verify
- out-of-scope detection
- dependency/lock checks
- repo root detection
- task state normalization
- loading project/task metadata

This is important because the MVP desktop experience is supposed to feel simpler than the CLI, not equally operational.

## Suggested MVP Data Flow

### Home startup

1. user opens app
2. desktop loads recent projects
3. user opens folder
4. adapter detects ScopeGuard state
5. desktop enters project home

### Start task conversation

1. user describes a goal
2. desktop creates a task conversation seed
3. adapter gathers project/task context
4. desktop shows first system message with goal and suggested next step

### Continue task

1. user clicks task in sidebar
2. adapter loads task metadata and conversation history
3. desktop restores task conversation

### Review and approval

1. adapter obtains verify/review results
2. desktop renders them inline as chat messages
3. user approves in chat
4. adapter invokes approval command or records approval step

## Recommended MVP Technical Strategy

### Frontend

- build the UI as a local web app first
- preserve the current mockup direction
- design around Home and Task Conversation only

### Shell

- choose Electron if speed of implementation matters most
- choose Tauri if package size and native feel matter more

For MVP, Electron is probably the faster path.

### Adapter

Start with a local Node-based adapter that:

- shells out to existing CLI commands when needed
- reads `.scopeguard` files directly for fast UI hydration
- exposes typed JSON responses to the frontend

This avoids rewriting ScopeGuard Core too early.

## Execution Strategy

The desktop app should not depend on long-term manual copy/paste handoff as its final execution model.

Manual handoff is acceptable in early product stages because it:

- validates the task and context model quickly
- keeps integration cost low
- allows compatibility with tools that are hard to automate

However, manual handoff should be treated as an interim compatibility mode, not the final architecture.

### Long-term direction

ScopeGuard Desktop should evolve toward direct executor integration.

That means:

- ScopeGuard Desktop remains the conversation and control layer
- ScopeGuard Core remains the state, boundary, and review layer
- external executors perform actual task execution

In this model, the desktop app does not become the executor itself.

### Why CLI executors are the best first target

CLI-based executors are the best first automation target because they:

- can be launched programmatically
- are easier to observe through stdout, stderr, and exit codes
- are easier to attach to local repo state
- avoid brittle UI automation
- let the user stay in one desktop workflow

Recommended first executor class:

- Codex CLI
- Claude CLI / Claude Code CLI

These should be treated as execution backends, not as competing desktop experiences.

### Why IDE integration is lower priority

IDE integration can still matter later, but it should not be the first deep automation target.

Reasons:

- IDE automation is usually more brittle
- UI-level integration is harder to normalize
- context continuity is harder to guarantee
- the desktop app gains less control over execution lifecycle

For MVP and early automation, CLI integration is the cleanest path.

### Suggested phases

#### Phase 1

Desktop uses conversation + context + manual handoff compatibility.

#### Phase 2

Desktop directly invokes one or more CLI executors.

Recommended first executor:

- Codex CLI

Recommended second executor:

- Claude CLI

#### Phase 3

Desktop supports additional executors and optional IDE bridges.

## Subagent Alignment

Claude Code's published subagent model is useful reference material for ScopeGuard's future direction.

Based on Anthropic's public docs, Claude subagents are specialized assistants with:

- separate context windows
- custom prompts
- tool restrictions
- project-level or user-level configuration
- optional automatic delegation by the main agent

This overlaps with ScopeGuard in several important ways.

### Similarities

- both treat the main conversation as a control layer
- both benefit from isolating context for specialized work
- both allow task-specific delegation
- both make tool permissions an important part of execution safety

### Differences

Claude subagents are primarily an execution-orchestration feature inside the Claude ecosystem.

ScopeGuard should stay broader:

- ScopeGuard is not just one model's subagent system
- ScopeGuard should coordinate project context, task state, review, approval, and safety across executors
- ScopeGuard can use executor-specific subagent features, but should not depend on them architecturally

### Product implication

If an executor like Claude CLI supports subagents, ScopeGuard can eventually use that as an execution optimization.

Examples:

- planner subagent
- code-review subagent
- docs subagent

But ScopeGuard's own abstraction should remain:

- project context
- task context
- workflow state
- approval checkpoints
- validation and review flow

In other words, executor subagents are useful implementation leverage, not the product's core architecture.

## Immediate Follow-Up Work

After this document, the next implementation tasks should be:

1. define the desktop-side project/task JSON view models
2. define how conversation history is stored and restored
3. decide whether "task conversation seed" is stored in desktop state or ScopeGuard state
4. prototype the local adapter API
5. choose Electron or Tauri for the first runnable shell

## Current Desktop Shell Scaffold

The repository now includes a minimal desktop package:

- `apps/desktop`
- package name: `@scopeguard/desktop`
- entrypoint: `apps/desktop/src/main.ts`

The shell starts the existing ScopeGuard board server for a project root, then opens the local web UI in an Electron `BrowserWindow`.

The first version intentionally keeps the shell thin:

- it does not duplicate frontend code
- it does not bypass the desktop adapter API
- it defaults to the current working directory as the project root
- it accepts `--project <path>` and `--port <number>`

Development flow:

```powershell
pnpm --filter @scopeguard/server --filter @scopeguard/desktop build
pnpm --filter @scopeguard/desktop dev -- --project E:\path\to\repo --port 3737
```

Electron is not committed as an installed dependency yet. To run the shell locally, install it for the desktop package:

```powershell
pnpm --filter @scopeguard/desktop add -D electron
```

This keeps the MVP scaffold buildable in environments where downloading Electron is not available, while still giving the project a concrete desktop entry point.
