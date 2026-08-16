# Issue Tracker: GitHub

Issues, planning maps, and product specifications for this repository live as
GitHub Issues. Use the `gh` CLI from the repository checkout so the remote is
resolved automatically.

## Conventions

- Create an issue with `gh issue create --title "..." --body-file <file>`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List issues with `gh issue list`, requesting JSON fields when filtering is
  required.
- Comment with `gh issue comment <number> --body-file <file>`.
- Add or remove labels with `gh issue edit`.
- Close an issue with `gh issue close <number>` after recording its resolution.
- Pull requests are not treated as incoming requests for triage.

## Skill Publishing

When an engineering skill says to publish a spec, map, decision, or ticket to
the issue tracker, create or update a GitHub Issue in this repository.

## Wayfinding Operations

- A Wayfinder map is one issue labelled `wayfinder:map`.
- Decision tickets are child issues labelled `wayfinder:research`,
  `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Prefer GitHub sub-issues. If sub-issues are unavailable, add the child to a
  task list in the map and add `Part of #<map>` to the child body.
- Prefer GitHub native issue dependencies for blocking edges. If unavailable,
  add a `Blocked by:` line to the child issue body.
- The frontier is the ordered set of open, unassigned child issues whose
  blockers are all closed.
- Claim a decision ticket by assigning it before doing any work.
- Resolve a decision ticket by posting the answer, closing the issue, and
  appending a one-line linked gist to the map's `Decisions so far` section.
