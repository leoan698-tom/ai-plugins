---
name: intent
description: Capture a problem as intent.md, the first artifact in the SDLC chain. Use when the user describes something that is broken or missing and wants it written down, or says "capture this as an intent", "write an intent", "start a change", "file this properly", or asks what the next step is after having an idea. Brainstorms like an analyst first, then writes the artifact in the originator's own words.
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(git config user.name), Bash(git status:*)
argument-hint: "[change-name]"
---

# Capture intent

The first artifact. Everything downstream reads it, so the job is to get what
the originator actually meant written down before it has been through three
handoffs and become something else.

## Brainstorm before you write

Ask the questions an analyst would ask, one or two at a time rather than as a
questionnaire:

- What can they not do today, and who is affected?
- What does better look like — the result, not the implementation?
- What is explicitly out of scope?
- What constraints must hold (data, authentication, compatibility)?
- How would they know it worked?

Keep going until the idea is concrete. No formal language is required: the point
of this artifact is that it is in the originator's terms.

## Then write it

Write `<intent home>/<change-name>/intent.md` from the template in the artifact
home's `_templates/` directory. Set `Author:` from `git config user.name` plus
the role the user gives you.

The structure gate requires: Problem, Proposed outcome, Affected users and
systems, Constraints, Open questions. Headings may be English or Chinese.

**Write down what is unknown** rather than guessing. The design pass either
answers an open question or carries it forward — a guess that looks like a
decision is worse than a stated unknown.

## Close the loop

Tell the user to commit it: the author and timestamp that make this an auditable
record come from git, not from the file. A stage ends by committing its artifact.

Then say what comes next: `/ai-native-sdlc:spec` turns this into a specification
constrained by the organisation's policy skills.
