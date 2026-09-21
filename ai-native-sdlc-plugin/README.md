# ai-native-sdlc

A Claude Code plugin that enforces the [AI-native SDLC
playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook/introduction)
as deterministic gates rather than as advice.

**Skills carry the knowledge. Hooks carry the enforcement.** The course is
explicit about the difference: a skill makes a violation rare, a hook makes it
close to impossible. Everything here follows from taking that seriously.

[中文说明](README.zh.md)

---

## What it actually guarantees

Read this before anything else, because a control whose limits are unclear gets
trusted past them.

> **The gates are unbypassable by the agent.** A `PreToolUse` denial fires before
> any permission-mode check, so it holds even under `bypassPermissions` and
> `--dangerously-skip-permissions`. A session cannot widen its way past one, and
> it cannot write the hook process's environment, so the release authorization
> cannot be forged from inside a session.
>
> **They are not unbypassable by a person.** `/plugin disable`,
> `disableAllHooks` and `--settings` stay available unless your organisation
> deploys managed settings. A missing Node interpreter exits 127, which the
> runtime treats as a *non-blocking* error — so on a machine without Node,
> every gate fails open silently.
>
> **Therefore `sdlc-verify` in CI is the primary control** unless you deploy
> managed settings. It re-runs the same deterministic checks over a diff,
> trusting no local state, so the policy set holds on machines where the hooks
> never ran at all.

The full list of bypass routes, each with the signal that reveals it, is in
[escape-hatches.md](ai-native-sdlc/docs/escape-hatches.md). Every policy in the
playbook, against the mechanism that implements it — including the 28 this
plugin does **not** implement — is in
[ENFORCEMENT-MATRIX.md](ai-native-sdlc/docs/ENFORCEMENT-MATRIX.md).

## Install

```bash
/plugin marketplace add <your-org>/ai-native-sdlc-plugin
/plugin install ai-native-sdlc@sdlc-playbook
```

Then, in the repository you want to protect:

```
/ai-native-sdlc:sdlc-init
```

It detects your stack, interviews you for the repository-specific values, writes
the policy file and the scaffold — and then **proves the gates actually fire** by
replaying synthetic payloads through the real hooks:

```
PASS  credential in a diff is denied                     expected deny, got deny
PASS  push to the default branch is denied               expected deny, got deny
PASS  production deploy without authorization is denied  expected deny, got deny
PASS  test edit during a locked fix is denied            expected deny, got deny
PASS  an ordinary source edit is allowed                 expected allow, got allow

11/11 gates fired as expected. The enforcement layer is live.
```

"The configuration looks right" is not evidence that a control is live. That is.

**Requires Node 18+** on `PATH` for hook processes. This is load-bearing: a
missing interpreter makes every gate fail open, quietly.

## The artifact chain

Each stage ends by committing an artifact; the next stage begins by reading it.
The chain of commits is the audit trail.

```
intent.md → spec.md → plan.md → diff + tests → PR + findings
```

| Command | Stage | What it does |
|---|---|---|
| `/ai-native-sdlc:intent` | Plan | Brainstorms, then writes `intent.md` in the originator's words |
| `/ai-native-sdlc:spec` | Design | Requirements and design in one pass, constrained by your policy skills, concerns flagged |
| `/ai-native-sdlc:plan` | Build | Interrogates the plan, then writes `plan.md` with the files that change |
| `/ai-native-sdlc:fix` | Test | Failing test first, committed, then the test files go read-only |
| `/ai-native-sdlc:verify` | Test | Runs the checks, pastes the literal output, then an independent verifier |
| `/ai-native-sdlc:pr-review` | Deploy | Your `REVIEW.md` passes as a local dry run |
| `/ai-native-sdlc:release` | Deploy | Prepares a release up to the production gate, never through it |

Plus `sdlc-doctor`, `sdlc-status`, `gates` and `review-tune`.

## The gates

**Always hard** — these ignore `enforcement_level` entirely and fail **closed**
on internal error, because on native Windows there is no OS sandbox beneath
them and they are the only layer:

- credentials in a diff (the block names the pattern and line, never the value)
- secret file reads, through the file tools *and* through the shell
- production deploys without a named release authorization
- pushes to protected branches, force pushes, `--no-verify`, self-approval, self-merge
- the fix-mode test lock — enforced at the file tools, the shell, and by hash comparison at every turn end
- generated, frozen, lockfile, migration and infrastructure paths
- writes to the plugin's own configuration
- writes from a read-only agent type

**Level-dependent** — block at `standard` (the default), warn at `advisory`:
artifact structure, plan/implementation synchronisation, verification evidence,
network egress.

Configure with `enforcement_level`. The knob is an adoption dial over hygiene;
it never touches the always-hard set.

## Verification evidence

The documented shell tool response carries `stdout`, `stderr` and `interrupted`
— **no exit code**. A `PostToolUse` hook therefore cannot learn whether the
tests passed; it can only match output text, and text matching can record a
*false green*, which is a silent bypass of the whole gate.

So the Stop gate is hybrid:

1. **Record** a verdict after a verify command runs, with a content hash of the tree
2. **Trust** it while the tree still hashes the same — nothing re-runs
3. **Re-run** for a real exit code once the tree has moved

Content hash, not mtime: the formatter rewrites files after an edit, which would
otherwise invalidate every green record.

## CI

```yaml
- run: node ai-native-sdlc/bin/sdlc-verify.mjs --base origin/main --head HEAD
```

Make it a required status check. It re-runs credentials, protected paths,
disabled tests, `CLAUDE.md` size, artifact structure, plan drift and artifact
authorship over the diff, trusting no local state, and exits non-zero on a
violation.

## Portability

Every hook is exec form (`node` + `args`), so **no shell is involved on any
platform**: no Git-Bash-versus-PowerShell divergence, no quoting hazards, no
`.cmd` shim problem, and no `jq` dependency — a missing `jq` exits 127, which
fails open. Shell gates match `Bash|PowerShell` because on Windows without Git
Bash the Bash tool is never registered. Paths are normalised before matching.
`.gitattributes` pins LF so a Windows checkout cannot corrupt a script.

Tested on windows-latest, macos-latest and ubuntu-latest.

## Configuration

Nothing repository-specific lives in the plugin. Three layers:

| Layer | Where | Who changes it |
|---|---|---|
| Organisation | plugin `userConfig` (9 scalar keys) | enable-time prompt, or managed settings |
| Repository | `.claude/sdlc/config.json` | the team, through PR review |
| Personal | `.claude/sdlc/config.local.json` (gitignored) | you — **may only tighten, never loosen** |

The tighten-only rule is structural: protective lists are unioned rather than
replaced, and the level can only move upward. Someone who wants to run stricter
than their team has somewhere to go; someone who wants to run looser has to
change a reviewed file.

## Development

```bash
cd ai-native-sdlc
npm test                       # 80 tests, including real hook processes
node tests/portability-lint.mjs
node scripts/selftest.mjs      # prove the gates fire
claude plugin validate . --strict
```

Local loop: `claude --plugin-dir ./ai-native-sdlc`, then `/reload-plugins`.

## Licence

MIT.
