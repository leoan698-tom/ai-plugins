# Changelog

Every entry that adds or changes an **always-hard** gate is called out
explicitly. Those are the ones that can block work without warning after an
update, and a team discovering a new hard gate by being blocked by it is how a
plugin loses its welcome.

## 0.0.1 — unreleased

First build. Verified end to end in a live authenticated session: the credential
gate, the protected-branch gate, the frozen-path gate and the artifact-structure
gate all held, a Chinese-language `intent.md` was correctly accepted, and the
decision ledger recorded both denials in the intended shape. See "Known gaps"
below for what is still open.

### Always-hard gates (ignore `enforcement_level`, fail closed on error)

- `h03-credential-guard` — credential-shaped literals in new content
- `h04-test-lock` — test edits during a locked fix; added skip markers any time
- `h05-protected-path-guard` — generated, frozen, lockfile, manifest version,
  migration and infrastructure paths
- `h07-artifact-home-guard` — artifacts must live in the intent home
- `h09-secret-read-guard` / `h06-shell-secret-read` — secret reads via the file
  tools and via the shell
- `h10-production-gate` — production deploys without a release authorization
- `h11-branch-protection-guard` — protected-branch pushes, force pushes,
  `--no-verify`, `gh pr merge`, `gh pr review --approve`, `git config
  core.hooksPath` and alias tampering
- `h14-shell-write-shadow` — the file gates cannot be stepped around with
  `sed -i`, redirects or `git checkout --`
- `h24-turn-scanner` — working-tree scan at every turn end, covering changes made
  by any route
- `h25-config-self-protection` — the agent cannot edit the configuration that
  constrains it
- `h26-agent-type-write-deny` / `h27-subagent-stop-diff` — read-only agents are
  contained even if their definition is copied and given write tools
- Unrecognised `tool_input` shapes fail closed

### Level-dependent gates

- `h08-artifact-structure` — required sections, with **bilingual (zh/en) heading
  aliases**
- `h23-verify-evidence-gate` — hybrid: trust a recorded pass while the tree
  content hash matches, otherwise re-run for a real exit code
- `h28-egress-guard` — network egress; localhost always allowed
- `h21-verification-recorder` — records evidence, and will not engage the fix
  lock until a **failing** run is on record

### CLI

- `bin/sdlc-verify.mjs` — re-runs the deterministic checks over a diff range,
  trusting no local state. **This is the primary control without managed
  settings.**
- `scripts/selftest.mjs` — replays synthetic payloads through the real hooks and
  asserts each decision
- `sdlc doctor` — repository readiness, including a read-only check that
  **server-side branch protection actually exists**
- `sdlc status` — p50/p95 per gate, the wait-time-per-gate metric
- `sdlc scaffold` — templating with a manifest, so a later version can update
  untouched files and propose diffs for edited ones

### Skills and agents

13 skills covering the artifact chain plus operations and governance; 4 agents
whose separation of duties is a `tools:` whitelist rather than an instruction.

`sdlc-init`, `fix`, `review-tune` and `release` are `disable-model-invocation`.
`fix` most of all: if the model could invoke it, the model could enter and leave
its own test lock, and the protection would dissolve into a suggestion.

### Verified against the runtime

Claude Code 2.1.278 ships tool schemas that settled two undocumented questions:

- **`NotebookEdit` uses `notebook_path` and `new_source`**, not
  `file_path`/`content`. A gate reading only `file_path` sees `undefined` for
  every notebook edit and allows it. There is no `MultiEditInput` schema at all.
- **The shell tool response carries no exit code.** Verification evidence read
  from output text alone can record a false green, which is why the Stop gate
  re-runs on a changed tree.

Both are pinned as regression tests. See
[phase-0-findings.md](ai-native-sdlc/docs/phase-0-findings.md).

### Known gaps

Stated plainly rather than folded into a friendlier category. Full detail in
[ENFORCEMENT-MATRIX.md](ai-native-sdlc/docs/ENFORCEMENT-MATRIX.md).

- **Unverified:** whether `PreToolUse` fires for `ExitPlanMode`. `ExitPlanMode`
  is not in the tool set of a headless `-p` session, so this needs an
  *interactive* plan acceptance. A probe is registered and records the answer on
  first real use. The plan gate falls back to validating `plan.md` when it is
  written, which is built and tested.
- **`--plugin-dir` does not populate `userConfig`.** A directory load never runs
  the enable-time prompt, so every hook uses its built-in default. Development
  against `--plugin-dir` exercises default behaviour, not configured behaviour.
  It also uses a different data directory (`-inline`), so state does not carry
  over to a marketplace install.
- **Not built:** the PostToolUse formatter and `CLAUDE.md` size hooks (the CI
  check covers the latter); eval scaffolding (P43–P48); the autonomy-band
  harness (P78–P83); forge workflows for stage triggers (P02); a reference API
  policy checker (P23–P26).
- **Honest limit:** the production gate verifies that an authorization is
  present and well-formed, not that it is genuine.
