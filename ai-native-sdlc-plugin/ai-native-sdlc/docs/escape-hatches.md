# Escape hatches

Every way this plugin's enforcement can be switched off, weakened or stepped
around — with the signal that reveals it.

This document exists because a security control whose limits are undocumented
gets trusted past them. If you are going to tell an auditor, a tech lead or a
teammate what these gates guarantee, this is the page that keeps the claim true.

## The one-sentence version

> The gates are unbypassable by the **agent**. They are not unbypassable by a
> **person**. Without organisation-deployed managed settings, the CI re-check is
> the only control that holds everywhere.

## Why the agent cannot bypass them

A `PreToolUse` hook returning `permissionDecision: "deny"` fires **before any
permission-mode check**. It holds in `bypassPermissions` mode and under
`--dangerously-skip-permissions`. A session cannot widen its own permissions
past a hook denial, and it cannot write the hook process's environment, so the
release authorization variable cannot be forged from inside a session.

The plugin also closes the obvious second paths:

| Route around a file gate | Covered by |
|---|---|
| `sed -i`, redirects, `Set-Content`, `git checkout --` | `h14-shell-write-shadow` |
| Anything else that changed the tree | `h24-turn-scanner` at every turn end |
| A subagent doing it instead | Plugin hooks run inside subagents; `h26` + `h27` |
| A copied agent file with write tools added | `h26-agent-type-write-deny` checks `agent_type`, not the file |
| Editing the policy file to allow it | `h25-config-self-protection` |
| `git config core.hooksPath`, git aliases | `h11-branch-protection-guard` |

## How a person switches them off

All of these are available to anyone on the machine. None is a defect; they are
documented runtime features, and pretending otherwise would be the defect.

| Route | Effect | Signal that it happened |
|---|---|---|
| `/plugin disable ai-native-sdlc` | Everything stops | The SessionStart status line disappears |
| `"disableAllHooks": true` in any settings file | All hooks stop, plugin's included | Same. `/sdlc-doctor --selftest` fails every case |
| `claude --settings '{"disableAllHooks":true}'` | Same, for one run | Same |
| **Node not on PATH** | Every hook exits 127 — a **non-blocking** error, so the tool call proceeds. **Every gate fails open, silently** | `/sdlc-doctor` reports the Node check; the self-test fails |
| `enforcement_level: advisory` | Class B and C warn instead of blocking. **Class A is unaffected** | Every ledger line carries `level`; `/sdlc-status` shows what would have blocked |
| `hard_hooks_locked: false` | Repository config may weaken the always-hard set | `/sdlc-doctor` warns; `/sdlc-status` shows it in the header |
| Editing `.claude/sdlc/config.json` **outside a session** | Any glob can be narrowed | It is a reviewed file: the diff shows up in the PR |
| `git commit --no-verify` outside Claude Code | Local git hooks skipped | `sdlc-verify` in CI still runs |

**There is no way to disable a single hook** while keeping the others. The
runtime offers all-or-nothing, so a team that finds one gate intolerable will
reach for `disableAllHooks` and lose the credential scanner along with it. That
is why `enforcement_level` and the tighten-only local override exist: they give
a narrower answer than switching everything off.

## The enterprise trap

If your organisation sets `allowManagedHooksOnly: true`, **user, project, local
AND plugin hooks are all blocked** — unless the plugin is force-enabled in
managed `enabledPlugins`. Without that one line, this plugin installs cleanly,
reports itself active, and enforces nothing.

```jsonc
{
  "allowManagedHooksOnly": true,
  "enabledPlugins": { "ai-native-sdlc@sdlc-playbook": true }  // ← without this, every gate is dead
}
```

`/sdlc-doctor --selftest` is the check that catches it, because it tests firing
rather than configuration.

## What the gates do not claim

**The production gate is an honesty gate.** It verifies that a release
authorization is *present and well-formed*, not that it is *genuine*. The agent
cannot forge it; the human who launched the session set it. For a real
guarantee the deploy credential belongs in CI or behind an environment-scoped
MCP tool, where the session cannot reach it at all. The block message says this
rather than implying more.

**The command gates are recognisers, not a shell.** They parse subcommands,
understand quoting, and know PowerShell aliases. They cannot see through
base64, `eval`, a script file, or a binary that does the same thing. They raise
the cost of stepping around a policy; they do not make it impossible.

**The secret scanner is pattern-based.** It catches the common key formats and
credential-shaped assignments. A novel format, or a secret split across lines,
will pass. Rotate anything that was ever committed.

**Read protection has a hole a hook cannot close.** Files pulled in with an `@`
reference are added *without a tool call*, so no `PreToolUse` hook ever fires
for them — including one matching `Read`. Only a `permissions.deny` rule covers
that path, which is why `/sdlc-init` writes those rules into the repository's
settings and `/sdlc-doctor` checks they are still there.

**Native Windows has no sandbox.** OS-level filesystem and network isolation is
unsupported there, so on Windows these hooks are the *only* enforcement layer.
That is exactly why Class A fails **closed** on internal error: allowing on
error would leave no second line at all.

## What to do about all of this

In rough order of value:

1. **Make `sdlc-verify` a required status check.** It re-runs the deterministic
   checks over a diff, trusting no local state, so it holds on machines where
   the plugin was never installed and on branches where hooks were off.
2. **Turn on server-side branch protection**, and verify it with
   `/sdlc-doctor` rather than assuming. The local push gate stops the agent, not
   another git client.
3. **Deploy managed settings** if you can. That is the only layer a local user
   cannot override — see [managed-settings.md](managed-settings.md).
4. **Run `/sdlc-doctor --selftest` in onboarding and periodically.** It converts
   "we installed it" into a test result.
