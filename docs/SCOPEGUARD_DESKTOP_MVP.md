# ScopeGuard Desktop MVP

## Goal

ScopeGuard Desktop is a local-first AI engineering workspace.

Its MVP goal is not to expose all of ScopeGuard's internal safety systems on day one. The goal is to give a beginner-friendly desktop entry point where users can:

- open a project folder
- start a new project conversation or a new task conversation
- continue an existing task in chat
- review and approve work inside the same task conversation
- inspect context only when needed

The desktop app should feel closer to Codex Desktop or Claude Desktop than to a dashboard or control panel.

## Product Principles

- Conversation is the main interface.
- Important actions happen inside the conversation, not in side panels.
- Structured context is available on demand, but hidden by default.
- The product should help users start and continue work, not teach them internal workflow concepts first.
- ScopeGuard should feel like talking to your project, not operating a backend tool.
- ScopeGuard should orchestrate work, not pretend to be the executor itself.
- The first-run experience should stay lightweight, with managed workflow depth revealed only when needed.

## Product Framing

Project and task should be clearly separated:

- `Project` is the repo-level conversation and control surface.
- `Task` is one scoped unit of execution derived from project conversation.

The MVP should make this hierarchy obvious without forcing users to learn internal terminology first.

## Included In MVP

- `Home` page as the main entry point
- `Task Conversation` page as the core workspace
- left sidebar with projects and tasks
- folder-based project opening flow
- `Workspace mode` for any local folder
- `Managed project mode` for Git-aware task workflow
- unified task status labels
- inline review and inline approval inside the task conversation
- collapsible context/log drawer entry
- provider settings for real LLM routing

## Not Included In MVP

- separate review detail page
- separate approval page
- dashboard-style validation center
- exposed manual scope-check actions on the home page
- advanced route configuration UI
- multi-agent automation UI
- complex worktree management UI

## Core Screens

### 1. Home

Home is the launch surface.

It should answer:

- how do I begin
- how do I continue
- what happens when I open a folder

Home should contain:

- desktop-style app shell
- left sidebar with projects and tasks
- one primary conversation entry area
- one lightweight product guidance card
- one continue card

Home should not contain:

- branch pills
- working-tree diagnostic pills
- manual safety utility actions
- backend-style status panels

### 2. Task Conversation

Task Conversation is the main working screen.

It should let the user:

- continue a task in natural language
- ask for handoffs
- ask for summaries
- review completed work
- approve risky follow-up steps
- close out a task without leaving the conversation

The task screen should contain:

- task header
- single conversation stream
- quick prompt chips near the input box
- drawer tabs for context and logs

The task screen should not contain:

- a separate review page mental model
- persistent approval buttons in side panels
- card-heavy task database layout

## Folder Opening Rules

Folder selection is the main entry mechanism.

### Rule 1

If the user opens a folder that is not yet managed by ScopeGuard:

- create a new project context
- open a new project conversation
- let the user describe their first goal
- keep the folder usable in workspace mode

### Rule 2

If the user opens a folder that already has ScopeGuard state:

- load the existing project
- preserve existing context and task history
- start a fresh task conversation in that project

### Rule 3

Users do not need to understand the difference between "new project" and "new task" before they begin.

The system should derive that from the selected folder.

### Rule 4

Managed flow should be offered progressively.

The app should not require users to initialize Git or ScopeGuard just to begin a conversation.

## Sidebar Rules

The left sidebar is the persistent navigation structure.

It contains:

- projects
- tasks under each project
- lightweight settings/policies/home links at the bottom

It should not act like a project management board.

### Project click behavior

Clicking a project should:

- focus that project's context
- show the home/start surface for that project
- make it easy to start another task conversation

### Task click behavior

Clicking a task should:

- reopen that task conversation
- restore its conversation history
- restore its current status

## Task Status Model

Task labels must use one consistent dimension: workflow state.

Current MVP statuses:

- `Draft`
- `In Progress`
- `Needs Review`
- `Blocked`

Suggested color treatment:

- `Draft`: gray
- `In Progress`: green
- `Needs Review`: yellow
- `Blocked`: red

Risk level is not the same thing as task status.

If risk is shown later, it should appear as secondary metadata, not as the main status label.

## Task Conversation Flow

Each task should remain inside one continuous conversation.

### Stage 1: Start

The user opens or creates a task conversation.

ScopeGuard should explain:

- the current goal
- the current known constraints
- the most likely next step

### Stage 2: Execution Prep

The user can ask ScopeGuard to:

- summarize the task
- explain constraints
- generate a handoff
- explain the route decision

### Stage 3: Execution Result

When work comes back, ScopeGuard should report it in the same conversation.

Examples:

- what changed
- whether changes stayed in scope
- what remains to review

### Stage 4: Review

Review happens inside the same conversation.

The user should not be redirected to another review page just to understand whether the task is acceptable.

ScopeGuard can provide:

- diff summary
- remaining risks
- review recommendation

### Stage 5: Approval

If a step requires approval, the approval prompt appears inline in the conversation.

Examples:

- approve this step
- ask for a safer revision

Approval is event-driven, not a permanent control area.

### Stage 6: Closeout

After review and approval, ScopeGuard can continue in the same conversation with:

- final summary
- validation reminder
- close/merge recommendation

## Context Drawer Rules

The right-side drawer should stay collapsed by default.

It exists for reference, not as a parallel workspace.

Suggested drawer contents:

- task context
- constraints
- validation history
- activity log

Suggested drawer behavior:

- hidden by default
- opened only when the user wants supporting detail
- represented by narrow side tabs such as `Context` and `Logs`

The drawer should not contain primary action buttons.

## Home Page Interaction Rules

The Home page should focus on one core action: start or continue work through a folder.

### Primary actions

- `Open Project Folder`
- `Open Folder and Start`

### Continue behavior

The continue card should explain:

- reopen an existing project to continue in context
- choose a new folder to start a new project conversation

The home page should not expose internal safety mechanisms such as manual scope checking in the MVP.

## Quick Prompt Strategy

Buttons near the input box should be treated as prompt shortcuts, not hard-coded workflow branches.

Examples:

- `Continue this task`
- `Summarize current state`
- `Generate Context Pack`
- `Explain route decision`
- `Review the finished draft`

Clicking a quick prompt should effectively send a structured natural-language request into the current conversation.

The MVP should use very few buttons.
Natural language should remain the dominant interaction pattern.

## Relationship To ScopeGuard Core

The desktop app is a user-facing layer on top of ScopeGuard's existing capabilities.

It should expose ScopeGuard's strengths in a softer form:

- context control
- task continuity
- boundary awareness
- review and approval checkpoints

It should not require users to manually understand CLI-level concepts like scope checks, worktrees, or validation orchestration before they can start.

## What The MVP Should Not Try To Be

The MVP should not try to be:

- a multi-agent swarm control panel
- a plugin marketplace UI
- a giant executor dashboard
- a feature-count comparison to other orchestration tools

The job of the MVP is to prove a calmer idea:

one repo, one project conversation, one task conversation, one clear review path.

## MVP Implementation Notes

The current mockups for this MVP are:

- [Home Mockup](./mockups/scopeguard-desktop-home.html)
- [Task Conversation Mockup](./mockups/scopeguard-desktop-task-detail.html)

These mockups should be treated as interaction references, not final UI spec files.

## Next Recommended Step

After this MVP spec, the next design/development task should be:

1. define sidebar click behavior and conversation restoration rules in more detail
2. map desktop UI actions to ScopeGuard CLI/backend capabilities
3. choose the desktop shell approach such as Electron, Tauri, or local web shell
