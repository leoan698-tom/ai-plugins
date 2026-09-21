---
name: pr-review
description: Run the repository's REVIEW.md passes over the current change as a local dry run before pushing. Use when the user asks to "review this", "review the PR", "check my changes", "do a code review", or wants to know what a reviewer would say. Reports findings; it cannot approve, and it is not meant to.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git merge-base:*)
argument-hint: "[base-branch]"
---

# Local review pass

Runs the same passes the hosted review would, before anything leaves the branch.

## Read the policy first

Read `REVIEW.md`. It defines the passes, what Important means *here*, the nit
cap and the exclusion list. Following it matters more than finding everything:
a review that reports forty nits is a review people learn to skip, and the
course names noise — not misses — as the main failure mode of AI review.

## Get the diff and the intent

`git diff <base>...HEAD`, plus the `spec.md` and `plan.md` for this change. The
compliance pass needs them; without them it degrades to a general code review,
which is not what this pass is for.

## Run the passes

Use the **compliance-reviewer** agent so the review happens in a fresh context.
Tag each finding with its pass:

- **Bugs** — logic errors, broken edge cases, subtle regressions
- **Security** — injection, authentication gaps, credentials or PII in logs
- **Compliance** — does the diff do what `plan.md` said, and what `spec.md`
  asked for? Files changed that the plan never mentioned?

Respect the nit cap. Summarise the rest as a count. Skip generated paths and
anything CI already enforces — re-reporting a lint rule that the pipeline will
catch anyway is pure noise.

## Say what this is not

State plainly that these findings do not approve or block anything. Branch
protection still requires a code owner, and the agent that wrote the code cannot
approve it — `gh pr merge` and `gh pr review --approve` are denied outright.
That separation is the control; this pass only informs it.

## Feed the loop

If a finding repeats something already seen before, say so and suggest adding it
to `CLAUDE.md` under "Things Claude gets wrong". Twice is a pattern, and review
reads `CLAUDE.md`, so the correction takes effect from the next PR onward.
