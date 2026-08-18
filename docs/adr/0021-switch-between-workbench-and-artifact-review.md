# Switch between Workbench and Artifact Review

Status: Active; reaffirmed by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

The Desktop center will use two mutually exclusive spatial modes rather than
adding a permanent file inspector beside multiple Conversation panes. The
Conversation Workbench keeps one to four Conversations visible for parallel
coordination, while opening an Artifact switches the center to Artifact Review:
a large preview or version-comparison canvas with at most one collapsible,
Artifact-associated Conversation panel. Other Conversations continue running
and report status in the sidebar. Returning to the Workbench restores its pane
order and dimensions. V1 supports an in-window full-screen review but defers
detached Artifact windows.
