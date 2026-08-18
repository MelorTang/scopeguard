# Workbench Prototype Findings

> Status: Historical prototype snapshot retained as current interaction input for the one-to-four Conversation workbench.

Snapshot: 2026-08-13. This note records the confirmed result for [原型：验证多 Conversation 工作台与 Artifact 检视](https://github.com/MelorTang/scopeguard/issues/3). The adaptive pane rule and the final prototype direction were accepted on 2026-08-13.

## Question

Can the Desktop keep one to four Conversations simultaneously visible while also supporting Handoff Prompt copying, Agent Dispatch, Artifact Review, and an unmanaged Workspace Terminal without repeating navigation or permanently crowding the center workspace?

## Baseline Finding

The current Renderer demonstrates that independent panes and composers work, but its permanent 320-pixel Inspector consumes too much horizontal space:

- at 1366 x 768, only two Conversation panes are available;
- at 1920 x 1080, only three Conversation panes are available;
- the current Web mock has only three Conversations, so four panes cannot be exercised;
- Task, Agent, Inbox, Context, Runtime, and Inspector surfaces repeat information that already belongs in Workspace/Conversation navigation or focused modes.

Baseline screenshots were captured in `output/playwright/` in the main worktree. They are test evidence, not committed product assets.

## Prototype

The throwaway prototype lives in the isolated `codex/workbench-prototype` worktree at:

```text
apps/desktop/src/renderer/prototypes/workbench-v1/
```

It keeps the left sidebar as Workspace -> Conversations and removes the permanent right Inspector. The center toolbar switches between Conversation Workbench and Artifact Review. It implements:

- one to four in-memory Conversations with independent headers, status, transcript, and composer;
- a structured Handoff Prompt block with one-click copy;
- Agent Dispatch to an already existing Conversation, with visible receipt in the target pane;
- Artifact Review as the full center canvas with version comparison and at most one associated Conversation;
- a temporary bottom Workspace Terminal that is hidden by default and outside Conversation state;
- one upper-right layout menu that combines visible Conversation count and arrangement mode;
- automatic arrangement by default, with equal-width and active-pane focus available as explicit overrides;
- a shared Codex-style composer in each Conversation and the associated Artifact Conversation: add content on the lower-left, per-Conversation access level, supported-model selection on the lower-right, and send;
- a Codex-style neutral dark theme across navigation, panes, menus, composers, and the terminal; document pages remain white for format fidelity.

Run the prototype with `pnpm dev:web` and open:

```text
http://127.0.0.1:5173/prototypes/workbench-v1/index.html
```

## Verification

The prototype passed its repository Renderer TypeScript check. Playwright exercised the copy, dispatch, mode-switch, associated-Conversation, terminal, and four-pane controls with zero browser console errors.

The composer pass additionally exercised Workspace attachment selection, all three access levels, supported-model switching, Enter-to-send, four-pane rendering, and the compact Artifact Conversation. These controls remained local to their Conversation and produced no document-level overflow or browser console errors.

The dark-theme pass verified the three-pane workbench, four-pane matrix, access menu, Artifact Review, and terminal at 1366 x 768. Main text, muted text, composer placeholder, and primary-action contrast were checked against their rendered surfaces; the page retained zero document-level overflow and zero browser console errors.

| Viewport and state | Result |
| --- | --- |
| 1366 x 768, three equal panes | All three transcripts and composers remain readable; no permanent right panel is required. |
| 1366 x 768, four-pane automatic layout | Four panes measure 576 x 360 pixels each in a two-by-two matrix; no document-level scroll or fixed-control overlap. Long content scrolls within its own pane. |
| 1440 x 900, active-pane focus | Usable, but narrowing the supporting panes makes cross-Agent comparison less stable and causes content to reflow when focus changes. |
| 1920 x 1080, four equal panes | Four full-height panes remain readable with independent composers. |
| 1366 x 768, Artifact Review | Document remains the primary center object; one 330-pixel associated Conversation is usable without a general Inspector. |
| 1366 x 768, terminal open | The 280-pixel temporary drawer covers only the lower center area; Conversation status remains visible above it. |

Automated geometry checks found:

- body `scrollWidth === clientWidth` and `scrollHeight === clientHeight`;
- no overflow in pane headers, composers, or layout controls;
- the upper-right layout menu does not intersect panes or composers;
- the layout control is absent in Artifact Review, where pane settings do not apply.

## Recommendation

Use a stable equal-pane layout for one to three Conversations. For four Conversations, adapt only by available center width:

- use four equal columns when the center workspace can provide at least 400 pixels per pane, normally a 1920-pixel display with the standard sidebar;
- otherwise use a two-by-two matrix so all four Conversations remain simultaneously visible;
- do not make active-pane focus the default because cross-Agent scanning becomes less predictable when pane widths move;
- remember pane count, visible Conversation IDs, pane order, active Conversation, and scroll/draft state per Workspace;
- switching to Artifact Review temporarily replaces the center layout and restores it exactly on return;
- opening the terminal is a temporary overlay and never creates, resizes, or rebinds a Conversation.

The product should expose one upper-right layout entry only. Its menu combines one-to-four visible Conversation selection with automatic, equal-width, and active-pane focus arrangements. Automatic is the default and applies the adaptive four-pane rule without adding a second control elsewhere on the screen.

## Final Decision

The recommendation is accepted. The V1 interaction contract must use the single layout entry, automatic four-pane adaptation, Codex-style Composer, neutral dark theme, focused Artifact Review, and temporary unmanaged terminal described above.
