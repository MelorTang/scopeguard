# DeepSeek Harness 对 ScopeGuard 的可吸收能力调查

> Status: Historical research from the retired Native Harness route. Its execution-ledger findings remain input, but its ScopeGuard boundary conclusions are superseded by [ADR 0024](../adr/0024-adopt-a-personal-first-pi-rpc-workbench.md).

Research snapshot: 2026-08-14

- DeepSeek Harness source: [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a), committed 2026-08-13.
- ScopeGuard source baseline: [`26b2b48e2432c566301af8d522a117baa483b1de`](https://github.com/MelorTang/scopeguard/tree/26b2b48e2432c566301af8d522a117baa483b1de).
- Current ScopeGuard target boundary: [CONTEXT.md](../../CONTEXT.md), [V1 target module architecture](v1-target-module-architecture.md), and ADR 0006, 0014, 0018, 0019, 0022, 0023.
- Evidence labels: **事实** means directly documented or source-verified; **判断** means a ScopeGuard-specific inference from those facts.

## Executive decision

**不要把 DeepSeek Harness 作为 ScopeGuard 的第二套 Harness、运行时依赖或插件框架。把它当成一组经过实现验证的契约模式和测试样本。**

DeepSeek Harness 是覆盖 Agent loop、Session、工具、沙箱、持久化、Web UI、SDK、Subagent 和 Workflow 的完整可组合运行时；它以 Cordis 实现 “Everything is a Plugin”。官方同时把它标为 developer preview，并明确警告会有破坏兼容性的变化。[README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L5-L11) [Package families](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/README.md#L11-L59) [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L9-L37)

这与 ScopeGuard 已确定的边界冲突：ScopeGuard 只管理自己的 Native Harness，不集成外部 Harness；Provider 协议内核已选择性从 Pi 派生；Skill 不能授予额外权限；Local Core 与企业服务器也已有明确所有权。[ADR 0006](../adr/0006-vendor-selected-pi-runtime-source.md) [ADR 0016](../adr/0016-use-an-open-skill-package.md) [ADR 0018](../adr/0018-offer-an-unmanaged-workspace-terminal.md) [ADR 0023](../adr/0023-use-a-local-core-and-modular-enterprise-server.md)

最值得吸收的不是 Cordis，而是以下“小而硬”的机制：

1. 可重放的 Conversation/Run 执行 ledger，以及 “model-visible means logged” 不变量；
2. keyless record/replay 的真实组合测试；
3. 工具调用先持久化、严格校验、单调收紧策略、结果唯一化的执行管线；
4. 崩溃后的 `effect_unknown`，而不是把未知副作用投影成已取消；
5. usage/token 压力账本与可审计的 Active Context Projection/compaction；
6. 沙箱的 `full / partial / unavailable` 真实性和 runner failure/denial/task failure 分类；
7. 私有大输出 spill、纯事件投影和重复工具调用保护。

## Upstream assessment

### Product and architecture

**事实：** DeepSeek Harness 的运行实例是一个 Cordis 插件树。Profile 叠加 Bundle、用户 patch、home patch 和命令行 overlay；模型适配、工具注册、Session log 和 Agent loop 本身都是可替换插件。[Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L9-L37)

**事实：** Cordis 用 context service、声明式 dependency injection、typed events 和 reversible effects 管理能力；插件卸载时注册会撤销。[Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cordis-primer.md#L7-L44)

**事实：** 能力通常拆为 Service Definition、Service Provider、Consumer。LLM、filesystem、subprocess、sandbox、persistence 等实现可在 seam 后替换。[Capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L98-L129)

**判断：** ScopeGuard 应吸收 capability seam、生命周期 disposer 和事件契约，不应吸收任意代码插件、动态 patch 或 package-per-capability 结构。ScopeGuard V1 的模块粒度应继续由信任边界和所有权决定，不由“所有东西都可插拔”决定。

### Execution and persistence

**事实：** DeepSeek 把一次模型请求及其工具调用称为 step，一个 turn 可含多个 step；`turn/start`、`step/start`、消息、tool call/result、`step/end`、`turn/end` 都是持久事件。[Turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L63-L90)

**事实：** append-only Session log 是完整交互历史的事实源，模型历史从日志派生。任何进入模型的内容都必须可从日志重建，即 “model-visible means logged”。[Session](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session.md#L1-L11) [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md#L92-L96)

**事实：** 冷恢复保留已落盘但未闭合的 turn，并用 `interrupted` 边界闭合，而不是截断历史。持久化契约测试明确覆盖未完成工具副作用：只读/幂等调用可以重试，其他调用必须先核验外部状态或询问用户。[Persistence contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-persistence/tests/contract.ts#L118-L168) [Unknown effect recovery](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-persistence/tests/contract.ts#L224-L262)

**判断：** ScopeGuard 不应复制 DeepSeek 的 Session domain。应在自己的 `Conversation -> Run -> Artifact Version` 模型内建立等价的不变量，并保持 [ADR 0003](../adr/0003-separate-durable-history-from-active-context.md) 规定的 Transcript 与 Active Context Projection 分离。

### Tools, approval, and safety

**事实：** DeepSeek 工具管线是 `pre-execute -> monotonic guards -> execute wrappers -> post-execute -> finalize -> immutable result`。工具参数在策略前完成 JSON materialization、校验和冻结；参数一旦已记录和展示就不能被 middleware 改写。[Tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-execution-pipeline.md#L4-L60) [Tools](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/tools.md#L170-L172)

**事实：** Guard 只能 deny 或 abstain，不能 allow，所以后注册的策略不能覆盖更严格的拒绝。Approval 只有 `allowed-once` 是授权；rejected、cancelled、unavailable 和异常都失败关闭。[Tools API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/tools.md#L515-L525) [Approval](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/approval.md#L21-L33)

**事实：** 工具只有显式返回 concurrency-safe 才并行；未知、异常或未声明均串行。[Tools](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/tools.md#L61-L74)

**判断：** 这些规则与 ScopeGuard 的 Agent Policy、Conversation Execution Profile 和共享 Workspace 冲突检测高度一致，适合在 `Capability Runtime` 内实现，而不是继续把 permission/approval/execute 混在 Native Harness loop 内。

### Testing and maturity

**事实：** 上游测试分 unit、per-file coverage、真实 API E2E、keyless snapshot/replay 和 Chromium replay；snapshot 会启动真实组合，只替换 LLM/网络等非确定边界，并检查持久日志和外部世界状态。[Testing policy](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/testing.md#L7-L35) [LLM replay](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/llm-replay/README.md#L5-L17) [ACP snapshot](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/acp-snapshot/README.md#L5-L14)

**事实：** 固定源码的根版本是 `0.1.0-rc.5`，而官方 README 明确是 developer preview。[package.json](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/package.json#L1-L10) [README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L9-L11)

**判断：** 工程纪律和架构完整度很强，但外部 API/数据格式稳定性仍低。应固定 commit 研究和派生测试，不应跟随 `latest` 直接依赖。

### Evaluation and feedback loop

**事实：** 上游可以给 finalized assistant message 保存 positive/negative、note、时间戳和 CAS version 的独立 sidecar；它不进入 transcript 或模型上下文。[Message feedback](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/feedback/message-feedback/README.md#L5-L36)

**事实：** Session telemetry 支持 `full`、`feedback-only`、`disabled`，但上传是 best-effort，且上游明确没有内置 redaction policy。[Session telemetry](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-telemetry/README.md#L5-L23) [Limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-telemetry/README.md#L45-L49)

**未发现：** 固定提交没有独立 grader、任务成功认证、reward 或“评测结果自动更新策略”的产品闭环。官方 benchmark 文档只说明用 Python SDK 执行隔离任务；bounded goal driver 也明确不是独立 evaluator。[Benchmark](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/BENCHMARK.md#L1-L3) [Goal limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/goal/goal-round-driver/README.md#L58-L64)

**判断：** 可吸收的是“轨迹可重放 + 人类反馈 sidecar”，不是一个已经完成的自动评测闭环；需要认证结果时，ScopeGuard 仍需独立 verifier，而不能把 Agent 自报完成当作证据。

## ScopeGuard current and target gap

以下 tracked code 是旧实现差距证据，不是 V1 目标术语或未来结构。

| Area | Current evidence | Target implication |
| --- | --- | --- |
| Run trace | `RunEvent` 只有 status、delta、message、tool call、approval-required；没有 turn/step、exact request、usage、approval decision 或 projection manifest。[domain](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/domain/src/index.ts#L514-L550) | 新 V1 schema 需要完整 execution ledger，Renderer projection 不能成为事实源。 |
| Request snapshot | `RunConfigSnapshot` 记录配置，但不记录实际 system prompt sections、tool schemas、Active Context Projection manifest 或 request envelope。[domain](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/domain/src/index.ts#L413-L423) | 每个 Provider request 必须能从本地持久事实重建；服务端仍不得持久化 prompt。 |
| Usage | Provider stream 已规范化 token usage，但 application observer 的 `onUsage` 是空实现。[agent runtime](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/agent-runtime/src/native-agent-runtime.ts#L136-L146) [application](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/application/src/index.ts#L2108-L2120) | 这是低成本 P0：持久化每 step usage、未知字段和累计 pressure。 |
| Crash effect | 启动恢复把未完成 tool call 批量更新为 `cancelled`。[application](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/application/src/index.ts#L330-L340) [store](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/storage-sqlite/src/index.ts#L1499-L1537) | 已开始的外部 effect 不能推断为未发生；必须落为 `effect_unknown` 并禁止盲重试。 |
| Tool output | command output 到 100 KB 后只保留前缀并丢弃其余内容。[tool runtime](https://github.com/MelorTang/scopeguard/blob/26b2b48e2432c566301af8d522a117baa483b1de/packages/tool-runtime/src/index.ts#L427-L450) | 用私有、Run-scoped spill 保存完整输出；模型只看 bounded preview 和 opaque locator。 |

目标架构已经明确 Native Harness 只拥有 provider/tool loop，Capability Runtime 拥有授权和 effect，Managed Execution 拥有 OS 边界，Local Core 拥有持久化和状态转换。[V1 target module architecture](v1-target-module-architecture.md#4-native-harness) 因此下述建议主要是**细化既有目标的实现契约**，不是重新拆架构。

## Adoption recommendations

### P0. Execution ledger and exact request manifest

**Classification: adopt now; refines existing V1 architecture.**

在 Local Core 的新 V1 schema 中，为每个 Run attempt 建立单序列 append-only ledger，至少包含：

- `turn_started` / `turn_ended(reason)`；
- `step_started` / `request_manifested` / `step_ended`；
- final assistant message、可选的 packed stream diagnostics、reasoning visibility metadata 和 usage；
- `tool_proposed`、validated arguments hash、effect classification；
- `approval_asked` / `approval_decided`；
- `tool_started` / `tool_resulted` / `effect_unknown`；
- terminal Run result and Artifact Version publication reference。

`request_manifested` 应记录 exact model-visible request header：Run/step identity、Provider protocol、Model、system sections、message sequence、完整 tool schemas、Active Context Projection manifest，以及这些对象的 versions/hashes、input event boundary 和 output budget。大对象可引用本地不可变 blob，但不能只留 hash 而失去重建来源。原始 Provider credential、server routing、企业知识 credential 不得进入 ledger；企业服务器也不得持久化 prompt/tool payload。

核心运行时不变量：

> 模型可见的每一个字节都能从本地 durable facts 与被引用的不可变对象重建；任何持久化失败都不能返回一个“已授权、已执行或已完成”的成功状态。

不要照搬 DeepSeek 的单一 Session truth。ScopeGuard 的完整 Conversation Transcript 保持不变；每个 Run 只引用一个不可变 Active Context Projection。

### P0. Preserve unknown effects across crashes

**Classification: adopt now; already named in the target Capability Runtime.**

Tool effect 至少区分 `none/read/idempotent-write/non-idempotent-external`。一旦 `tool_started` 已提交而 `tool_resulted` 未提交：

- read-only/idempotent 调用可在显式新 attempt 中重试；
- Workspace write 先通过文件 identity/hash 核验；
- 外部业务系统、shell、Skill、stdio MCP 或无法证明的调用进入 `effect_unknown`；
- UI 显示“结果未知，需要核验”，不得显示“已取消”或“未执行”；
- 自动恢复和 Agent retry 不得再次发起非幂等 effect。

这应成为 crash fixture，而不只是错误文案。

### P0. Keyless replay and real-composition harness tests

**Classification: adopt the method, not the upstream harness.**

在 ScopeGuard 自有测试支持层增加三种 fixture：

1. `record`: 仅显式人工运行，调用真实 Provider，保存脱敏后的 normalized stream script；
2. `replay`: CI 默认，从静态 script 驱动真实 Native Harness、Capability Runtime、Local Core 和 SQLite；
3. `refresh`: 只重算 ScopeGuard 预期输出，不改录制的 Provider 行为。

每个场景同时断言 exact request manifest、tool schema、ledger、最终 Transcript/Artifact、Workspace 外部状态和 untouched files。首批场景：纯文本、两 step tool call、approval deny、user input、malformed/truncated tool arguments、mid-stream abort、crash after `tool_started`、context overflow、Provider terminal event missing。

这应补充而不是替代 [Pi runtime vendoring boundary](pi-runtime-vendoring-boundary.md) 的 protocol contract tests。

### P0. One Capability Runtime tool pipeline

**Classification: adapt.**

将工具调用固定为：

`parse -> strict schema validate -> immutable snapshot -> resolve most-restrictive policy -> optional approval -> monotonic guards -> execute -> output validate -> bounded presentation/spill -> durable result`

要求：

- Agent Policy、Conversation Execution Profile、Skill/MCP effect declaration 只可共同收紧；
- guard 只有 deny/abstain，不能强制 allow；
- approval 只有一次性、与 exact invocation hash 绑定的 grant；
- 参数在展示/持久化后不可改写；
- output schema 与 model-facing presentation 分开验证；
- 未明确声明 concurrency-safe 的调用一律 exclusive；
- tool body、hook、callback 或 observer 异常不能跳过后续持久化/清理。

### P0. Usage ledger and request-pressure gate

**Classification: adopt now; low implementation cost.**

把已规范化但被丢弃的 usage 持久化到 step：`inputTokens?`、`outputTokens?`、source、receivedAt。未知不是零；Provider 不返回 usage 时记录 `unavailable`，再用固定算法产生带 `estimated` 标签的保守 pressure。

初期只用于：

- 展示本次 Run 和 Conversation 累计；
- 在请求前比较管理员配置的 context limit；
- 触发 Active Context Projection rebuild/compaction；
- 为 replay fixture 提供可检查的 budget 决策。

不要引入 DeepSeek telemetry exporter；usage 是本地运行事实，不等于允许外发的 telemetry。

### P0 input to Issue #14. Sandbox truth and failure attribution

**Classification: adopt the vocabulary and tests; reject the Windows runner.**

DeepSeek 的 sandbox seam 区分 `full`、`partial` 与 unavailable，并把 runner infrastructure failure、sandbox denial、child task failure 分开。无 runner 时禁止静默 passthrough。[Sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md#L9-L39) [Failure and denial rules](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md#L96-L156)

ScopeGuard 应进一步把 enforcement 拆成 capability matrix，而不是一个总体布尔值：file read、file write、registry、credentials、process、IPC、network、process-tree cleanup。任何 acceptance-required capability 为 partial/unavailable 时，Request Approval 与 Auto Approve 必须拒绝执行。

**不要采用 DeepSeek Windows ACL runner 作为 ScopeGuard Managed Execution。** 上游明确把它报告为 partial：Everyone ACL 和 hard-link 边界仍可写；restricted token 只限制部分写访问，不能限制读取、网络或进程可见性。[Windows ACL status](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sandbox/sandbox-windows-acl/README.md#L5-L9) [Documented limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sandbox/sandbox-windows-acl/README.md#L73-L82)

因此本研究只能为 [Issue #14](https://github.com/MelorTang/scopeguard/issues/14) 提供 failure taxonomy 和负向 fixtures，不能关闭该原型票，也不能降低 [ADR 0022](../adr/0022-require-a-managed-execution-sandbox.md) 的 acceptance matrix。

### P1. Private spill for large tool output

**Classification: adapt.**

DeepSeek 的 spill service 保存完整超大文本并返回 opaque locator；policy 层只给模型 head/tail preview。上游同时明确 session namespace 不是 access control，service 本身也不提供 retrieval/delete 或 ACL。[Spill service](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/spill/spill/README.md#L5-L42) [Spill policy](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/spill/spill-policy/README.md#L5-L37)

ScopeGuard 应把 locator 设计为 Local Core opaque ID，不向模型暴露任意宿主绝对路径。完整内容进入受保护的 Run trace blob；只有被 Member 明确发布的内容才成为 Artifact Version 或 Workspace File。spill 失败时保留 bounded preview 和明确 `full_output_unavailable`，不能谎称完整结果已保存。

### P1. Event-derived projections

**Classification: adapt after the execution ledger.**

DeepSeek 的 projection unit 是 `init + pure apply + view + stateVersion`，从一个 committed-event subscription 派生 whole-value snapshots，并用 shared watermark 保证一致 cut。[Session projections](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session-projection.md#L9-L99)

ScopeGuard 可用相同数学模型派生 Conversation list status、Run status、pending approval、usage、Artifact publication state。Renderer 只消费 `{asOfSequence, values}`；未知 projection key 表示能力缺失，不投影成 empty/healthy。先实现纯 fold，再考虑 SQLite checkpoint cache，避免在 V1 初期引入双重事实源。

### P1. Auditable compaction and tool-result pruning

**Classification: adapt to ScopeGuard's Active Context Projection.**

DeepSeek 会保留原 durable events，并用 compaction start/end、summary 和 replacement surface 表达压缩；边界必须保持 tool call/result 成对，失败 attempt 也可见。[Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/compaction.md#L9-L90)

ScopeGuard 应只借鉴：token pressure、成对边界、事务括号、失败可见、tool-result head/middle/tail pruning。摘要应成为版本化 Active Context Projection material，记录覆盖的 Transcript sequence range、生成 Model/config、输入 hashes 和 source links；不得删除或替换 Conversation Transcript。

### P1. Loop and lifecycle guards

**Classification: adapt selectively.**

- 精确 `(tool name, canonical arguments)` 重复调用检测；read 可以 advisory，重复 side effect 应升级为新 approval 或 deny。DeepSeek 的实现是 advisory，并明确不阻止合法 polling。[Repeat tool reminder](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/guard/repeat-tool-reminder/README.md#L1-L45)
- 每个可执行 capability 必须有异步 disposer；shutdown 必须 `request stop -> await quiescence`，不能只发 kill。callback 异常必须在 dispatcher 内隔离。[Defensive patterns](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/defensive-patterns.md#L15-L31)
- 对关键跨模块关系增加 package-owned runtime invariant，例如“所有 model-visible message 都有 durable source”、“terminal Run 不含 pending tool”、“published Artifact Version 引用 terminal producing attempt”。不要引入 Cordis invariant registry本身。[Runtime invariants](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/invariants.md#L1-L65)

### P2. Member feedback sidecar

**Classification: useful, but defer beyond the core V1 gate.**

DeepSeek 为 assistant message 提供 positive/negative、note、host timestamps 和 optimistic CAS version；它与 immutable Session feedback event 分离。[Message feedback](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/feedback.md#L1-L36)

ScopeGuard 可在企业 pilot 后加入，但必须补齐上游没有的边界：authenticated Member identity、Organization retention/export policy、Conversation ownership 检查、删除语义和“默认不外发”。反馈不自动进入 Agent context，不自动上传，也不等同于自动评测或训练许可。

## Explicit rejections

| Upstream capability | Decision | Reason |
| --- | --- | --- |
| Cordis / Everything is a Plugin | Reject | 扩大可信计算基，弱化 Local Core 明确所有权，并让动态代码更难受 Agent Policy 与 Managed Execution 约束。[Cordis model](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cordis-primer.md#L7-L44) |
| Whole DeepSeek Harness, upstream `packages/` graph or `dsh` dependency | Reject | 不引入固定快照中 `packages/` 树的 226 个 package manifests；它与 Native Harness、Pi-derived protocol kernel 和 external-Harness non-goal 重叠，且 developer preview API 不稳定。[Pinned packages tree](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages) |
| DeepSeek Web UI, headless runner, Python SDK | Reject | ScopeGuard 已有 Windows-first Electron Desktop、Desktop Contract 和 Local Core composition root。[CLI surfaces](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/README.md#L5-L16) [Python SDK](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/README.md#L5-L16) |
| Windows ACL restricted-token runner | Reject as acceptance runner | 只提供 partial write restriction，不满足 Issue #14 的 read/network/process/IPC/credential matrix。 |
| DeepSeek Session as ScopeGuard domain | Reject | 会混淆 Transcript、Active Context Projection、Run 和 Artifact Version 的现有领域边界。 |
| Context-wide session-query | Reject for V1 | 上游服务假设 trusted caller，无 Member/Workspace authorization；ScopeGuard 禁止隐式跨 Conversation history。[Session query limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session-query/session-query-sqlite/README.md#L52-L57) |
| Dynamic self-modifying plugins / Code Mode | Reject | `node:vm`/worker containment 不是 OS security boundary，会扩大模型可修改 runtime 的 authority。[Dynamic runner boundary](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/extensions/cordis-host-runner/README.md#L26-L40) [Worker boundary](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/code-runtime/code-runtime-worker-thread/README.md#L5-L31) |
| Session/feedback telemetry export | Reject for V1 | 上游 exporter 可包含 prompt、tool arguments/results、file content、command output 和 cwd；ScopeGuard 默认不外发这些数据。[OTel limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/session/session-telemetry-otel/README.md#L34-L42) |
| Subagent/workflow/schedule surface | Reject for V1 | 与 bounded Agent Dispatch、无 unattended Agent、无 unbounded recursive orchestration 的既定范围冲突；上游这些能力也明确有 process-local 或无独立 evaluator 等限制。[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/README.md#L5-L32) [Workflow limitations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/tool-ralph/README.md#L86-L93) |

## Recommended delivery slices

### Slice A: replayable Native Harness contract

1. 定义 target `RunExecutionEvent` vocabulary 和 exact request manifest。
2. 在新 V1 SQLite schema 中 append events；未知 required event 失败关闭。
3. 持久化 normalized usage，不再丢弃 `onUsage`。
4. 建立 keyless replay fixture，覆盖 text/tool/approval/cancel/malformed stream。
5. 加入 model-visible reconstructability invariant。

Exit: 同一 fixture 可从空库运行、持久、重启并重建完全相同的 model-visible request 与 terminal projection。

### Slice B: governed effect pipeline

1. 将 parse/validation/policy/approval/guard/execute/result 从 Native Harness 中抽到 Capability Runtime。
2. 引入 immutable invocation hash、monotonic guards 和 exclusive-by-default。
3. 在 `tool_started` 后崩溃 fixture 中产生 `effect_unknown`。
4. 把 sandbox capability truth/failure taxonomy 加入 Issue #14 prototype harness。
5. 加入 private spill，替代静默丢弃大输出。

Exit: 任一调用都能证明 exact input、有效 authority、执行边界、结果完整性或明确 unknown/unavailable。

### Slice C: context pressure and read models

1. 用 usage + conservative estimate 计算 request pressure。
2. 为 Active Context Projection 增加可审计 rebuild/compaction transaction。
3. 用 pure projections 派生 UI 状态并携带 watermark。
4. 再评估 feedback sidecar；不把 telemetry 或 session-query 偷渡进 V1。

## Final recommendation

DeepSeek Harness 对 ScopeGuard 的价值是**实现模式验证**，不是产品集成：

- 它验证了 append-only execution facts、单调策略、失败关闭和 replay testing 可以在大型 Harness 中落地；
- 它也展示了“高度可扩展”带来的可信计算基、权限和供应链成本；
- 它的 Windows sandbox 文档提供了很好的诚实边界，但恰好证明 ScopeGuard 不能降低自己的安全验收标准。

因此建议先交付 Slice A，再将 Slice B 的 sandbox 部分并入 Issue #14 原型。不要创建 DeepSeek adapter、不要安装 `dsh`、不要增加 Cordis，除非未来有独立 ADR 明确推翻现有 Native Harness 和 Local Core 决策。
