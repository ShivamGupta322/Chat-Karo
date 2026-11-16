---
description: Ask the supervisor to review current uncommitted changes
argument-hint: [what the change was meant to do]
---

Invoke the `supervisor` agent in **REVIEW mode** on the current working-tree changes
(`git diff` / `git status`). There is no formal plan; use this as the intent:

$ARGUMENTS

Present the supervisor's verdict and required changes to the user. Do not apply fixes unless the
user asks — if they do, pass the required changes to the `coder` agent.
