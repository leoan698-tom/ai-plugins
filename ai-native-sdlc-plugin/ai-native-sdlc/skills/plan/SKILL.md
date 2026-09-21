---
name: plan
description: Produce plan.md — the implementation plan the later gates check the diff against. Use when the user says "plan this", "make a plan", "how should we implement this", "start planning", or after an intent or spec is accepted and the next step is deciding how to build it. Interrogates the plan before writing it, and names the files that will change.
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(git status:*), Bash(git branch:*), Bash(git log:*)
argument-hint: "[change-name]"
---

# Plan the change

Design review happens here, while changing course is still a matter of editing a
document. Once code exists, rework is expensive — so the plan is where the
thinking goes.

## Read first

Read `intent.md` and `spec.md` for this change if they exist, and read the parts
of the codebase the change will touch. Use the `researcher` agent when the
exploration would otherwise flood this session's context.

## Interrogate the plan before writing it

Do not produce a plan and stop. Work through, out loud:

- **What could this break?** Name the callers, the data, the deploys.
- **Which step is riskiest**, and what makes it risky?
- **What alternatives did you reject, and why?** This is the part people skip,
  and it is the part a reviewer most needs. It is a required section at strict
  enforcement level.

Iterate with the user until the plan would let an engineer who never saw this
conversation implement the change on their own. That is the acceptance bar.

## Write it

Write `<intent home>/<change-name>/plan.md` with:

- **Files that change** — actual paths, one per line or inline in backticks.
  This section is load-bearing: the commit gate compares your staged files
  against it, the CI check compares the whole diff against it, and parallel work
  is split by it. A heading with no paths under it fails the structure gate,
  because it satisfies the letter of the rule and none of its purpose.
- **Order of work**
- **Risks**
- **Alternatives considered**
- **Proof** — something quantifiable, so the work can be checked without asking:
  "all tests in `<file>` pass", "the endpoint returns 200 with the new field".

## Then

Tell the user to commit `plan.md` before implementing. If the implementation
later departs from the plan, update `plan.md` in the same commit — the commit
gate will require it, and the CI check will flag a plan that does not account
for what the change actually touched.
