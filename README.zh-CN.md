# ScopeGuard

ScopeGuard 是一个个人优先的桌面多 Agent 工作台，用于让多个 AI Agent 在同一个
本地 Workspace 中协作。它同时面向编程和普通办公，不要求用户采用开发者工具式
的工作流。

中央工作台可以同时显示并运行一到四个 Conversation。每个 Conversation 创建后
固定绑定一个由用户配置的 Agent。用户可以复制 Handoff 提示词，或者显式地把有
边界的任务 Dispatch 给另一个已经存在的 Conversation。

## 项目状态

产品契约已于 2026-08-18 重置。[ADR 0024](./docs/adr/0024-adopt-a-personal-first-pi-rpc-workbench.md)
定义产品边界，[ADR 0025](./docs/adr/0025-adopt-pi-rpc-with-an-extension-approval-bridge.md)
接受固定版本 Pi RPC 和受控审批 extension。Phase 2 实现已将活动 Native Harness
composition 替换为 `@earendil-works/pi-coding-agent@0.84.2` 和全新的个人版 schema，
并由 [ADR 0026](./docs/adr/0026-replace-the-native-harness-with-pi-runtime.md)
正式接受。
Phase 3 的多 Conversation 布局和显式 Dispatch 已形成候选实现；在 GitHub issue
#26 完成 Windows development/staged Pilot 与独立复审前，不视为已验收。

旧企业路线保留在以下可恢复 checkpoint：

- 分支 `codex/archive-enterprise-v1-2026-08-18`
- 标签 `enterprise-v1-checkpoint-2026-08-18`

## V1 产品边界

- 本地 Desktop 应用；WebUI 只用于开发预览。
- 用户创建 Workspace，并可关联本地目录。
- 用户配置 Agent：角色、指令、Model、Tool 和 Skill。
- Conversation 持久保存，同时可见一到四个。
- 支持人工 Handoff 提示词和显式 Agent Dispatch，不做自动路由。
- 管理持久 Artifact 版本和审阅；文件编辑由 Agent 通过现有 Tool、Skill
  和成熟外部工具链完成。
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
| Artifact 版本、来源和审阅 | 运行时事件产生 |

ScopeGuard 不实现 Office 编辑器或统一的文档操作层。Office 文件与其他
Workspace 文件使用相同的 Agent Tool/Skill 路径；实际支持范围取决于所选
工作流和已安装工具链。

## 开发

需要 Node.js 22+ 和 pnpm 10+。

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm qualify:pi-rpc
pnpm pilot:pi-runtime
pnpm pilot:pi-runtime:staged
pnpm --filter @scopeguard/desktop test:renderer
pnpm pilot:phase3
pnpm pilot:phase3:staged
pnpm dev:web
pnpm dev
```

Windows 是 Phase 2 验收平台。在 Runtime evidence commit `8554a642` 上，development
和 staged Pilot 均以 15/15 通过，覆盖一次性 Desktop host、确定性 Provider、真实固定
版本 Pi RPC、整进程退出、opaque Session 恢复及第二轮继续执行。Linux Pilot 仅作为
可选工程证据，不代表产品支持。

在 macOS 上，未签名的 Phase 2 和 Phase 3 Pilot 命令都会在 Electron 启动前主动
失败，且不存在环境变量覆盖方式。签名 macOS 安装、`safeStorage` 和真实恢复验证将
使用未来独立的 Phase 5 入口。阶段门禁见 [VERIFICATION.md](./docs/VERIFICATION.md)。

## 文档

- [领域词汇](./CONTEXT.md)
- [目标架构](./docs/V2_ARCHITECTURE.md)
- [验证和阶段门禁](./docs/VERIFICATION.md)
- [架构决策](./docs/adr/)
- [历史研究快照](./docs/research/)

当前事实源顺序为：已接受 ADR 和 `CONTEXT.md`、当前 GitHub Wayfinder map、当前架构
与验证文档、实现代码。历史 research 用于解释旧决策，不再作为当前产品要求。
