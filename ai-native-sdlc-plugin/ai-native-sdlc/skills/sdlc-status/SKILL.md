---
name: sdlc-status
description: Show what is armed, the current session state, and what the gates cost in milliseconds. Use when the user asks "what is the sdlc status", "which gates are active", "am I in fix mode", "how slow are the hooks", or wants the enforcement metrics. Read-only.
user-invocable: true
allowed-tools: Read, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *)
argument-hint: "[--days N]"
---

# Status

Run `node ${CLAUDE_SKILL_DIR}/run.mjs status --session <session_id>` and show it.

## What the numbers are for

**p50 / p95 per gate.** Lesson 11 makes wait time per gate the leading metric
for an enforcement layer, precisely so a gate's price is visible to the people
who own the policy. A gate whose cost nobody measures is a gate that gets
switched off the week it becomes annoying. If a gate is drifting slower, say so
before somebody else discovers it the hard way.

**Denials per gate.** A gate that fires constantly is usually a configuration
problem rather than a discipline problem — a glob that is too broad, a path list
that does not match how this repository is actually laid out. Suggest tightening
the config through a PR; do not suggest lowering the enforcement level.

**Would-have-blocked, at advisory level.** Every predicate still evaluates and
records what it would have denied. That count is how a team makes the case for
moving to standard with evidence instead of a mandate — and it is also how long
someone has been parked in advisory, which is worth naming out loud after a
couple of weeks.

## Session state

Fix phase, active change, last verification and its age. If fix mode is locked,
say which files are read-only and what clears the lock — a confused session in a
lock it did not expect is a bad experience that is easy to prevent.
