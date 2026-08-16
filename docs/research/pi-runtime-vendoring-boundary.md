# Pi runtime 源码内嵌边界研究

- 状态：建议采纳
- 研究日期：2026-08-13
- 对应议题：[研究：确定 Pi 源码内嵌边界 #6](https://github.com/MelorTang/scopeguard/issues/6)
- 上游仓库：[earendil-works/pi](https://github.com/earendil-works/pi)
- 固定提交：[`46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106`](https://github.com/earendil-works/pi/commit/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106)（2026-08-13）
- 上游包版本：`@mariozechner/pi-ai` / `@mariozechner/pi-agent` `0.84.1`

## 结论

ScopeGuard 不应复制整个 `packages/ai`、整个 `packages/agent`，也不应原样复制三个目标 provider 文件。推荐边界是 **Pi 派生的协议内核 + ScopeGuard 自有运行时外壳**：

1. 从固定提交中选择性派生 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 的消息投影和流事件状态机。
2. 派生 Pi 的有限请求重试规则、工具调用 ID 归一化，以及“截断调用不得执行”等最小 loop 安全不变量。
3. 继续使用 ScopeGuard 自有的 `fetch`、SSE、provider 接口、权限、审批、持久化、取消和 agent loop；新增严格、无强制类型转换的工具参数校验。
4. 不引入 `@mariozechner/pi-ai`、`@mariozechner/pi-agent`、OpenAI SDK、Anthropic SDK、TypeBox、`partial-json` 或 Pi telemetry 作为运行时依赖。

这是 ADR 0006 所要求的“固定版本、选择性内嵌”，不是重新引入外部 Pi runtime。它同时遵守 ADR 0013：协议由管理员显式选择，适配器不得根据 URL、模型名或 provider 名猜测协议。

## 决策约束

本研究把以下本地文档视为既定边界，而不是重新讨论的选项：

- [`CONTEXT.md`](../../CONTEXT.md)：ScopeGuard 拥有 Workspace、Conversation、Active Context Projection、权限、effects 和持久化；provider 只是显式配置的模型端点。
- [ADR 0006](../adr/0006-vendor-selected-pi-runtime-source.md)：固定并保留 Pi 的 provider 协议、流式处理、工具调用归一化和最小 loop；排除 Pi CLI/TUI、session/memory、coding tools、OAuth 和应用配置。
- [ADR 0013](../adr/0013-configure-providers-explicitly.md)：V1 只支持显式的 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages，不做 URL 推断、任意模型发现、个人 OAuth、路由或故障转移。
- [Agent/context 对比](./agent-context-model-comparison.md)：Pi 的会话/上下文所有权不得渗入 ScopeGuard；当前 Pi AgentHarness 仍是 scaffold，而不是可直接采用的新 runtime。固定提交的 [agent changelog 也把 harness 标为未完成](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/CHANGELOG.md#L23-L35)，相关方法会抛出 [`HarnessNotImplemented`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/src/harness/agent-harness.ts#L74-L80)。

## 来源与快照说明

结论只使用以下主要来源：固定提交中的源码、包清单、lockfile、测试和 changelog，以及 OpenAI、Anthropic、Electron 官方文档。未使用博客、第三方教程或非官方兼容实现。

固定提交的 `packages/ai/package.json` 仍声明 `0.84.1`，但其 [changelog 的 `Unreleased` 段](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/CHANGELOG.md#L3-L16) 已包含 Responses deferred tools、严格 schema 转换和 tool namespace 修复。因此更新时必须比较 **提交 SHA 和源码 diff**，不能只比较 npm 版本。

Pi 根许可证是 MIT，版权为 Mario Zechner；许可证要求在软件的重要复制部分保留版权和许可声明，见固定提交的 [`LICENSE` L1-L21](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/LICENSE#L1-L21)。任何 Pi 派生文件都必须保留来源标记，vendored tree 中必须包含该许可证全文。

## 最小行为边界

### OpenAI Responses

需要保留的行为：

- 用 `output_index` 管理并发输出项，分别累计 text、reasoning 和 `function_call`。
- 同时保留 Responses 的 `call_id` 和 item `id`，形成可逆、opaque 的 ScopeGuard tool-call ID；回放 `function_call_output` 时恢复 `call_id`。
- 只在 `response.completed` 后视为成功；`response.incomplete` 映射为 `length` 或 error 且不得执行未完整的 tool call，`response.failed`、错误事件或无终止事件 EOF 必须失败关闭。
- 流中只累计参数字符串；ScopeGuard V1 在参数完成后才发出归一化 tool call，不执行 partial JSON。
- 请求显式设置 `stream: true`、`store: false`、`background: false`，并透传 `AbortSignal`。

Pi 的核心依据是 [`openai-responses-shared.ts` L432-L760](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-responses-shared.ts#L432-L760) 的流状态机和 [`L138-L431`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-responses-shared.ts#L138-L431) 的消息转换。请求生命周期参考 [`openai-responses.ts` L102-L195](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-responses.ts#L102-L195)，但不复制 SDK client 构造。

OpenAI 官方 [Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming) 把 text、output item 和 function-call arguments 定义为带 `output_index`/item ID 的独立 delta/done 事件；这一协议结构是状态机的外部权威，Pi 行为只作为经过实战的实现参考。

必须删除该文件中的 URL/provider 推断和环境变量缓存策略（[`openai-responses.ts` L49-L77](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-responses.ts#L49-L77)），也不得复制 GitHub Copilot/session affinity 和 `dangerouslyAllowBrowser` client 配置（[`L214-L255`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-responses.ts#L214-L255)）。

### OpenAI Chat Completions

需要保留的行为：

- 以 tool call 的数组 `index` 作为流内主键；provider 缺失或改变 ID 时，仍不得把两个调用拼错。
- 累计 `delta.tool_calls[].function.arguments`，在终止时严格解析；空的 provider 扩展对象不应制造调用。
- 映射 `finish_reason`，且 EOF 时没有终止 reason 必须失败关闭。
- 正确回放 assistant tool calls 和 tool results；provider ID 只作为 opaque 协议数据，不作为权限依据。
- 请求显式设置 `stream: true`，不复制 URL 兼容矩阵或按模型名猜测 reasoning/cache 能力。

Pi 的可采用部分是 [`openai-completions.ts` L201-L615](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-completions.ts#L201-L615) 的标准 chunk 状态机，以及 [`L1047-L1244`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-completions.ts#L1047-L1244) 的标准消息/tool 转换。文件尾部 [`L1439-L1577`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/openai-completions.ts#L1439-L1577) 是 URL、provider 和兼容能力推断，必须排除。

OpenAI 官方 Chat 文档把流式工具参数作为 delta 发送，并明确指出模型生成的参数可能无效、执行函数前必须校验；ScopeGuard 因而不能把 provider strict mode 当成执行信任边界。参见官方 [Chat streaming response](https://developers.openai.com/api/reference/resources/chat) 和 [function calling strict mode / streaming](https://developers.openai.com/api/docs/guides/function-calling)。

### Anthropic Messages

需要保留的行为：

- 解析标准 SSE，并按 `message_start`、content block start/delta/stop、`message_delta`、`message_stop` 的顺序维护状态。
- 支持 text、thinking/redacted thinking 和 `tool_use`；tool input 只在完整 content block 结束后解析和校验。
- 忽略未知的未来事件类型，但不把未知事件当作成功终止。
- `event:error`、中途断流或无 `message_stop` EOF 必须失败关闭。
- 连续 tool results 合并为合法的 Anthropic user turn；仅在 wire projection 中合成缺失结果，合成内容不得写回 ScopeGuard canonical transcript。

Pi 的可采用部分是事件状态机（[`anthropic-messages.ts` L570-L770](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/anthropic-messages.ts#L570-L770)）以及消息和 tools 转换（[`L1116-L1323`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/anthropic-messages.ts#L1116-L1323)）。其自定义 SSE decoder（[`L295-L485`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/anthropic-messages.ts#L295-L485)）只作为差异测试依据，不进入 vendored manifest；ScopeGuard 复用现有标准 SSE framing。跨模型 thought signature、tool ID 和孤立 tool result 的投影规则来自 [`transform-messages.ts` L59-L220](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/transform-messages.ts#L59-L220)。

Anthropic 官方说明流中可能新增事件、tool input 以 `input_json_delta` 逐段到达，并给出了完整事件顺序；参见 [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)。

## 工具调用归一化与校验

工具调用必须经过以下顺序，不能把“解析成功”和“允许执行”混为一件事：

1. 协议适配器累计原始参数，完整结束后执行严格 `JSON.parse`。
2. 用当前 ScopeGuard ToolRegistry 中同名 tool 的 `inputSchema` 校验，不认识的 tool 生成失败的 tool result，不调用任何 effect。
3. 校验必须 fail closed：不把 `null` 转成 `0`/`false`/空字符串，不把字符串转数字，不删除未知字段来“修复”输入。
4. 参数校验通过后才进入现有 allow/ask/deny、用户批准和 `tool.execute`。
5. 任何 hook 或批准步骤若改变参数，必须重新校验最终执行参数。
6. `finish_reason=length` / `stopReason=length` 下产生的所有 tool calls 都视为截断，不执行；返回错误结果，让模型在下一轮重新发出完整调用。

Pi 的 [`validation.ts` L295-L350](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/utils/validation.ts#L295-L350) 会在校验前调用 coercion；其测试明确接受字符串转数字和其他强制转换（[`validation.test.ts` L64-L99](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/validation.test.ts#L64-L99)）。这不适合作为 ScopeGuard effect boundary，因此 `validation.ts` 和 TypeBox Compile 均不 vendoring。ScopeGuard 应用自己的 JSON Schema validator；provider 的 strict schema 只是降低无效参数概率。

Pi 的 strict schema 转换（[`constrained-sampling.ts` L12-L130](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/api/constrained-sampling.ts#L12-L130)）可作为 provider wire schema 的参考，但 V1 不复制 grammar/deferred-tool 机制。发送给 OpenAI 的 strict schema 可以在适配器中做无副作用转换；执行侧仍对原始 ScopeGuard schema 重新校验。

## 取消和重试

### 取消

- 同一个 `AbortSignal` 必须贯穿 `fetch`、stream reader、retry sleep、agent loop 和 tool execution。
- 取消后立即停止读取并释放 reader；已开始的响应不得自动重试。
- 每个 tool 调用前和调用间再次检查 signal。取消中的 tool result 标记为 cancelled，不伪装成成功或空结果。
- Responses V1 固定 `background: false`，因此 HTTP abort 是唯一 provider 取消动作；不得留下后台 response。
- renderer 不持有 provider key，也不直接建立 provider 请求；取消由 renderer 通过 IPC 请求可信 runtime 执行。

### 重试

Pi 的有限 HTTP 策略可从 [`provider-retry.ts` L22-L125](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/utils/provider-retry.ts#L22-L125) 派生：仅重试连接阶段错误、408、409、429、5xx 或明确的 `x-should-retry: true`；尊重 `retry-after-ms` / `retry-after`，延迟上限 60 秒，并使用可取消的指数退避。ScopeGuard 必须显式配置最大次数，建议默认 2 次重试，不能依赖 SDK 默认值。

边界条件：

- 401、403、404、422 等确定性配置/请求错误不重试；`x-should-retry: false` 优先。
- 收到任何 text/tool delta 后，断流只返回失败，不自动重放整轮。否则可能重复展示文本或重复 effectful tool call。
- tool 已进入 ask/allow/execute 后，provider 重试器不得介入。
- 不复制 Pi 的整轮字符串错误分类重试器 [`utils/retry.ts` L145-L227](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/utils/retry.ts#L145-L227)。如未来需要整轮重试，必须由 ScopeGuard 在“尚无可见 delta、尚无批准、尚无 tool effect”的事务边界显式实现。

Anthropic 官方错误文档说明 SDK 默认重试两次、尊重 `retry-after`，也说明 SSE 在 HTTP 200 后仍可能产生错误；这正是“建连前可重试、流开始后失败关闭”的依据，见 [Anthropic Errors](https://platform.claude.com/docs/en/api/errors)。

## 最小 agent loop

ScopeGuard 已有 `NativeAgentRuntime`，包含 provider 轮次、权限/批准、持久化、取消和最大轮数。完整复制 Pi [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/src/agent-loop.ts) 会重复所有权并带入 steering、follow-up、context transform 和 Pi event/type 体系。

只派生以下安全不变量：

- provider tool call 先完整解析、查找 tool、严格校验，再进入批准和执行。
- `length` 截断时不执行任何 tool call；Pi 的实现见 [`agent-loop.ts` L374-L405](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/src/agent-loop.ts#L374-L405)，对应测试见 [`agent-loop.test.ts` L371-L442](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/test/agent-loop.test.ts#L371-L442)。
- 未知 tool 和无效参数转成确定性 error result，供模型下一轮修正，不执行副作用。
- 每个 tool 前后检查取消；V1 可以顺序执行。若未来并行执行，返回结果必须保持原 tool-call 顺序；Pi 参考实现见 [`agent-loop.ts` L411-L554](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/src/agent-loop.ts#L411-L554)。
- tool results 追加到 ScopeGuard Conversation，再开始下一次 provider call；Pi 的 steering/follow-up/session 队列不得成为 canonical state。

不复制 Pi 的完整 `agent-loop.ts`、`types.ts` 或 `stream-fn.ts`。建议只建立一个无状态 `tool-call-guards.ts`，返回 validated execution plan 或错误结果，由现有 `NativeAgentRuntime` 调用。

## 上游测试移植基线

| 上游测试 | 证明的行为 | ScopeGuard 处理 |
| --- | --- | --- |
| [`openai-responses-terminal-event.test.ts` L206-L239](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/openai-responses-terminal-event.test.ts#L206-L239) | Responses 提前 EOF 必须成为 error result | 直接移植为 adapter contract test |
| [`openai-responses-partial-json-cleanup.test.ts` L67-L105](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/openai-responses-partial-json-cleanup.test.ts#L67-L105) | 完成后的 tool call 只能包含最终参数，不持久化流式 scratch state | 移植最终状态断言；ScopeGuard V1 不产生结构化 partial args |
| [`openai-completions-tool-choice.test.ts` L645-L803](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/openai-completions-tool-choice.test.ts#L645-L803) | 忽略空扩展对象，并在 provider 改变 ID 时按稳定 index 合并 tool delta | 直接移植为 Chat contract fixtures |
| [`anthropic-sse-parsing.test.ts` L404-L423](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/anthropic-sse-parsing.test.ts#L404-L423) | `message_stop` 后的未知扩展事件不破坏已完成结果 | 直接移植，并增加 terminal 前未知事件 fixture |
| [`anthropic-sse-parsing.test.ts` L81-L167](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/anthropic-sse-parsing.test.ts#L81-L167) | Pi 会修复畸形 SSE JSON 和 tool JSON | **不移植修复预期**；官方协议之外的畸形 envelope/arguments 失败关闭，确保 effect 参数没有静默语义变化 |
| [`constrained-sampling.test.ts` L81-L146](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/constrained-sampling.test.ts#L81-L146) | strict wire schema 转换不改变输入 schema | 只移植 non-mutation 和 official strict-schema 子集；grammar cases 排除 |
| [`validation.test.ts` L64-L99](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/validation.test.ts#L64-L99) | Pi 有意进行参数 coercion | 作为负向 fixture：相同输入在 ScopeGuard 执行边界必须失败 |
| [`agent-loop.test.ts` L371-L442](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/test/agent-loop.test.ts#L371-L442) | length 截断的 tool call 不得执行 | 直接移植到 NativeAgentRuntime tests |

所有移植测试使用本地静态 HTTP/SSE fixtures，不依赖真实 API key。上游 live/provider-discovery/OAuth/model catalog 测试不进入 ScopeGuard suite。

## 依赖闭包

### 原样复制的代价

目标 Pi 文件并不是独立模块。三种 provider、消息转换、校验、重试和完整 agent loop 的直接源码闭包至少为 19 个文件、6,869 行，还没有计入庞大的公共 `types.ts`、`models.ts` 和 SDK 自身代码。其 package 依赖见 [`packages/ai/package.json` L62-L74](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/package.json#L62-L74) 和 [`packages/agent/package.json` L37-L43](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/package.json#L37-L43)。

### Pi 内部 import 闭包

| 根模块 | 原始直接/传递模块 | 处置 |
| --- | --- | --- |
| Responses | `models.ts`、`types.ts`、`deferred-tools.ts`、`error-body.ts`、`event-stream.ts`、`headers.ts`、`provider-env.ts`、`provider-retry.ts`、`constrained-sampling.ts`、Copilot headers、prompt cache、`simple-options.ts`、`transform-messages.ts`、hash/JSON/sanitize helpers、OpenAI SDK | 只派生 Responses state machine、message projection、ID/hash 规则和 retry 规则；其余改接 ScopeGuard types/fetch/SSE/error/redaction，或排除 |
| Chat Completions | `models.ts`、`types.ts`、error/event/header/JSON/env/retry/sanitize helpers、constrained sampling、Copilot headers、prompt cache、`simple-options.ts`、`transform-messages.ts`、OpenAI SDK | 只派生标准 Chat state machine 和标准 message/tool projection；排除 provider/model compatibility 分支和 SDK wrapper |
| Anthropic Messages | `models.ts`、`types.ts`、deferred tools、event/header/JSON/env/retry/sanitize helpers、constrained sampling、Copilot headers、`simple-options.ts`、`transform-messages.ts`、Anthropic SDK | 只派生 Messages state machine、message/tool projection 和必要的 wire normalization；复用 ScopeGuard SSE，不带 SDK/auth/cache/deferred logic |
| Pi agent loop | `@mariozechner/pi-ai` package root、agent events/types、`stream-fn.ts`、tool validation、telemetry/context hooks | 只派生 pure tool-call guards；继续调用 ScopeGuard ProviderAdapter、ToolRegistry、policy、persistence 和 cancellation |

该处置切断 `types.ts -> all provider API types/telemetry`、`models.ts -> generated models/auth stores` 和 package root re-export 三条扩张路径。vendored 模块不得重新 import 这些上游根模块。

### 外部包闭包

| 上游依赖 | 固定版本/许可证 | 传递依赖 | 本边界处理 |
| --- | --- | --- | --- |
| `openai` | `6.40.0`, Apache-2.0 | 无必需 runtime 依赖；`ws`、`zod` 为 optional peer，见 [lockfile L4164-L4180](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/package-lock.json#L4164-L4180) | 不引入；使用 ScopeGuard `fetch` |
| `@anthropic-ai/sdk` | `0.91.1`, MIT | `json-schema-to-ts`，后者再依赖 `@babel/runtime`、`ts-algebra`，见 [lockfile L55-L73](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/package-lock.json#L55-L73) 和 [L3560-L3571](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/package-lock.json#L3560-L3571) | 不引入；使用 ScopeGuard `fetch` + SSE |
| `partial-json` | `0.1.7`, MIT，无依赖，见 [lockfile L4211-L4215](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/package-lock.json#L4211-L4215) | 无 | V1 不引入；只累计 raw args，完成后严格解析 |
| `@sinclair/typebox` | `1.3.7`, MIT，无依赖，见 [lockfile L5017-L5021](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/package-lock.json#L5017-L5021) | 无 | 不引入；校验归 ScopeGuard effect boundary |
| `@mariozechner/pi-ai` / `pi-agent` | MIT | 上述 SDK，加 AWS、Google、OpenTelemetry、proxy-agent、telemetry、YAML 等 manifest 依赖 | 不作为依赖，不复制 package root |

推荐边界新增 **零个第三方 runtime 依赖**。Pi 派生模块只 import ScopeGuard 的 provider/domain 类型和 Web/Node 标准 API。若将来 UI 必须展示结构化的 partial tool arguments，可单独评审 `partial-json`; 该需求不能提前扩大 V1 边界。

## Node 与 Electron 约束

Pi 的 AI 和 agent 包都要求 Node `>=22.19.0`，见 [`packages/ai/package.json` L92-L94](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/package.json#L92-L94) 和 [`packages/agent/package.json` L59-L60](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/package.json#L59-L60)。ScopeGuard desktop 当前声明 Electron `^42.0.1`；Electron 官方 release 页面显示 42.0.1 捆绑 Node `24.15.0`，满足该下限，见 [Electron 42.0.1](https://releases.electronjs.org/release/v42.0.1)。

运行约束如下：

- vendored 代码保持 ESM，只在 Electron Main 监督的本地 Agent host 进程中运行，不得打入 Renderer bundle，也不得进入企业服务器。
- 只依赖 Node 22.19+ 已有的 `fetch`、`Headers`、`Response`、`ReadableStream`、`TextDecoder`、`AbortController`、`structuredClone` 和 `performance`。
- 本地 Agent host 的 Node 目标和 Electron Main 的 Node 版本都必须运行协议 contract tests；具体最低 Node 版本由最终 Desktop 打包架构固定。
- provider key 只从 ScopeGuard server-side secret store 注入 header；不得复制 `dangerouslyAllowBrowser` 或任何 renderer-side key 路径。
- 不使用 Node 专有 socket/SSE 包；本地 Agent host 与 Electron Main 通过同一受测协议内核工作。

## 遥测与数据外发

Pi 的公共 stream options 类型可以携带 `telemetryContext`、`onPayload` 和 `onResponse`，见 [`types.ts` L119-L145](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/types.ts#L119-L145)，而 `pi-agent` 也直接依赖 `pi-telemetry`。三个目标 provider 的低层流状态机本身没有主动遥测调用，但复制公共 types/package root 会把遥测能力带进边界。

ScopeGuard 处理：

- 完全排除 `packages/telemetry`、`telemetryContext` 和 Pi `onPayload`/`onResponse` hooks。
- vendored 模块不得创建额外网络连接、读取遥测环境变量或自动记录 request/response body。
- 观测由 ScopeGuard 在 provider adapter 外层拥有，只记录 provider 配置 ID、协议、模型 ID、状态、延迟、token usage 和已脱敏错误。
- system prompt、Active Context Projection、用户内容、tool arguments/results、API key 和原始 provider payload 默认不得进入日志/telemetry。

## 生成的模型数据

Pi 的 [`models.generated.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/src/models.generated.ts) 聚合大量 provider catalog；生成脚本 [`scripts/generate-models.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/scripts/generate-models.ts) 会抓取、合并并推断模型能力。`models.ts` 又加载 auth/model stores 和生成目录。

这些内容全部排除：

- 不 vendor `models.generated.ts`、provider model files、model-generation scripts 或 catalog refresh 任务。
- 不 vendor `models.ts`；价格、thinking level 和 provider capability 推断不属于协议内核。
- 模型 ID、显示名和 context limit 继续由管理员按 ADR 0013 显式配置并验证。
- 协议功能采用明确的 adapter capability flag；不得由 model ID 或 base URL 猜测。

## 必须排除的 Pi 模块

| 排除项 | 具体上游模块 | 原因 |
| --- | --- | --- |
| CLI/TUI 与应用入口 | `packages/coding-agent`、`packages/tui`、`packages/web-ui`、`packages/mom` | ScopeGuard 拥有 desktop/application UX；引入会扩大 effects 和配置面 |
| Pi session/context/memory | agent session、compaction、steering/follow-up、`packages/agent/src/harness/**` | Conversation、Active Context Projection、RAG、持久化归 ScopeGuard；harness 仍未完成 |
| coding tools/effects | shell、filesystem、edit、browser 等 Pi tools | 所有效果必须通过 ScopeGuard ToolRegistry、policy 和 approval |
| auth/OAuth | `oauth/**`、GitHub Copilot、Claude Code OAuth、Google/AWS auth helpers | ADR 0013 只允许 server-side key；不允许个人 OAuth |
| provider 自动发现/推断 | `provider-env.ts`、URL/model compatibility tables、provider registry | 协议和能力必须显式配置 |
| 全量 API 导出 | `packages/ai/src/index.ts`、`types.ts`、`models.ts` | 会拉入所有 provider、auth、generated models 和 telemetry types |
| 非目标 providers | Bedrock、Google、Azure、Mistral、xAI、Groq、Cerebras 等 adapters | 不在 V1 三协议范围 |
| prompt cache/deferred/grammar | `prompt-cache.ts`、`deferred-tools.ts`、grammar constrained sampling | 非 V1 必需，并带 provider 特例 |
| 全量校验器 | `validation.ts`、TypeBox compiler/coercion | effect boundary 必须无 coercion、fail closed |
| 全量 agent loop | `packages/agent/src/agent-loop.ts` 及其 event/type 层 | 与现有 NativeAgentRuntime 重叠；只派生安全不变量 |
| whole-turn heuristic retry | `packages/ai/src/utils/retry.ts` | 流开始或 tool effect 后重放有重复副作用风险 |
| telemetry | `packages/telemetry`、agent harness telemetry | 不需要，且扩大数据外发面 |
| generated model data | `models.generated.ts`、provider model data、generation scripts | 与管理员显式模型配置冲突 |

## Vendoring 与更小的自有实现比较

这里的比较不重新打开“是否使用外部 Pi runtime”的决定；两个可行方案都把代码构建进 ScopeGuard，并暴露 ScopeGuard 自己的接口。

| 方案 | 维护成本 | 上游修复可追踪性 | 依赖/边界风险 | 结论 |
| --- | --- | --- | --- | --- |
| 整文件/整包源码复制 | 至少 6,869 行目标闭包，且会继续拉入公共 types/models/SDK | 高，但 diff 噪声极大 | 认证、provider 推断、telemetry、generated data 很难彻底隔离 | 拒绝 |
| 纯自有协议实现 | 当前 ScopeGuard Chat + Anthropic + SSE + shared + loop 共约 1,364 行；新增 Responses 和校验即可 | 需人工对照上游测试/changelog | 零 Pi runtime 依赖，所有权最清晰 | 对 HTTP/SSE、校验和 loop 最合适 |
| **选择性 Pi 派生协议内核 + 自有外壳** | 只维护三种 wire state machine、投影、重试和 guards | 每个文件能映射到固定上游区间并做 differential review | 零新增第三方 runtime 依赖；ScopeGuard 所有权不变 | **推荐** |

维护成本真正显著降低的部分应采用 ScopeGuard 自有实现：

- HTTP client、headers、SSE framing、错误脱敏：仓库已有实现，复制 Pi 的 SDK wrapper 没有收益。
- JSON Schema validation：Pi 的 coercion 与 ScopeGuard effect safety 不一致，直接实现严格 validator 更短、更安全。
- minimal agent loop：仓库已有状态/权限/持久化语义，只需要少量 Pi-derived guards。
- generated models、capability inference：ADR 0013 已由显式配置替代。

“clean-room”在这里表示依据官方 API 文档和 ScopeGuard 契约编写的独立模块，不表示已经满足法律意义的隔离开发流程。本研究人员已阅读 Pi 源码；若未来需要主张法律意义的 clean-room，应由未接触 Pi 实现的独立人员依据公开协议规范实施和记录。推荐方案中的协议内核明确按 Pi 派生代码处理，保留 MIT 许可和来源，不作 clean-room 声明。

## 更新流程

1. 选择新的上游 SHA；记录旧/新 SHA、commit date、`pi-ai`/`pi-agent` manifest 版本和 `Unreleased` changelog。
2. 校验 `earendil-works/pi` 仓库来源以及新 SHA 的根 `LICENSE`；比较许可证内容和版权声明。
3. 只对 allowlist 路径执行 `git diff OLD_SHA..NEW_SHA -- <paths>`：三个目标 provider、`transform-messages.ts`、`provider-retry.ts`、`constrained-sampling.ts`、`validation.ts`、`agent-loop.ts` 及其相关测试/changelog。
4. 检查 `packages/ai/package.json`、`packages/agent/package.json` 和 lockfile 的依赖/许可证变化；新增依赖默认不进入 ScopeGuard。
5. 将适用变更手工移植到小型派生模块；每个模块更新来源 SHA、上游路径/区间和 ScopeGuard deviation。不要用新上游文件覆盖本地模块。
6. 更新 `third_party/pi/UPSTREAM.md` 的 extraction map 和 deviation ledger；许可证有变化时同步 `third_party/pi/LICENSE`。
7. 运行下方 contract、security、cancellation、retry、Electron/Node 和 exclusion 检查。只有测试通过且 reviewer 确认所有权边界未变化后才接受新 pin。
8. 使用三个显式配置的测试 endpoint 做 canary；不得做模型发现，不在 fixture/log 中保存真实 key 或 payload。

## Proposed vendored file/module manifest

以下是后续实现应创建的 **完整 vendored allowlist**；未列出的 Pi 文件都不得进入产品树。

```text
third_party/pi/
  LICENSE
    Exact MIT license from pi@46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106.
  UPSTREAM.md
    Pin, source URL/path/range map, extraction notes, dependency inventory,
    and a ledger of ScopeGuard deviations.

packages/provider-adapters/src/vendor/pi/
  openai-responses-wire.ts
    Pi-derived message projection and Responses streaming state machine.
    Sources: openai-responses-shared.ts L138-L790;
             openai-responses.ts L102-L195 (lifecycle only) and
             L286-L317 (allowlisted request fields only).
  openai-chat-wire.ts
    Pi-derived standard Chat message/tool projection and chunk state machine.
    Sources: openai-completions.ts L201-L615 and L1047-L1244.
  anthropic-messages-wire.ts
    Pi-derived Messages event state machine and message/tool projection.
    Sources: anthropic-messages.ts L570-L770 and L1116-L1352;
             transform-messages.ts L59-L220.
  provider-retry.ts
    Pi-derived HTTP status/header policy and abortable backoff.
    Source: utils/provider-retry.ts L22-L125.

packages/agent-runtime/src/vendor/pi/
  tool-call-guards.ts
    Pi-derived pure guards for truncated calls, unknown tools, validation
    ordering, cancellation checkpoints, and stable result ordering.
    Sources: agent-loop.ts L374-L554 and L600-L668.
```

这些文件必须只 import ScopeGuard domain/runtime interfaces 和标准 Web/Node API。`sse.ts`、HTTP request/error redaction、strict tool argument validator 和 `NativeAgentRuntime` 保持 ScopeGuard-owned，不放入 vendored 目录。每个派生文件顶部应注明固定 SHA、上游路径、MIT 许可证位置和本地 deviation；不得使用模糊的“基于 Pi”说明替代精确 provenance。

## Update test checklist

- [ ] 固定 SHA、commit date、package version、changelog 和 MIT license 均已记录，所有 Pi-derived 文件 provenance 可回到精确 blob/range。
- [ ] `git diff` 只覆盖 manifest 中的 allowlist；仓库中不存在未登记的 Pi 文件或 npm runtime dependency。
- [ ] OpenAI Responses：text/reasoning 多 output item 按 `output_index` 组合，`call_id`/item `id` 可逆回放。
- [ ] OpenAI Responses：function args delta/done 正确组合；`response.incomplete` 映射为 `length`/error 且不执行截断调用，`response.failed` 和无 terminal EOF 失败关闭。
- [ ] OpenAI Responses：请求固定 `store:false`、`background:false`，取消后不留下后台 response。
- [ ] OpenAI Chat：多个 tool calls 按数组 index 隔离；缺失/变化 ID、交错参数 delta 和空扩展对象不会串 call。
- [ ] OpenAI Chat：`finish_reason=tool_calls`、`stop`、`length`、`content_filter` 和 provider error 映射正确；无 finish reason EOF 失败关闭。
- [ ] Anthropic Messages：任意 byte chunk/CRLF 拆分、完整事件顺序、多个 content blocks、thinking 和 tool input delta 均正确。
- [ ] Anthropic Messages：未知未来事件可忽略；`event:error`、中途断流、无 `message_stop` EOF 均失败关闭。
- [ ] Anthropic wire projection：连续 tool results 合并；孤立结果的合成内容不写回 canonical Conversation。
- [ ] 工具参数只在完整结束后严格解析；malformed/truncated/非对象参数不得执行，也不得用 partial JSON 或 coercion 修复后执行。
- [ ] JSON Schema 校验覆盖 required、type、enum、array/object nesting、`additionalProperties:false`；`null`、数字字符串和未知字段失败关闭。
- [ ] 未知 tool 返回 error result；校验发生在 allow/ask/deny 和 execute 前；批准/hook 改写参数后会重新校验。
- [ ] 任一 `length` 截断的 tool call 均不执行，包含同一 assistant message 中看似完整的其他 call。
- [ ] 取消覆盖 fetch 前、retry sleep、stream 中、tool 前、tool 中和 tool 间；取消后无 provider retry、无后续 tool effect。
- [ ] 重试只覆盖连接阶段错误、408、409、429、5xx 和明确 retry header；401/403/404/422、`x-should-retry:false` 不重试。
- [ ] `retry-after-ms` / `retry-after`、60 秒 delay cap、指数退避、最大次数和 abort 均有确定性测试（参考上游 [`provider-retry.test.ts` L16-L80](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/ai/test/provider-retry.test.ts#L16-L80)）。
- [ ] 收到首个 stream delta 后的断流不会重放请求；已批准或执行 tool 后不存在 provider 自动重试路径。
- [ ] provider errors、SSE errors 和日志会脱敏 Authorization/API key；payload、prompt、context、tool args/results 不进入默认 telemetry。
- [ ] vendored tree 不包含 telemetry、OAuth/Copilot、provider-env、model catalog/generator、prompt cache、deferred tools、grammar、CLI/TUI/session/coding tools。
- [ ] `packages/provider-adapters` 和 `packages/agent-runtime` 的 dependency graph 无 OpenAI/Anthropic SDK、TypeBox、`partial-json`、Pi packages 或 OpenTelemetry。
- [ ] 最终固定的本地 Agent-host Node 目标和 Electron 42 Main build/contract tests 通过；Renderer bundle 与企业服务器均不含 vendored provider code 或 Provider secrets。
- [ ] 现有 provider redaction、terminal EOF、tool grouping、SSE chunk 和 NativeAgentRuntime approval/cancellation tests 保持通过。
- [ ] 三种协议只通过显式 provider protocol 选择；URL/model/provider 名变化不会切换协议或 capability。
- [ ] canary 只使用管理员显式配置的 endpoint/model，三种协议完成 text、stream、tool call、取消和可重试错误场景；fixture/log 中无真实凭据。
