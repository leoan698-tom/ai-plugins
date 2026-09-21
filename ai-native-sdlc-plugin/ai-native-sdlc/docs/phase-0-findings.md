# Phase 0 findings

The plan flagged six assumptions the official documentation does not confirm. A
design that rests on an unconfirmed assumption fails *silently*, so each one is
resolved here before it becomes load-bearing.

Environment: Windows 11, Git Bash, Claude Code **2.1.278**, Node **v24.18.0**,
git 2.55.0. `jq` absent.

Sources used: the authoritative tool schemas shipped inside the CLI package
(`@anthropic-ai/claude-code/sdk-tools.d.ts`), plus `claude plugin validate`.

---

## C — `MultiEdit` / `NotebookEdit` input shapes → **RESOLVED**

The SDK type definitions declare `FileEditInput`, `FileWriteInput`,
`FileReadInput` and `NotebookEditInput`. **There is no `MultiEditInput`.** The
string `MultiEdit` does appear in the CLI binary, so the name is still
recognised, but it has no published schema and must not be relied on.

```ts
FileEditInput      { file_path, old_string, new_string, replace_all? }
FileWriteInput     { file_path, content }
NotebookEditInput  { notebook_path, cell_id?, new_source, cell_type?, edit_mode? }
```

**Two consequences for every file gate — both are silent-bypass bugs if missed:**

1. **`NotebookEdit` carries `notebook_path`, not `file_path`.** A path check that
   reads only `tool_input.file_path` sees `undefined` for every notebook edit and
   waves it through. Path extraction must be `file_path ?? notebook_path`.
2. **Notebook content is `new_source`,** not `content` or `new_string`. The
   credential scanner must read all three, or a secret pasted into a notebook
   cell is never scanned.

There is no documented `edits[]` array anywhere. The design's deep-string-walk
fallback stays, and `unparseable_tool_input` defaults to **deny**, so an
undocumented future shape fails closed rather than open.

## E — `Bash` / `PowerShell` response shape → **RESOLVED, and it confirms the problem**

```ts
BashOutput { stdout, stderr, interrupted, isImage?, rawOutputPath?,
             backgroundTaskId?, backgroundedByUser?, timedOutAfterMs?, ... }
```

**There is no exit-code field.** A `PostToolUse` hook therefore cannot learn
whether `npm test` passed; it can only match the output text. Recording a green
verdict from text alone can record a *false green*, and a false green is a silent
bypass of "run the tests before reporting a task complete".

This confirms the hybrid design: trust the recorded verdict while the working
tree is unchanged, and **re-run the verify command in the Stop hook once the tree
content hash no longer matches the last green record**. Content hash, not mtime —
mtime races against the plugin's own formatter hook.

`PowerShell` has no entry in the SDK types (it is a platform-conditional tool),
but the documentation states its input shape is identical to `Bash`. Treated as
Bash-shaped; its response shape is presumed identical and is re-checked in the
live probe.

## Live session verification

Run against Claude Code 2.1.278, authenticated, with the plugin loaded through
`--plugin-dir` into a throwaway repository. Every case below is a real session
making a real tool call, not a replayed payload.

| Attempt | Outcome | Evidence |
|---|---|---|
| `Write src/config.ts` containing an AWS key | **blocked** | File absent afterwards; the runtime recorded a `permission_denials` entry; Claude quoted the first line of the block message back |
| `git push origin main` | **blocked** | Claude reported the branch as protected and repeated the route (feature branch + PR) |
| `Write src/v1/Handler.ts` (frozen path) | **blocked** | Block named the configured successor, `src/v2/` |
| `Write intent/demo/plan.md` with no sections | **blocked** | Block listed exactly which sections were missing |
| `Write intent/demo/intent.md` with **Chinese headings** | **allowed** | 问题 / 提议的结果 / 受影响的用户和系统 / 约束 / 开放问题 satisfied the schema |

The decision ledger recorded both denials in the intended shape:

```
h03-credential-guard        cls=A deny hard=True file=src/config.ts cmd=-        1ms  secret:aws-access-key-id
h11-branch-protection-guard cls=A deny hard=True file=-             cmd=fbd837b4 1ms  push-protected:main
```

Note what is and is not there: the path is repo-relative rather than absolute,
the command is a hash rather than its text, and rule evaluation is **1 ms**. The
~60 ms per hook measured earlier is Node process startup, not policy work —
which is the whole argument for one dispatcher per event rather than one process
per rule.

### Two findings that only a live run could produce

**`--plugin-dir` and a marketplace install do not share state.** A plugin loaded
in place gets the data directory `ai-native-sdlc-inline`; installed from a
marketplace it would be `ai-native-sdlc-sdlc-playbook`. Fix-mode locks, the
verification ledger and the decision log **do not carry over** between the two.
Anyone who develops against `--plugin-dir` and then installs properly starts
with empty state, and should not read that as the plugin having lost anything.

**`userConfig` values are not populated under `--plugin-dir`.** The probe
recorded **zero** `CLAUDE_PLUGIN_OPTION_*` variables in the hook environment.
Those values come from the enable-time prompt, which a directory load never
runs, so every hook falls back to its built-in default. Development against
`--plugin-dir` therefore exercises *default* behaviour, not *configured*
behaviour — a level pinned to `advisory` or a custom approval variable will not
be in effect. Test configured behaviour through an actual install.

Observed `SessionStart` stdin fields: `cwd`, `hook_event_name`, `session_id`,
`source`, `transcript_path`. No `scratchpad_dir` and no `permission_mode` on
this event.

## A — does `PreToolUse` fire for `ExitPlanMode`? → **STILL OPEN**

`ExitPlanModeInput` exists, but whether the event fires a `PreToolUse` hook
cannot be determined from the schemas, and the CLI ships as a compiled binary.

A headless attempt with `--permission-mode plan` did not settle it either:
**`ExitPlanMode` is not in the tool set of a `-p` session**, so the event never
had a chance to fire. Answering this needs an *interactive* session that enters
plan mode and accepts a plan.

The probe remains registered on `matcher: "ExitPlanMode"`, so the first
interactive plan acceptance with this plugin loaded records the answer to
`${CLAUDE_PLUGIN_DATA}/probe/probe.jsonl`. Read it with
`node scripts/probe-report.mjs`.

It gates one Class B check, which has a fallback that is already built and
tested (`h08` validates the plan when `plan.md` is written, and `sdlc-verify`
re-checks it over the diff). **Nothing in Class A depends on it.**

## B — are `sensitive: true` userConfig values exported to hooks? → **DEFERRED, already non-load-bearing**

Needs a live session. The approval mechanism is a named environment variable and
block messages label it *weak* (self-asserted by whoever launched the session),
so the HMAC path is interface-only and this assumption carries no weight in v1.

## D — `${CLAUDE_PLUGIN_ROOT}` inside skill `allowed-tools` → **DEFERRED to Phase 4**

Mitigation already chosen: each skill invokes a `${CLAUDE_SKILL_DIR}/run.mjs`
shim, and that substitution *is* documented.

## F — plugin hooks are not de-duplicated against identical project hooks → **CONFIRMED by docs**

A repository that also keeps the course's own `.claude/settings.json`
production gate gets both, and both fire. Duplicate denials are harmless but the
message appears twice and there are two sources of truth. `/sdlc-doctor` detects
the overlap and points at the redundant file.

---

## Findings not in the original list

**Marketplace names may not impersonate an official Anthropic marketplace.**
`claude plugin validate` rejected `"name": "claude-plugins"` with
*"Marketplace name impersonates an official Anthropic/Claude marketplace"*.
The marketplace is named **`sdlc-playbook`**, which makes the install key:

```
ai-native-sdlc@sdlc-playbook
```

That exact string goes into `enabledPlugins`, `strictKnownMarketplaces` and every
install command in the docs.

**The npm-installed CLI does not share the desktop app's credentials.** A fresh
`npm i -g @anthropic-ai/claude-code` reports *"Not logged in"*, so the headless
probe (`claude -p --plugin-dir …`) needs a one-time interactive `/login`. That is
the only step in Phase 0 that cannot be automated.

**CLI 2.1.278 clears every version floor** the design depends on: `userConfig`
`options` (2.1.271+), comma matcher separator (2.1.191+), `plugin validate` on
bare directories (2.1.233+), exec-form hook commands and the `shell` field.
