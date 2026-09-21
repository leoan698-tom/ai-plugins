---
name: release
description: Prepare a release up to the production gate — check CI, confirm the change merged through branch protection, draft the notes, and confirm the rollback path exists. Use ONLY when the user asks to prepare or cut a release. Never crosses the production gate itself.
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *), Bash(git log:*), Bash(git tag:*), Bash(git status:*), Bash(gh run list:*), Bash(gh pr view:*)
argument-hint: "[environment]"
---

# Prepare a release

The governing principle: **the agent may act up to the production gate and
cannot pass it.** Everything below is preparation.

## Checks before proposing a release

1. **CI is green** on the commit being released (`gh run list`).
2. **The change merged through branch protection** rather than arriving on the
   branch some other way.
3. **Rollback exists and has been exercised.** Read the routes in the SDLC
   config and confirm the rollback runbook is really there. The autonomy loop
   invokes rollback automatically when a control band is breached, which makes
   it a runtime dependency rather than an insurance policy — an unrehearsed
   rollback is how a small incident becomes a large one.
4. **Draft the release notes** from the commits since the last tag.

## Non-production environments

If the target is development or staging and a deploy command is configured, you
may run it. Autonomy is graded by environment on purpose.

## Production

Do not run the deploy. Report:

- whether the release authorization environment variable is present
- who grants it, from the configured route
- exactly what the human needs to do

The gate checks that an authorization is **present and attributable**, not that
it is genuine. Say that out loud rather than implying a stronger guarantee: a
session cannot write its own hook process environment, so the agent cannot forge
it, but the person who launched the session set it. Where a real guarantee is
needed, the deploy credential belongs in CI or behind an environment-scoped MCP
tool, not in a shell a session can reach.

Never set the variable yourself, and never suggest a way around the gate.
