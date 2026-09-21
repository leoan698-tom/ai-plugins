---
name: sdlc-playbook
description: The AI-native SDLC playbook itself — the artifact chain, which command applies at which stage, and why a gate blocked something. Use whenever the user mentions intent.md, spec.md, plan.md, the artifact chain, plan mode as a default, the CLAUDE.md two-strikes rule, the feedback loop, a verifier subagent, REVIEW.md, hooks as approval gates, evals, sigma bands or control bands, or asks "what should I do next" in a development workflow, or asks why an ai-native-sdlc gate blocked an action.
user-invocable: true
---

# The AI-native SDLC playbook

The problem this addresses: when agents write most of the code, the build stage
collapses to agent speed while the stages around it still run at human speed.
The bottleneck moves to planning, review and deploy; per-line review stops being
possible; and governance costs rise because exceptions still route through
weekly meetings.

The answer is not fewer controls. It is the **same control objectives with a
different enforcement mechanism**: each stage ends by committing an artifact,
the next stage begins by reading it, and the chain of commits becomes the audit
trail. Humans stay accountable for every decision that needs judgement — their
attention moves to the gates.

## The chain

```
intent.md → spec.md → plan.md → diff + tests → PR + findings → incident record
    ↑                                                               │
    └───────────────── a breached control band writes the next ─────┘
```

| Stage | Command | Artifact |
|---|---|---|
| Plan | `/ai-native-sdlc:intent` | `intent.md` — the problem in the originator's words |
| Design | `/ai-native-sdlc:spec` | `spec.md` — requirements and design, with concerns flagged |
| Build | `/ai-native-sdlc:plan` | `plan.md` — files, order, risks, alternatives, proof |
| Test | `/ai-native-sdlc:fix`, `/ai-native-sdlc:verify` | a failing test committed before the fix; toolchain output |
| Deploy | `/ai-native-sdlc:pr-review`, `/ai-native-sdlc:release` | findings; a release prepared up to the gate |
| Governance | `/ai-native-sdlc:gates`, `/ai-native-sdlc:review-tune` | the written gate list; a tuned review policy |

## Three distinctions worth keeping straight

**Skill versus hook.** A skill is an *advisory* control: it makes the right
thing likely while code is being written, and nothing forces a session to comply.
A hook is *deterministic*: allow, ask or block. A policy that must always hold
needs a hook behind the skill. The skill makes violations rare; the hook makes
them close to impossible.

**Feedback loop versus verifier.** The loop runs throughout a task, as many
times as the work needs. The verifier runs once, in a fresh context, after the
session believes it is done — so its verdict is not coloured by the assumptions
that produced the code.

**Allow/block versus ask.** Build-phase gates never ask. An approval prompt puts
a human on the critical path of every parallel session and deadlocks a
non-interactive run. Approval belongs at the release gate, and even there it is
a deny with a route rather than a prompt.

## When a gate blocks something

Read the block message: it names the policy, its playbook id and lesson, the
deterministic fact that triggered it, and the route forward. Take the route.
Do not look for a way around it — if a gate is genuinely wrong for this
repository, the fix is a pull request against the repository's SDLC config,
which is reviewable, rather than a workaround that is not.

The always-hard set ignores the enforcement level entirely: credentials,
secret reads, production deploys, protected branches, self-approval, the
fix-mode test lock, protected paths, and the plugin's own configuration.

## What this does and does not guarantee

The gates are unbypassable by the **agent**: a PreToolUse denial fires before any
permission check, so it holds even in bypass-permissions mode. They are not
unbypassable by a **person** — disabling the plugin or all hooks remains
available unless an organisation deploys managed settings.

That is why `sdlc-verify` in CI matters: it re-runs the same deterministic checks
over a diff, trusting no local state, so the policy set holds on machines where
the hooks never ran at all.
