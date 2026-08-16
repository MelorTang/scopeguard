# UI Redesign Handoff: Codex-Style Desktop UI

Date: 2026-08-15
Scope: `apps/desktop/src/renderer` only. No main-process, IPC, or domain changes
except the ones explicitly listed below.

## Goal

Move the desktop UI from a "console" look toward the Codex desktop workbench
feel, while keeping the information architecture and the acceptance gates in
`docs/V2_UI_SPEC.md` intact. The product remains local-first, Chinese-language,
task-oriented by default.

## What Was Done

### 1. Design tokens and composer (Codex visual language)

- `styles.css` `:root`: warm neutral palette (`--sidebar: #f0efe9`,
  `--border: #e4e4de`), radius scale `--radius-s/m/l`, `--ink` near-black for
  primary actions (accent green kept for status/semantic use only).
- Composer rebuilt as a large card: 16 px radius, soft layered shadow
  (`--shadow-card`), border-darken focus (no green glow), pill-shaped toolbar
  buttons with borders, circular 32 px send/stop button (`ArrowUp` icon,
  `--ink` background, muted when disabled).
- User message bubble: borderless, 18 px radius, `--surface-muted`.
- Empty thread state: `.thread-pane--empty` hides the conversation area and
  vertically centers the composer with a greeting (agent name + hint), the
  Codex new-task layout. Implemented in `ThreadPane.tsx` + CSS grid rows.

### 2. Message flow

- Role labels ("你 / AGENT / 工具") removed; user bubbles right-aligned,
  assistant text full-width unframed.
- Tool calls render as compact expandable `<details class="tool-call">` rows:
  chevron + icon + tool name + mono argument summary + 完成/失败 status.
- Tool results are paired into their call row via `toolCallId`; orphan results
  (no matching call) fall back to the legacy flat `.tool-result` row.
- Expansion shows result output for everyone; raw argument JSON additionally
  in professional mode. Deliberate deviation from the spec's
  "professional mode reveals tool details": user-initiated expansion is
  allowed in default mode (Codex parity). Revisit if the spec is enforced.
- `summarizeArguments` also extracts `question` (request_user_input) besides
  `command`/`path`.

### 3. Navigation slimming

- `WorkspaceToolbar.tsx` rewritten: the 4 segmented pane buttons collapsed
  into a single layout dropdown (`toolbar-menu`, `menuitemradio`), toolbar
  reduced to 3 controls (新建任务 / 布局 / 侧边面板), background white, no
  separator line.
- Sidebar task status icons replaced with 7 px dots: running = blue pulsing,
  waiting = amber, failed/cancelling = red; approval count badge and
  completed check kept. Reduced-motion media query disables the pulse.
- "新建任务" added as the primary sidebar action under the brand row
  (`sidebar-new-task`, SquarePen icon); duplicate tree-bottom entry removed.

### 4. Dark mode

- Follows `prefers-color-scheme`; `color-scheme: light/dark` set on `:root`.
- All hardcoded colors parametrized first: `--ink-contrast`, `--amber-border`,
  `--red-border`, `--backdrop`, `--sidebar-hover`, `--sidebar-active`,
  `--shadow-card`, `--shadow-card-focus`.
- Dark token set appended at the end of `styles.css` (warm near-black,
  brightened semantic colors, white primary buttons with dark text).
- Fixed regression found via screenshots: sidebar selected/hover rows used
  white-alpha backgrounds that broke contrast in dark mode.

### 5. Dialogs

- All modals share `Modal.tsx`; CSS-only restyle: 16 px card radius, softer
  border, 14 px/650 title, taller header, 10 px input radius, 38 px inputs,
  13 px font, label weight 700→600, deeper dark-mode backdrop.

### 6. Issue #19 (layout menu keyboard support)

- Esc closes the layout menu and returns focus to the trigger (with
  `stopPropagation`); ArrowUp/ArrowDown cycle focus across enabled items
  (`:not([disabled])`); focus moves to the current layout on open; selecting
  an item also restores focus to the trigger.
- Gotcha: `maxSplitCount` (`useWorkspace.ts:291`) is
  `min(width-based limit, openThreadCount)` — with one open task only
  "单窗格" is enabled. Tests must open two tasks first.

### 7. Provider presets

- `ProviderDialog.tsx`: creating a new 模型服务 now shows a
  `.provider-presets` card grid (OpenAI / Anthropic / DeepSeek / Kimi /
  通义千问 / 自定义中转) above the form. Picking a card prefills 服务名称,
  接口协议 (Anthropic switches the segmented control), 接口地址 and 模型, so
  the user only types an API key. 自定义中转 keeps the form blank.
- All fields stay editable after prefill; the API key placeholder follows the
  preset (`sk-…`, `sk-ant-…`), and presets hide when editing an existing
  service. Pure renderer change; no IPC or domain edits.
- Verified by `verify-provider-presets.mjs` (10/10): preset list, autofill,
  protocol switch, editable fields, save-with-only-key, dark mode.
- Gotcha: clicking 添加模型服务 and then a preset card in the same CDP
  `Runtime.evaluate` fails — React has not re-rendered yet. Split into two
  evaluates with a sleep between.

### 8. Artifact export (Manual Delivery) — frontend done, IPC pending

- `Inspector.tsx` artifact detail header now has 复制 / 另存为 next to 发布
  (only for text artifacts with `content`, same condition as 发布).
- 复制: `navigator.clipboard.writeText(content)`, notice 已复制到剪贴板。
- 另存为: calls `exportArtifact()` from `bridge.ts`, which probes for an
  optional `window.scopeguardDesktop.exportArtifact` method. If present it is
  used; in the web preview it falls back to a Blob/`a[download]` browser
  download; on a desktop build without the IPC it surfaces
  "当前主程序版本还不支持另存为".
- `bridge.ts` also exports `artifactFileName(title, mimeType)` (sanitized
  title + extension from a small mime map, default `.txt`).
- Verified by `verify-artifact-export.mjs` (7/7): run a task to completion,
  artifact appears, buttons render, clipboard payload matches, preview
  download fallback notice.

**Main-process ask (for GPT):** add an `exportArtifact` IPC —
input `{ title: string; content: string; mimeType: string }`,
result `{ saved: boolean; filePath?: string }` (`saved: false` = user
canceled the dialog). Implementation: `dialog.showSaveDialog` with
`defaultPath` = sanitized title + extension, then write UTF-8 content.
Renderer already calls it when present; no further renderer change needed.

- Gotcha: headless CDP shells deny `clipboard-write` and
  `Browser.setPermission` rejects the clipboard descriptor — stub
  `navigator.clipboard.writeText` in verify scripts instead.

## Verification Setup (no new dependencies)

- Type check: `pnpm --filter @scopeguard/desktop exec tsc -p tsconfig.renderer.json --noEmit`
- Visual/interaction: `pnpm --filter @scopeguard/desktop dev:web`, then drive
  the cached Playwright headless shell over CDP (Node's built-in WebSocket,
  no npm deps):
  `~/Library/Caches/ms-playwright/chromium_headless_shell-1228/.../chrome-headless-shell --headless --remote-debugging-port=9223 about:blank`
- Scripts live in `output/ui-audit-codex/` (`drive*.mjs` for screenshots,
  `verify-issue-19.mjs` for the keyboard acceptance checks, 10/10 passing).
- Mock bridge tricks: `/approve-command` triggers a tool approval flow,
  `/ask-input` triggers waiting-input; mock state resets on reload.

## Open Follow-ups (priority order)

1. ~~Provider presets~~ Done (see §7).
2. ~~Artifact export / Manual Delivery (save-as, copy)~~ Frontend done (see
   §8); waiting on the main-process save-dialog IPC described there.
3. Desktop notifications for approval/completion/failure — small main-process
   addition plus renderer event hookup.
4. Schedule (定时任务) UI — contract exists end-to-end except execution
   scheduling (backend) and any UI (sidebar slot reserved under 新建任务).
5. Workspace file browser panel; MCP/Skill read-only settings lists.
6. First-run guided setup (workspace → provider → agent in one card).
7. Global search, keyboard shortcuts (Cmd+N/Cmd+K/Cmd+1-4), message-list
   virtualization for very long threads.

## Conventions to Keep

- Terms per `docs/V2_UI_SPEC.md`: 工作区 / Agent / 任务 / 成果 / 上下文 /
  交接 / 运行节点; `Project`/`AgentProfile`/`Thread` are internal only.
- Desktop layout acceptance table and accessibility rules in the spec remain
  the regression baseline; re-verify at 1024x720 and 1920x1080 after layout
  changes.
