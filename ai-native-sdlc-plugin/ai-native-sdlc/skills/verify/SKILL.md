---
name: verify
description: Run the repository's build, test and lint commands and show the literal output, then have a fresh-context verifier exercise the change. Use when the user asks to "verify", "check it works", "run the tests", "prove this works", or before reporting a task complete. Evidence comes from the toolchain, not from a claim that it was run.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *), Bash(git status:*), Bash(git diff:*)
---

# Verify

## Run the checks and paste the output

Read the configured commands (`node ${CLAUDE_SKILL_DIR}/run.mjs config`) and run
build, test and lint **in the foreground**.

Paste the literal output. Not a summary of it, not "tests passed" — the output.
The evidence has to come from the toolchain, because a summary is exactly the
self-report this gate exists to replace.

Check the result against the repository's healthy-output pattern, not just
whether the command returned. A suite that exits zero having skipped forty cases
is not a passing suite, and the documented shell tool response carries no exit
code at all, which is why the pattern exists.

## Then get an independent look

If a run command is configured, use the **verifier** agent. It starts the app,
exercises the changed behaviour and the two nearest neighbouring flows, and
reports what it ran and what it saw.

It runs in a fresh context on purpose: a verdict from the same context that
produced the code is coloured by the assumptions that produced the code. And it
has no write tools — it reports, it does not fix. If it finds something, bring
the finding back here and fix it in this session.

## If something fails

Say so plainly and fix the code. Do not adjust the test to match the behaviour,
do not add a skip marker, and do not describe a failing run as "mostly working".
Under a fix lock the test files are denied to you anyway, but the reason matters
more than the mechanism: the check is the only thing standing between a change
and production.
