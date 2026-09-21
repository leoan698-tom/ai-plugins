---
name: sdlc-doctor
description: Check whether this repository is actually protected — config validity, the feedback loop, permission rules, and whether server-side branch protection really exists. Use when the user asks "are the gates working", "is the SDLC set up", "why did that not get blocked", "check my sdlc setup", or is troubleshooting the plugin. Non-mutating.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *)
argument-hint: "[--selftest]"
---

# Doctor

Run `node ${CLAUDE_SKILL_DIR}/run.mjs doctor` and show the table. With
`--selftest`, run `doctor --selftest`, which additionally replays synthetic
payloads through the real hooks.

This reports; it never fixes. Each finding names the fix, and the user decides.

## The two findings to read carefully

**Branch protection not configured.** The local push gate stops the *agent*, not
a person with any other git client. A team that sees `git push origin main`
blocked and concludes separation of duties is enforced holds a false belief that
is worse than no belief, because it stops them looking for the real control.
Treat this as more urgent than anything else on the list.

**Self-test failures.** The configuration looking right is not evidence that a
control is live. If a gate does not fire, work through the causes in order: the
plugin not enabled in this session, Node missing from PATH for hook processes
(a missing interpreter exits 127, which the runtime treats as non-blocking, so
every gate fails open silently), hooks disabled, or managed settings enforcing
`allowManagedHooksOnly` without force-enabling this plugin.

## Also worth explaining when it comes up

- **Project hooks that duplicate the plugin's.** A plugin hook is not
  de-duplicated against an identical project hook — both fire, and there are
  then two sources of truth for one policy.
- **No pre-approved inner loop.** An unpaired deny list becomes prompt fatigue,
  and prompt fatigue is the documented route to someone disabling hooks entirely.
- **No secret `Read` deny rules.** Files pulled in with an `@` reference never
  fire a PreToolUse hook. A permission rule is their only coverage.
