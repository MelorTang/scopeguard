# Share live Workspaces with conflict detection

Conversations in one Workspace will operate on the same live local directory
rather than receiving isolated copies. Reads and writes to different files may
run concurrently, but every editable read records a file version hash and a
write must stop if the current file no longer matches that version. Writes use
a temporary file and atomic replacement, and ScopeGuard will not silently merge
or overwrite conflicts; the Member chooses whether to reread, save a separate
version, or abandon the change. Office revisions continue to create new
Artifact Versions by default. Git worktrees may be offered to advanced users
but are not required for ordinary Workspaces.
