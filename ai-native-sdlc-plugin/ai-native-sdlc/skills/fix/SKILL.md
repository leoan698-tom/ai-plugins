---
name: fix
description: Fix a bug under the test lock — write the failing test first, commit it, then fix the code with the test held read-only. Use ONLY when the user explicitly asks to start, finish or abandon a fix task. This skill changes enforcement state, so it is never invoked on the model's own initiative.
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Edit, AskUserQuestion, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *), Bash(git add:*), Bash(git commit:*), Bash(git status:*), Bash(git diff:*)
argument-hint: "<bug description> | done | abort"
---

# Fix under the test lock

**Why this skill cannot be model-invoked:** it arms and disarms the test lock.
If the model could call it, the model could enter and leave its own lock at
will, and the protection would dissolve into a suggestion. The lock only means
something because a human turns it on and off.

## `/fix <bug description>` — reproduce phase

1. Set the phase:
   `node ${CLAUDE_SKILL_DIR}/run.mjs state set --session <session_id> --key fix.phase --value repro`

2. **Write a test that reproduces the bug.** Not a test that describes the fix —
   a test that fails today, for the reason the bug exists.

3. **Run the test command and show its output.** Confirm it fails, and confirm
   it fails for the expected reason rather than a typo or a missing import. This
   step is not ceremony: a red run must be on record before the lock engages,
   because otherwise a vacuous passing test would satisfy the entire loop.

4. **Commit only the test.** When that commit lands with a red run recorded, the
   lock engages automatically and the test files become read-only.

   If you commit the test without a recorded failing run, the plugin will say so
   and will not lock. Run the test, then commit again.

## Locked phase — fix the code

The test files are now denied to every write path: the file tools, the shell,
and any subagent. The working tree is re-checked at the end of each turn, so a
locked test that changes by any route at all is caught.

Change the code until the committed test passes. If the test looks wrong, it
might be — but that judgement belongs to a human, not to the session that is
trying to make it pass.

## `/fix done`

Run `/ai-native-sdlc:verify`. If everything is green, clear the phase:
`node ${CLAUDE_SKILL_DIR}/run.mjs state set --session <session_id> --key fix.phase --value off`

If it is not green, say so and stay locked.

## `/fix abort`

Confirm with **AskUserQuestion** first — this is the escape hatch, and it should
feel like one. Then clear the phase and say plainly in the summary that the fix
was aborted with the test unproven, so the reviewer knows what they are looking
at. The decision is recorded in the ledger either way.
