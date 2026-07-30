# ScopeGuard

一个面向本地项目的桌面多 Agent 工作台。

[English](./README.md)

ScopeGuard 允许在同一个 Project 下同时运行多个相互隔离的 Agent Thread。
各 Thread 不会隐式读取彼此对话；只有用户明确发布到版本化 Project Context
中的决策与事实才会共享。模型既可以直连，也可以通过公司自建中转服务访问，
只需配置协议、Base URL、API Key 和 Model。

正式产品形态是 Electron 桌面端。Web 仅用于快速预览渲染层，不具备文件、
命令、模型请求或密钥能力。

## 当前 MVP

- 将本地文件夹添加为 Project。
- 配置并测试 OpenAI-compatible 或 Anthropic-compatible 模型端点。
- 在一个 Project 下创建多个独立 Agent Thread。
- 通过标签页和 1-4 路分栏同时查看多个 Thread。
- 并发流式运行多个 Agent，并分别停止或重试。
- 在 Project 根目录约束内读写文件。
- 默认在运行本地命令前请求一次性授权。
- 查看工具活动并发布不可变的 Project Context 版本。
- 重启后恢复 Project、Thread、消息、布局、草稿和中断状态。
- Provider 密钥输入在保存或关闭时立即清空；保存值在 SQLite 外加密，且不会
  返回渲染层。
- 可选使用受约束的本地 CLI Agent 兼容适配器。

ScopeGuard 不负责 VPN、模型托管、中转服务部署、团队账号、云同步或自动跨
Thread 记忆。

## 从源码启动

需要 Node.js 22 或更高版本，以及 pnpm 10 或更高版本。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会构建 Electron 主进程和 Agent host，启动 Vite 渲染层并打开
桌面应用。

仅预览前端：

```bash
pnpm dev:web
```

Web 预览使用内存 mock bridge，不能访问本地文件、运行命令、保存密钥或请求
模型。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

需要本地模拟 Provider 时运行：

```bash
pnpm smoke:provider
```

然后将 `http://127.0.0.1:47821/v1` 配置为 OpenAI-compatible 端点，
测试 API Key 和 Model 可填写任意非空值。

## 架构

```text
apps/desktop              Electron 主进程、preload、渲染层、Agent host
packages/domain           领域实体、权限策略、状态转换
packages/application      用例与运行编排
packages/agent-runtime    原生模型和工具循环
packages/provider-adapters
packages/tool-runtime
packages/storage-sqlite
packages/cli-runtime      可选本地 CLI 进程适配器
packages/ipc-contracts
```

详细设计见 [V2_ARCHITECTURE.md](./docs/V2_ARCHITECTURE.md) 和
[V2_UI_SPEC.md](./docs/V2_UI_SPEC.md)，完整验收流程见
[VERIFICATION.md](./docs/VERIFICATION.md)。

## 安全边界

- Electron renderer 启用 sandbox 与 context isolation。
- Preload 只暴露显式类型化 API，不提供通用 IPC。
- IPC 同时校验调用来源与 payload。
- Agent host 是唯一 SQLite 写入者。
- Provider 密钥通过 Electron `safeStorage` 加密，SQLite 只保存引用 ID。
- 文件工具解析真实路径并拒绝访问 Project 根目录之外的位置。
- 命令执行不进行 shell 字符串拼接，并遵循 Agent Profile 的权限策略。

这是本地桌面安全边界，并不是容器沙箱。只应打开可信 Project，并仔细确认
命令授权内容。

完整信任边界见 [SECURITY.md](./docs/SECURITY.md)。

## 旧版迁移

v0.4 的任务队列、claim server、MCP bridge 和静态 Web UI 属于另一套产品
模型，已从新分支移除。详见
[V0.4_TO_DESKTOP_V2.md](./docs/V0.4_TO_DESKTOP_V2.md)。
