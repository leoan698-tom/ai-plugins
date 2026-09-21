---
name: sdlc-init
description: Set up the AI-native SDLC playbook in this repository. Use when the user asks to "set up the SDLC plugin", "configure ai-native-sdlc", "initialise the playbook", "run sdlc init", "reconfigure the SDLC gates", or "upgrade the SDLC scaffold". Detects the stack, interviews for the repository-specific values, writes the policy config, CLAUDE.md, REVIEW.md and the artifact home, merges the safe inner loop into project permissions, and then PROVES the gates actually fire.
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Edit, AskUserQuestion, Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *), Bash(git config:*), Bash(git status:*), Bash(git rev-parse:*)
argument-hint: "[--reconfigure | --upgrade]"
---

# Set up the AI-native SDLC playbook

This is user-invoked only. It writes the file that constrains every later
session, so a model must not be able to trigger it — and the config
self-protection gate denies edits to that file unless this skill set the
maintenance flag.

## What you are setting up

The playbook turns each stage of the lifecycle into a committed artifact, and
each policy into a deterministic gate. Nothing repository-specific lives in the
plugin: it all lives in one reviewed file in this repo, which is what lets the
same plugin serve every repository without a fork.

## Steps

### 0. Preflight

Run `node ${CLAUDE_SKILL_DIR}/run.mjs doctor --json` and read it. Then:

- If a policy file already exists and `--reconfigure` was not passed, say so and
  ask whether to reconfigure, upgrade the scaffolded templates, or stop.
- If Node is below 18 or git is missing, stop and say why: every gate runs on
  Node, and a missing interpreter makes all of them fail open silently.

Set the maintenance flag so you are allowed to write the config:
`node ${CLAUDE_SKILL_DIR}/run.mjs state set --session <session_id> --key maintenance --value true`

### 1. Detect the stack and propose commands

Read whichever of these exist: `package.json`, `pyproject.toml`, `go.mod`,
`pom.xml`, `build.gradle`, `Cargo.toml`, `*.csproj`, `Makefile`, `justfile`.
Propose build, test, lint, format and run commands from what you find, and read
the scripts section rather than assuming the ecosystem default — a repository's
real test command is frequently not `npm test`.

Use **AskUserQuestion** to confirm or correct them. The test command is the one
that matters: without a single command that exits non-zero on failure, nothing
can prove a change works, and the Stop gate has nothing to check.

### 2. Ask for the repository's own values

One AskUserQuestion round each, with your detected values pre-filled:

- **Artifact home** (default `intent/`) and the **default branch**
- **Protected paths**: generated directories, frozen packages and their
  successors, dependency manifests, migrations, infrastructure
- **Test path globs**, seeded from the stack
- **Owners**: who owns dependency bumps, who grants a release authorization,
  what a change ticket looks like

Propose; do not assume. Every glob you invent that does not match reality is a
false denial waiting to happen, and false denials are how a team decides the
plugin is broken.

### 3. Capture an example of healthy output

Run the test command **once**, in the foreground, and show the user its output.

Then propose a `healthy_regex` from what a passing run actually printed, and ask
them to confirm it. This is Lesson 8 step 2, and it is the thing that
distinguishes "passed" from "passed but skipped 40 cases" — a plain exit code
cannot tell those apart, and the documented Bash tool response carries no exit
code at all, so without this pattern the Stop gate must re-run the suite every
single turn.

If the test command fails here, say plainly that the feedback loop is not closed
yet and that this is the first thing to fix. Do not paper over it.

### 4. Write the files

Write these, never overwriting a file that differs from what the scaffold last
wrote — offer `<name>.sdlc-proposed` beside it instead:

- `.claude/sdlc/config.json` — everything from steps 1 and 2
- `CLAUDE.md` — create from the template, or, if one exists, append only the
  "Verifying your work" block with the commands and the healthy-output example
- `REVIEW.md` — the three review passes, the Important definition, the nit cap
- `<intent home>/README.md` and `<intent home>/_templates/{intent,spec,plan}.md`
- `.gitignore` entries for `.claude/sdlc/config.local.json` and
  `.claude/settings.local.json`
- `.claude/.sdlc-scaffold.json` — records a hash per written file so a later
  plugin version can update what nobody touched and propose a diff for the rest

Merge into `.claude/settings.json` (never replace it):

- `permissions.allow` — the exact build, test, lint and git commands from step 1.
  A plugin cannot ship permission rules, and an unpaired deny list turns into
  prompt fatigue, which is the documented route to someone disabling hooks
  entirely.
- `permissions.deny` — `Read` rules for the secret paths. Files pulled in with an
  `@` reference never fire a PreToolUse hook, so this rule is their **only**
  coverage.

Show the settings merge as a diff and get confirmation before writing it.

### 5. PROVE IT

Run `node ${CLAUDE_SKILL_DIR}/run.mjs selftest` and show the table.

This replays synthetic payloads through the real hooks and asserts each decision:
a fake credential is denied, a push to the default branch is denied, a test edit
under a simulated fix lock is denied, an unauthorised production deploy is denied,
an ordinary edit is allowed.

"The configuration looks right" is not evidence that a control is live. This is.
If any case fails, work through the causes it prints — the usual one is that the
plugin is not enabled in this session, or that Node is not on PATH for hook
processes.

### 6. Clear maintenance and hand over

Clear the flag:
`node ${CLAUDE_SKILL_DIR}/run.mjs state set --session <session_id> --key maintenance --value false`

Then run `doctor` once more, show it, and tell the user:

- to commit the scaffold as a pull request — each stage ends by committing its
  artifact, and this one is no exception
- that `sdlc-verify` should become a required status check, because without
  organisation-deployed managed settings the local hooks can be switched off by
  anyone, and the CI re-check is the control that holds everywhere
- what to do next: `/ai-native-sdlc:plan` for the first change, or
  `/ai-native-sdlc:fix` for the first bug

## Be honest about the limits

When asked what this guarantees, say it plainly: the gates are unbypassable by
the *agent*, because a PreToolUse deny fires before any permission check. They
are not unbypassable by a *person* — `/plugin disable` and `disableAllHooks`
remain available. That is why the CI check matters.
