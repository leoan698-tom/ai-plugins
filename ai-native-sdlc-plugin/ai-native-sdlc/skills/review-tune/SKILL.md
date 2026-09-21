---
name: review-tune
description: The monthly tuning ritual — apply the two-strikes rule to repeated review findings, cap the nits, and prune CLAUDE.md lines that recent changes made stale. Use ONLY when the user asks to tune the review policy or run the monthly review maintenance. Rewrites CLAUDE.md and REVIEW.md, so it is never model-invoked.
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Edit, AskUserQuestion, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *), Bash(git log:*), Bash(gh pr list:*), Bash(gh pr view:*)
---

# Tune the review loop

Without a scheduled ritual, an AI review policy decays in one direction: toward
more findings, more noise, and eventually toward people ignoring it. This is the
counterweight.

## Gather

- Recent review findings — pasted by the user, or from `gh pr view --comments`
- Repeated gate denials: `node ${CLAUDE_SKILL_DIR}/run.mjs status --days 30`

## Apply the two-strikes rule

Anything flagged **twice** becomes a line in `CLAUDE.md` under "Things Claude
gets wrong". Once is a coincidence; twice is a pattern. Because review reads
`CLAUDE.md`, the correction takes effect from the next PR onward — this is the
mechanism that stops the same finding recurring forever.

Propose the exact lines and let the user approve them. Keep the file under its
line limit: if adding a line would exceed it, propose which stale line to remove
in the same edit. The size gate still applies to you.

## Report the noise ratio

Count Important findings against nits over the period. If nits dominate,
propose tightening `REVIEW.md`:

- lower the nit cap
- add exclusions for anything CI already enforces
- add generated paths that crept in

## Prune what went stale

Look for `CLAUDE.md` lines that recent diffs made untrue — a frozen package that
was finally deleted, a command that was renamed. A stale instruction is worse
than a missing one: it is read in full at every session start and it is wrong.

## Ship it as a PR

Put the changes on a branch and open a pull request. `CLAUDE.md` and `REVIEW.md`
are policy artifacts, and they change through review like any other.
