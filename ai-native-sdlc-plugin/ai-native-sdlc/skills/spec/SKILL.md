---
name: spec
description: Turn an accepted intent.md into spec.md — requirements and design in one pass, constrained by the organisation's policy skills. Use when the user says "write the spec", "turn this intent into a spec", "do the design", or after an intent has been accepted and the next step is deciding what to build. Flags policy conflicts instead of silently picking a side.
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Edit
argument-hint: "[change-name]"
---

# Requirements and design

Requirements and design happen in one session here rather than as two phases run
by two teams. The separation existed for accountability, and it is slow and
lossy; what replaces it is that the policies constrain the spec **while it is
written**, and the same person who wrote the intent reviews the result.

## Load the constraints

Read the policy skills this repository registers under `policy_skills` in the
SDLC config, plus any organisation skills available in the session. These are
the brand, security, compliance and UX standards. They are advisory controls —
they make the right thing likely, not certain — which is exactly why the spec
must record which ones were applied.

## Produce the spec

Read `intent.md`, then write `<intent home>/<change-name>/spec.md` covering:

- **Requirements** — what the system must do
- **Design** — how it fits the existing codebase, named concretely
- **Policies applied** — which policy skills constrained this. If none were
  available, say so; an unstated gap is worse than a stated one.
- **Concerns** — REQUIRED, and the most important section
- **Open questions carried forward** — from the intent: answered, or explicitly
  deferred

## Concerns are the point

State clearly any area of concern, **especially where two policies cannot both
be satisfied**. Do not quietly choose one and move on: these are the points an
analyst would have escalated, and surfacing them here is most of this stage's
value. Each one gets resolved with its policy owner before engineering sees the
spec.

Write "None" only if you genuinely found none.

## Then

Tell the user to commit `spec.md` alongside `intent.md` — the pair records what
was asked for and what was decided. The decision to move into build is theirs to
make, with a technical lead for anything the organisation treats as higher risk.

Next: `/ai-native-sdlc:plan`.
