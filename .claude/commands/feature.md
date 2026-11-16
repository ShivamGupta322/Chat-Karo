---
description: Build a feature through the supervisor → coder → supervisor review loop
argument-hint: <feature description>
---

Build this feature for chatErl using the supervisor/coder workflow:

**Feature:** $ARGUMENTS

You are the orchestrator. Subagents cannot talk to each other, so you pass messages between them
verbatim. Do not implement or review code yourself.

## Step 1 — Plan
Invoke the `supervisor` agent in **PLAN mode** with the feature description above.
Show the plan to the user in a short summary (goal + acceptance criteria).
If the supervisor flags that the feature is out of roadmap order or conflicts with the docs,
stop and ask the user how to proceed.

## Step 2 — Implement
Invoke the `coder` agent with the **full plan text**, labelled "round 1".

## Step 3 — Review
Invoke the `supervisor` agent in **REVIEW mode** with:
- the full original plan, and
- the coder's full report, labelled with the round number.

## Step 4 — Loop
- **APPROVED** → go to Step 5.
- **CHANGES REQUIRED** and round < 3 → invoke `coder` again with the plan, the supervisor's full review
  (required changes list), and the next round number. Then repeat Step 3.
- **Round 3 still not approved** → stop. Give the user the supervisor's summary of what's unresolved
  and ask how to proceed.

## Step 5 — Wrap up
1. If the supervisor said a design decision was made, append an ADR to `docs/DECISIONS.md`.
2. Tick completed items in `docs/ROADMAP.md`.
3. If commands changed, update the Commands section of `CLAUDE.md`.
4. Report to the user: what was built, files changed, test results, rounds taken, and anything the
   supervisor couldn't verify. Suggest a Conventional Commit message, but do not commit unless asked.
