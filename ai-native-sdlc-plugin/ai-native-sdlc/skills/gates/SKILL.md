---
name: gates
description: Record the written list of human approval gates that must survive automation, and map each one to the mechanism that implements it. Use when the user asks about "approval gates", "what needs sign-off", "change management", "which controls do we keep", or is preparing to roll this out to a team or an auditor.
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Edit, AskUserQuestion
---

# The written gate list

Lesson 11 step 1 is explicit: engineering leadership, with change management and
compliance, produces the **written list** of human approval gates that must
survive. Platform engineering then expresses each one as a hook.

Skip that and the hooks encode somebody's guess about what the organisation
requires. This skill produces the artifact that makes the guess unnecessary, and
makes "nobody ever decided this" visible instead of invisible.

## Walk the conversation

Ask, one at a time:

1. Which approvals exist today that must still exist when an agent is doing the
   work? (release authorisation, change management sign-off, edits to protected
   paths, dependency changes, schema migrations)
2. For each: **who** grants it, **what evidence** counts as granted, and **what
   happens** if it is missing?
3. Which of these are currently enforced by a person noticing, rather than by a
   mechanism?

That last question is usually the uncomfortable one and usually the most useful.

## Write `.sdlc/gates.md`

One row per gate: the gate, who approves, what evidence counts, the mechanism
that implements it today, and whether that mechanism is deterministic.

Map each to its mechanism honestly:

| Kind of mechanism | What it actually gives you |
|---|---|
| A plugin hook | the agent cannot pass it; a person can still disable hooks |
| A `permissions.deny` rule | covers tool paths a hook misses, such as `@`-references |
| Server-side branch protection | the authoritative control for merge and push |
| A CI required check (`sdlc-verify`) | holds on machines where the plugin never ran |
| Managed settings | the only layer a local user cannot switch off |
| A review pass | advisory; informs a human decision |
| "Someone notices" | not a control — say so |

## Name the gaps

Any gate with no deterministic implementation gets written down as a gap, with
the nearest available mechanism next to it. A gate the organisation believes it
has and does not have is worse than a gate it knows is missing, because it
stops anyone looking for a replacement.

Tell the user this file belongs in review like any other policy artifact, and
that `/ai-native-sdlc:sdlc-doctor` reports when it is absent.
