# ScopeGuard v2 Desktop UI

## Main Window

```text
Native title bar
Project sidebar: Project -> Agent Threads
Open Thread tab strip
Split workbench: one to four Thread panes
Context and activity inspector
Global Run and approval status
```

Tabs and split panes are view state only. Closing a tab does not archive its
Thread or stop its Run. Pending approvals appear in the Thread, tab, sidebar,
and global Run center without blocking unrelated work.

## Default And Technical Detail Modes

Default mode presents native API agents, natural-language goals, summarized
tool activity, project files, and results. Provider setup still exposes
protocol, base URL, API key, and model.

Technical details progressively reveal model/runtime identity, local CLI
configuration, terminal output, command arguments, and raw tool events. It
does not bypass the same permission engine. Custom Provider headers and
persisted CLI environment variables are deliberately unavailable until they
can use the encrypted SecretVault.

## Required States

- No Project, no Provider, and no Thread each have one primary recovery action.
- Loading longer than 300 ms uses dimensionally stable skeletons.
- Running keeps streaming output and Stop visible while other panes remain usable.
- Waiting for approval never opens an application-wide blocking modal.
- Interrupted preserves partial output and offers retry.
- Authentication, rate-limit, endpoint, and tool errors provide an action at
  the failure location.
- Restart restores tabs, split layout, drafts, history, and interrupted state.
- Stale context shows the newer revision and never silently changes a Run.

## Desktop Layout Acceptance

| Window | Required layout |
| --- | --- |
| 1024 x 720 | One pane; collapsible sidebar; overlay inspector |
| 1280 x 800 | Two panes, each at least 430 px |
| 1440 x 900 | Two panes plus a 320 px inspector |
| 1600 x 900 | Three panes with inspector closed |
| 1920 x 1080 | Four panes, each at least 400 px |

When the minimum pane width cannot be maintained, the app reduces the visible
split count instead of shrinking text or adding whole-window horizontal
scrolling. The tab strip, Thread header, approval state, and composer remain
operable at 720 px height and 150% display scaling.
