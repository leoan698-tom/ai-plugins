# Enforcement matrix

Every policy in the AI-native SDLC playbook (P01–P83), against the mechanism
that actually implements it here.

This document exists so that "which of the 83 policies is enforced, and by what"
has one answer instead of an impression. **A policy an organisation believes it
enforces and does not is worse than one it knows is missing**, because the
belief stops anyone looking for a replacement. Rows below are therefore marked
honestly, including where this plugin does nothing at all.

## How to read the status column

| Status | Meaning |
|---|---|
| **hard** | A deterministic gate denies the action. Ignores `enforcement_level`; fails **closed** on internal error. The agent cannot pass it. |
| **level** | A deterministic gate that blocks at `standard`/`strict` and warns at `advisory`. Fails open with a visible warning. |
| **ci** | Re-checked by `sdlc-verify` over a diff, trusting no local state — so it holds on machines where the hooks never ran. |
| **report** | A command surfaces it; a human acts. |
| **guide** | A skill instructs; nothing verifies. Advisory by nature. |
| **none** | Not implemented here. The fallback column says what would implement it. |

Two facts bound everything below:

- The gates are unbypassable **by the agent** — a `PreToolUse` denial fires
  before any permission check, so it holds even under bypass-permissions mode.
- They are not unbypassable **by a person**. `/plugin disable`,
  `disableAllHooks` and `--settings` remain available unless an organisation
  deploys managed settings. See [escape-hatches.md](escape-hatches.md).

---

## Stage 1 — Plan

| # | Policy | Status | Mechanism | Fallback where not hard |
|---|---|---|---|---|
| P01 | Each stage ends by committing an artifact; the next reads it | level + ci | `h07-artifact-home-guard`, `h24-turn-scanner` nudge | The commit itself is the record; git history is the audit trail |
| P02 | An accepted artifact triggers the next stage | **none** | — | No local event corresponds to a merge. Needs forge workflows; **not scaffolded yet** |
| P03 | `intent.md` carries Problem / Outcome / Affected / Constraints / Open questions | level + ci | `h08-artifact-structure`, `sdlc-verify` | Bilingual heading aliases mean zh and en both satisfy it |
| P04 | The originator writes it in their own words | guide | `/intent` brainstorms before writing | Human authorship; only the commit author evidences it |
| P05 | Committed to a shared intent home with author and timestamp | hard + ci | `h07-artifact-home-guard`; `sdlc-verify` checks the Author line against the commit author | Timestamp comes from git |
| P06 | The design pass applies the organisation's skills as constraints | guide | `/spec` loads `policy_skills`, requires a "Policies applied" line | Skill application is model-mediated; the review compliance pass and the eval suite detect non-application |

## Stage 2 — Design

| # | Policy | Status | Mechanism | Fallback |
|---|---|---|---|---|
| P07 | `spec.md` flags areas of concern, especially contradicting policies | level + ci | `h08-artifact-structure` requires a Concerns section | A section can be present and shallow; only review catches that |
| P08 | Flagged concerns resolved with policy owners before engineering sees the spec | **none** | — | Cross-human routing. CODEOWNERS on the intent home + PR review threads |
| P09 | `spec.md` committed together with `intent.md` | level + ci | `h07`; `sdlc-verify` warns (errors at strict) when no sibling intent exists | — |
| P10 | The decision to enter build is always human | **none** | — | This is the judgement the whole design protects. A gate can pause, not decide |

## Stage 3 — Build

| # | Policy | Status | Mechanism | Fallback |
|---|---|---|---|---|
| P11 | Build starts from a written, approved plan | level (strict) + ci | `sdlc-verify` flags source changes with no governing plan | Plan mode already enforces it within one session; this extends it across sessions |
| P12 | `plan.md` names files, order, risks, and the tests that prove it | level + ci | `h08-artifact-structure`; a Files section listing no paths fails | — |
| P13 | The plan is interrogated: breakage, riskiest step, rejected alternatives | level (strict) | `h08` requires "Alternatives considered" at strict; `/plan` walks the questions | Whether the interrogation happened is not checkable; only its output is |
| P14 | An engineer who never saw the conversation could implement it | **none** | — | Qualitative. `REVIEW.md` compliance-pass criterion |
| P15 | Implementation departing from the plan updates `plan.md` with it | ci | `sdlc-verify` compares the diff against "Files that change" | The commit-scoped variant is **not built as a hook yet** |
| P16 | `CLAUDE.md` stays under one page | ci | `sdlc-verify` warns above the configured limits | The PostToolUse hook for this is **not built yet** |
| P17 | Two-strikes rule: a repeated mistake goes into `CLAUDE.md` | report | `/review-tune` applies it from findings; `/sdlc-status` shows repeated denials | Recognising a repeat across sessions needs memory and judgement |
| P18 | `CLAUDE.md` is shared and changed through code review | hard | `h25-config-self-protection` denies agent edits to `.claude/**` | CODEOWNERS is the real mechanism; `/sdlc-doctor` reports when it is absent |
| P19 | Do not bump dependency versions | hard + ci | `h05-protected-path-guard` (lockfiles outright; manifests when a version specifier changes) | — |
| P20 | Generated files and frozen packages are read-only | hard + ci | `h05`, `h14-shell-write-shadow`, `h24-turn-scanner` | Frozen entries carry a successor so the block names where to go |
| P21 | Write a skill only for knowledge that must be applied consistently | guide | `sdlc-playbook` explains the three-layer boundary | Authoring judgement; policy-owner review of the skill PR |
| P22 | A skill's description enumerates its triggers, and triggering is tested | **none** | — | A description lint is **not built**; trigger tests belong in the eval suite |
| P23 | Every external endpoint requires the gateway JWT | **none** | — | Repo-specific semantics. Seam exists (`policy_scripts`) but **no reference checker ships** |
| P24 | Validate request bodies against the schema, reject unknown fields | **none** | — | Same seam, same gap |
| P25 | State-changing endpoints emit an audit event | **none** | — | Same seam, same gap |
| P26 | PII-tagged fields never appear in logs | **none** | — | Same seam. A generic log-line grep would close part of it |
| P27 | Run the formatter and linter after edits | **none** | — | The PostToolUse formatter hook is **not built yet** |
| P28 | Keep credentials out of the diff | **hard** + ci | `h03-credential-guard` (scans `content`/`new_string`/`new_source`), `h24-turn-scanner`, `sdlc-verify` | Findings name the pattern and line, never the value |
| P29 | Build-phase hooks are fast and file-scoped | hard (structural) | One Node process per tool call; no hook runs a suite; `/sdlc-status` reports p50/p95 | A config lint asserting it is **not built** |
| P30 | No `ask` hooks in the build inner loop | hard (structural) | No rule ever returns `ask`; the release gate denies with a route instead | A config lint asserting it is **not built** |
| P31 | Parallel sessions only on non-overlapping files | **none** | — | Derivable from "Files that change"; sibling sessions are not observable from a hook |
| P32 | Two or three concurrent sessions; the limit is review bandwidth | **none** | — | Human judgement |
| P33 | Pre-approve the safe inner loop so the deny list is not fatigue | report | `/sdlc-init` derives `permissions.allow` from the interview and merges it; `/sdlc-doctor` reports drift | A plugin cannot ship permission rules — its `settings.json` honours only `agent` and `subagentStatusLine` |
| P34 | The verifier has no write tools and reports only | **hard** | `tools:` whitelist + `h26-agent-type-write-deny` + `h27-subagent-stop-diff` | The hook layer survives someone copying the agent file and adding `Edit` |

## Stage 4 — Test

| # | Policy | Status | Mechanism | Fallback |
|---|---|---|---|---|
| P35 | Every task has a single-command way to verify | report | `/sdlc-doctor` fails without one; `/sdlc-init` refuses to call the loop closed | A property of the repo's toolchain |
| P36 | `CLAUDE.md` lists each command with an example of healthy output | report | `/sdlc-init` captures it from a real run; doctor warns when absent | Quality of the example is not checkable |
| P37 | State a quantifiable goal so the work can be self-checked | level | `h08` requires plan.md's Proof section | Whether it is genuinely quantifiable is not checkable |
| P38 | Write the failing test first; confirm it fails; commit before fixing | **hard** | `/fix` will not lock until a **red run is on record**, so a vacuous passing test cannot satisfy the loop | — |
| P39 | During a fix the agent must not edit test files | **hard** | `h04-test-lock` (file tools), `h14` (shell), `h27`/Stop scan (hash comparison at turn end) | Three layers because one tool path is not coverage |
| P40 | Run build/test/lint before reporting done, and show the output | level | `h23-verify-evidence-gate`: trusts a recorded pass while the tree hash matches, otherwise **re-runs** for a real exit code | The documented shell response carries no exit code, so recorded text alone could be a false green |
| P41 | Fix the code, not the test; never skip a failing test | **hard** + ci | `h04` blocks added skip markers; `sdlc-verify` catches them in a diff | — |
| P42 | UI work closes the loop visually | **none** | — | Needs a browser or screenshot tool. The hookable half — requiring plan.md's Proof to name a mock and asserting the screenshot is newer — is **not built** |
| P43 | Maintain 20–50 real eval cases | **none** | — | `evals/` scaffolding is **not built yet** |
| P44 | Evals run on every change to `CLAUDE.md`, skills and hooks | **none** | — | Needs a forge workflow; **not scaffolded yet** |
| P45 | Gate configuration changes on eval results | **none** | — | Branch-protection required check |
| P46 | The eval verdict is deterministic, not model self-assessment | **none** | — | Would be `evals/check.mjs`; **not built** |
| P47 | Every incident produces a permanent eval | **none** | — | Post-incident discipline; nothing links an incident to a case |
| P48 | Evals are a live suite; pass rate is never read in isolation | **none** | — | Suite hygiene; no case-age or discrimination tracking |

## Stage 5 — Deploy

| # | Policy | Status | Mechanism | Fallback |
|---|---|---|---|---|
| P49 | Review runs three tagged passes, including compliance vs spec and plan | guide | `REVIEW.md` template, `/pr-review`, `compliance-reviewer` agent | Hosted review or `claude-code-action` runs it on the PR |
| P50 | Important is reserved for behaviour, data or policy breaches | guide | Defined in `REVIEW.md` | Applied by the reviewer model |
| P51 | Cap the nits | guide | `REVIEW.md` cap; `/review-tune` reports the ratio | No machine-readable severity count is emitted |
| P52 | Do not report generated paths or what CI enforces | guide | `REVIEW.md` exclusion list | — |
| P53 | Findings inform; they do not approve or block | hard (structural) | Nothing in this plugin approves anything | Branch protection is the gate |
| P54 | The agent that wrote the code cannot approve it | **hard** | `h11` denies `gh pr merge` and `gh pr review --approve` | Server-side branch protection is authoritative; `/sdlc-doctor` **verifies it exists** |
| P55 | Work arrives as a PR; no path to main | **hard** | `h11` denies pushes to protected branches, force pushes, `--no-verify` | Same |
| P56 | Review findings flow back into `CLAUDE.md` | report | `/review-tune` | — |
| P57 | Leadership produces the written list of approval gates | report | `/gates` writes `.sdlc/gates.md` and maps each to its mechanism | Prerequisite governance work; the skill makes its absence visible |
| P58 | Production deploys require a named release authorization | **hard** | `h10-production-gate` | **Honest limit**: checks presence and format, not authenticity. Self-asserted by whoever launched the session |
| P59 | No migration or infrastructure edits without a change ticket | **hard** + ci | `h05` (branch name, env var, or plan ticket) | — |
| P60 | A block explains itself and names the route to approval | hard (structural) | Six-line message contract; the self-test asserts every deny has Policy and Route lines | — |
| P61 | Hooks are layered: team-level reviewed, non-negotiable ones managed | **none** | — | Managed settings sit above the plugin by design |
| P62 | Block reads of `.env` and secrets | **hard** | `h09-secret-read-guard`, `h06-shell-secret-read`, plus `permissions.deny` written by `/sdlc-init` | `@`-referenced files **never** fire a PreToolUse hook — the permission rule is their only coverage |
| P63 | Block arbitrary network egress | level | `h28-egress-guard` (localhost always allowed) | A tool deny does not stop a script; only an OS sandbox is airtight, and there is none on native Windows |
| P64 | Pre-approve the safe inner loop | report | See P33 | — |
| P65 | No engineer, file or flag may loosen the rules | partial | `h25-config-self-protection`, `h11` denies `git config core.hooksPath` and alias tampering | Genuinely requires managed settings; a project file's owner can always edit it |
| P66 | Sandbox is a precondition for startup | **none** | — | Managed settings only. **Unsupported on native Windows**, which is why Class A fails closed there |
| P67 | Deny sandboxed commands access to `~/.ssh` and `~/.aws` | partial | `h06-shell-secret-read` covers the explicit form | Trivially evadable by indirection; `sandbox.credentials` is the airtight layer |
| P68 | All extensions come from an approved marketplace | **none** | — | `strictKnownMarketplaces` in managed settings |
| P69 | Versions below the approved minimum refuse to start | **none** | — | `requiredMinimumVersion`. A SessionStart version assertion is **not built** |
| P70 | Every gate decision is logged with a timestamp and verdict | report | JSONL ledger; `/sdlc-status` reports p50/p95 per gate | Local only. An OTel exporter is configurable but **the collector contract is documented, not shipped** |

## Stage 5 — CI/CD

| # | Policy | Status | Mechanism | Fallback |
|---|---|---|---|---|
| P71 | Gates exist before automation accelerates through them | guide | The rollout order in the README | Ordering axiom |
| P72 | Start with read-only judgement steps in CI; add writes behind gates | guide | Documented | Capability ladder |
| P73 | Agent jobs run sandboxed with short-lived scoped tokens | **none** | — | CI runner configuration |
| P74 | Deployment is exposed through MCP tools, scoped per environment | partial | `h10` denies deploy-shaped shell commands, forcing the MCP path | The allowlist itself is managed MCP |
| P75 | Autonomy is graded by environment | hard | `h10` allows non-production deploys and denies production | — |
| P76 | Rollback is the most-rehearsed path | report | `/release` confirms the runbook exists before proposing a release | Rehearsal is a practice, not a check |
| P77 | Each non-interactive run acts under the agent's own identity | **none** | — | CI identity provisioning |

## Stage 6 — Maintain

| # | Policy | Status | Mechanism | Fallback |
|---|---|---|---|---|
| P78 | Detection is deterministic; no model in the detection path | **none** | — | The autonomy-band harness is **not built** |
| P79 | Response tiers: 1σ log, 2σ read-only diagnose, 3σ propose only | **none** | — | `h13-approved-exits-guard` was designed for this and is **not built** |
| P80 | Approved exits are an enumeration, never a shell | **none** | — | Same |
| P81 | The monitoring agent writes a Stage-1 `intent.md` | level | `h08` validates machine-authored artifacts identically | The trigger harness is not built |
| P82 | Rejections feed back into retuning the bands | **none** | — | Nothing closes this loop |
| P83 | Tier boundaries enforced from version-controlled config | **none** | — | Managed settings deny production access |

---

## Summary

| Status | Count |
|---|---|
| hard — deterministic, unbypassable by the agent | 17 |
| level — deterministic, blocks at `standard` | 9 |
| ci — re-checked over a diff, trusts no local state | 12 (overlapping) |
| report / guide — surfaced or instructed; a human acts | 20 |
| **none — not implemented here** | **28** |

The 28 unimplemented policies fall into four groups, and none of them is an
oversight:

1. **Human judgement** (P04, P08, P10, P14, P32) — a gate can pause, not decide.
   This is the judgement the whole design exists to protect.
2. **Managed settings** (P61, P66, P68, P69, and parts of P65) — these sit
   *above* a plugin by design. A control layer distributed as an installable,
   disableable plugin cannot be the thing that constrains installation.
3. **Forge and CI infrastructure** (P02, P43–P48, P73, P77) — stage triggers,
   the eval suite and runner identity live outside any session. Scaffolding for
   these is the obvious next increment.
4. **Repository-specific semantics** (P23–P26, P42) — a generic plugin cannot
   judge whether an endpoint emits the right audit event. The seam exists;
   shipping at least one reference checker would make it more than a seam.

Groups 1 and 2 are permanent. Groups 3 and 4 are work not yet done, and are
listed as such rather than folded into a more flattering category.
