# Rebuild the domain in the existing repository

Status: Superseded and restated by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard V1 will be developed through a breaking refactor in the existing Git
repository rather than a new directory or a prolonged parallel architecture.
The Electron shell, useful UI and IPC boundaries, Provider tests, and reusable
SQLite infrastructure may remain, while the canonical workflow becomes
Workspace to Conversation to Run to Artifact Version and replaces the current
Task, Assignment, and Thread chain. The enterprise server, document, Skill, and
MCP runtimes, and Workspace Terminal will be added; Inbox, Schedule, unattended
remote work, and conflicting legacy modules will be removed. Because no
production user data exists, V1 starts with a new schema and does not migrate old
development databases; historical Git tags preserve the former implementation.
