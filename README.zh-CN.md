# ScopeGuard

ScopeGuard 是一个个人优先的桌面多 Agent 工作台，用于让多个 AI Agent 在同一个
本地 Workspace 中协作。它同时面向编程和普通办公，不要求用户采用开发者工具式
的工作流。

中央工作台可以同时显示并运行一到四个 Conversation。每个 Conversation 创建后
固定绑定一个由用户配置的 Agent。用户可以复制 Handoff 提示词，或者显式地把有
边界的任务 Dispatch 给另一个已经存在的 Conversation。

## 项目状态

产品契约已于 2026-08-18 重置。当前架构决策是
[ADR 0024](./docs/adr/0024-adopt-a-personal-first-pi-rpc-workbench.md)。仓库中现有的
Native Harness 和 Managed Execution 代码属于重置前实现，不是新 V1 的运行时目标。
Phase 1 必须先验证 Pi RPC，之后才会开始替换运行时。

旧企业路线保留在以下可恢复 checkpoint：

- 分支 `codex/archive-enterprise-v1-2026-08-18`
- 标签 `enterprise-v1-checkpoint-2026-08-18`

## V1 产品边界

- 本地 Desktop 应用；WebUI 只用于开发预览。
- 用户创建 Workspace，并可关联本地目录。
- 用户配置 Agent：角色、指令、Model、Tool 和 Skill。
- Conversation 持久保存，同时可见一到四个。
- 支持人工 Handoff 提示词和显式 Agent Dispatch，不做自动路由。
- 管理持久 Artifact，并提供 DOCX、XLSX、PPTX、PDF Office Tool Pack。
- Pi RPC 负责 Agent loop、Provider、运行时 Tool、Session 和 Compaction。
- 后续可接外部 MCP；企业知识库和 RAG 作为独立系统开发。

Organization 管理、Agent Template、企业控制面、自动多 Agent 编排、云端 Workspace
同步和旧开发数据库迁移均不是 V1 目标。

## 所有权

| ScopeGuard 负责 | Pi Runtime 负责 |
| --- | --- |
| Desktop 工作台和交互 | Agent loop 和流式事件 |
| Workspace 和 Agent 配置 | Provider 协议执行 |
| Conversation 到 Session 的映射 | 运行时 Tool 行为 |
| 本地元数据、Artifact、Dispatch | Session 恢复和 Compaction |
| Office Tool Pack | 运行时事件产生 |

## 开发

需要 Node.js 22+ 和 pnpm 10+。

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm dev:web
pnpm dev
```

在 Pi RPC 替换完成前，这些命令仍然验证重置前实现。阶段门禁见
[VERIFICATION.md](./docs/VERIFICATION.md)。

## 文档

- [领域词汇](./CONTEXT.md)
- [目标架构](./docs/V2_ARCHITECTURE.md)
- [验证和阶段门禁](./docs/VERIFICATION.md)
- [架构决策](./docs/adr/)
- [历史研究快照](./docs/research/)

当前事实源顺序为：已接受 ADR 和 `CONTEXT.md`、当前 GitHub Wayfinder map、当前架构
与验证文档、实现代码。历史 research 用于解释旧决策，不再作为当前产品要求。
