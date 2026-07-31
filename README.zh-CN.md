# ScopeGuard

面向个人知识工作的桌面多 Agent 工作台。

[English](./README.md)

ScopeGuard 让一个用户在同一 Workspace 中创建多个职责不同的持久 Agent，
并行推进研究、核验、写作等任务。每个 Agent 的对话默认隔离；只有用户明确
发布的 `ContextRevision` 或发送的 `Handoff` 才会进入其他 Agent 的后续运行，
且来源可以追溯到 Agent、Task、Run 与 Artifact。

![ScopeGuard 多 Agent 桌面工作台](./docs/assets/scopeguard-workspace.png)

正式产品形态是 Electron 桌面端。Web 仅用于快速预览渲染层，不具备文件、
命令、模型请求、远端执行或密钥能力。

## 第一阶段能力

- 创建不依赖本地目录的 Workspace，也可为需要文件工具的 Workspace 打开本地文件夹。
- 配置并测试 OpenAI-compatible 或 Anthropic-compatible 模型服务。
- 配置本机或带 Bearer Token 的远端 Runtime，并为各 Agent 选择执行节点。
- 在一个 Workspace 中创建调研、核验、文档、开发等多个持久 Agent。
- 以 Task/Assignment 管理工作，以 Thread 保存独立对话，以 Run 保存单次执行快照。
- 同时显示 1-4 个 Agent 任务，并发运行、停止或重试，互不连带取消。
- 将文本、Markdown、报告和成功写入的普通文件保存为可追溯 Artifact。
- 显式发布 Artifact 到版本化 Workspace Context，或向另一个 Agent 发送 Handoff。
- 在统一收件箱处理失败、完成、Runtime 离线、工具审批和 Agent 补充信息请求。
- Agent 可暂停当前本地 Run 等待用户在原对话补充信息，并继续同一个 Run。
- 本地文件工具受真实路径边界约束；写文件和运行命令默认需要审批。
- 桌面退出后，已提交到远端 Runtime 的任务继续运行；再次启动后自动重连并导入成果。
- 重启恢复 Workspace、Agent、Task、Thread、Run、Context、Artifact、收件箱、布局和草稿。

ScopeGuard 不负责 VPN、模型托管、中转服务部署、多人账号、云同步或自动跨
Agent 记忆。第一阶段是“个人优先、团队就绪”，不是多人协作 SaaS。

## 从源码启动

需要 Node.js 22 或更高版本，以及 pnpm 10 或更高版本。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会构建 Electron 主进程和 Agent host，启动 Vite 渲染层并打开桌面应用。

仅预览前端：

```bash
pnpm dev:web
```

Web 预览使用内存 mock bridge，不能替代桌面验收。

## 启动远端 Runtime

```bash
pnpm runtime:build
SCOPEGUARD_RUNTIME_TOKEN='replace-with-a-long-random-token' \
SCOPEGUARD_RUNTIME_HOST='127.0.0.1' \
SCOPEGUARD_RUNTIME_PORT='8787' \
SCOPEGUARD_RUNTIME_DB="$HOME/.scopeguard-runtime/runtime.sqlite" \
pnpm runtime:start
```

本机测试可在桌面端填写 `http://127.0.0.1:8787`。远端部署必须通过 HTTPS
反向代理暴露，桌面端会拒绝非回环地址的明文 HTTP。Runtime 数据库保存任务、
事件和成果，不保存提交时使用的 Provider API Key；运行中的 Runtime 进程必须保持存活。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

本地可重复 Provider：

```bash
pnpm smoke:provider
```

然后将 `http://127.0.0.1:47821/v1` 配置为 OpenAI-compatible 服务，测试
API Key 和模型可填写任意非空值。完整桌面、远端退出续跑与三 Agent 验收步骤见
[VERIFICATION.md](./docs/VERIFICATION.md)。

## 架构

```text
apps/desktop              Electron 主进程、preload、渲染层、Agent host
packages/domain           Workspace/Agent/Task/Artifact 等领域模型
packages/application      用例、本地与远端运行编排
packages/agent-runtime    原生模型与工具循环
packages/provider-adapters
packages/tool-runtime
packages/storage-sqlite   SQLite schema v6 与向前迁移
packages/cli-runtime      可选本地 CLI 进程适配器
packages/remote-runtime   常驻远端任务服务与 HTTP 客户端
packages/ipc-contracts    运行时校验的桌面 IPC 契约
```

详细设计见 [V2_ARCHITECTURE.md](./docs/V2_ARCHITECTURE.md) 和
[V2_UI_SPEC.md](./docs/V2_UI_SPEC.md)。

## 安全边界

- Electron Renderer 启用 `sandbox` 与 `contextIsolation`，不启用 Node.js。
- Preload 只暴露显式 API；Main 同时校验 IPC 调用来源和 payload。
- Agent host 是唯一 SQLite 写入者。
- Provider Key 与 Runtime Token 通过 Electron `safeStorage` 加密，SQLite 只保存不透明引用。
- 密钥不返回 Renderer，也不写入普通日志、Run Event、Activity 摘要或 Artifact。
- 没有本地目录或使用远端 Runtime 时，本地文件和命令工具强制关闭。
- 本地 CLI 只能用于已打开本地文件夹的 Workspace。

这是桌面应用权限边界，不是容器沙箱。完整信任模型见
[SECURITY.md](./docs/SECURITY.md)。

## 迁移

SQLite schema v4-v6 会把旧 `Project`、`AgentProfile` 和 `Thread` 向前映射为
Workspace、AgentDefinition/AgentInstance 与 Task/Assignment，保留历史记录。
旧实体只作为兼容适配层存在，不再是产品信息架构。v0.4 迁移说明见
[V0.4_TO_DESKTOP_V2.md](./docs/V0.4_TO_DESKTOP_V2.md)。
