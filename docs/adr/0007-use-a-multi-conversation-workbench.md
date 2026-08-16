# Use a multi-Conversation workbench instead of tabs

The Desktop will use a Codex-like Workspace and Conversation sidebar together
with a central Conversation Workbench that can keep one to four Conversations
visible and running in parallel. Each Conversation occupies an independently
resizable pane with its bound Agent, Model, status, transcript, and composer;
opening or focusing another Conversation does not replace the other panes.
Pane layout is remembered per Workspace, closing a pane does not delete its
Conversation, and narrow layouts preserve a readable minimum pane width through
horizontal overflow. This deliberately rejects a conventional tab strip because
cross-Agent comparison, manual transfer, and explicit Handoff require users to
see source and destination Conversations at the same time.
