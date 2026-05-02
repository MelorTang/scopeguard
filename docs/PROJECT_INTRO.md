# Project Intro Copy

This file contains short introduction copy you can reuse for GitHub, release notes, posts, or project descriptions.

## English

### Short Version

ScopeGuard is a safety orchestration tool for AI coding workflows.
It helps developers run AI-generated code changes with clearer file boundaries, safer parallelism, and more reviewable outputs.

### Medium Version

ScopeGuard helps turn AI coding from a one-shot generation step into a controlled engineering workflow.
Instead of trusting an agent's output after the fact, you can define task boundaries up front, run work in isolated git worktrees, verify whether changes stayed in scope, and review the result before merge.

It is designed to work alongside tools like Codex, Claude Code, and Cursor rather than replace them.

### Social Version

ScopeGuard helps manage the risk of AI-written code before it reaches your main branch.

It adds task boundaries, file locks, worktree isolation, verification, and review flow on top of tools like Codex, Claude Code, and Cursor.

If you are using AI heavily in a real repo, especially with parallel tasks, ScopeGuard is built for that workflow.

## 中文

### 短版

ScopeGuard 是一个面向 AI 编码工作流的安全编排工具。
它帮助开发者在使用 AI 生成代码改动时，获得更清晰的文件边界、更安全的并行协作，以及更容易审查的输出结果。

### 中版

ScopeGuard 的目标，是把 AI 编码从一次性的生成动作，变成一条可控的工程流程。
你不需要等到 AI 改完之后再被动兜底，而是可以先定义任务边界，在隔离的 git worktree 中执行，再验证改动是否越界，并在合并前完成审查。

它不是为了替代 Codex、Claude Code、Cursor 这类工具，而是为它们补上一层工程化的安全护栏。

### 宣传版

ScopeGuard 帮你在 AI 写出的代码进入主分支之前，先把风险管住。

它在 Codex、Claude Code、Cursor 这类工具之上，增加了任务边界、文件锁、worktree 隔离、验证和审查流程。

如果你已经在真实仓库里重度使用 AI 编码，尤其是开始并行跑多个任务，ScopeGuard 就是在解决这类问题。
