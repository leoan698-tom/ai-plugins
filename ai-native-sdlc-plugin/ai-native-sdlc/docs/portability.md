# Portability

Why this plugin is written the way it is. Every decision below exists because
the alternative fails **silently** on some platform — and a gate that silently
does not run is worse than no gate, because someone is relying on it.

## Every hook is exec form

```jsonc
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/pre-file.mjs"] }
```

With `args` present there is no shell, on any platform. That single choice
removes a whole family of failures at once:

| Failure it removes | What would otherwise happen |
|---|---|
| Git Bash vs PowerShell divergence | Shell-form commands go to `sh -c` on Unix, Git Bash on Windows, or **PowerShell when Git Bash is absent** — three syntaxes for one string |
| Quoting around paths with spaces | The plugin cache path on Windows sits under a user profile that routinely contains a space |
| `.cmd`/`.bat` shims | Exec form cannot spawn them on Windows; nothing here tries |
| Profile echoes corrupting stdout | Stdout that does not start with `{` is read as plain text and the decision is **silently discarded** |
| `${user_config.*}` rejection | Substituting it into a shell-run field makes the component fail to load outright |

The portability lint fails the build on any hook that is not `node` in exec
form.

## No jq, no Python, no bash

`jq` is not shipped with Claude Code or with Git for Windows. On this
development machine it is simply absent — verified, not assumed. A missing `jq`
exits **127**, and the runtime treats a non-zero, non-2 exit as a *non-blocking*
error: the tool call proceeds. **The gate fails open, with no message.**

The course's own reference `production-gate.sh` opens with
`jq -r '.tool_input.command'`, so on a stock Windows machine it would wave every
production deploy through.

Python is worse on Windows, where `python3` commonly resolves to a Microsoft
Store stub that exits 49 silently in a non-TTY subprocess.

Node parses stdin JSON in three lines with no dependencies, and is what the
official Windows hook examples use. `.mjs` files need no shebang and no
executable bit, so neither a lost `+x` on a Windows checkout nor CRLF conversion
can disable a gate.

## Shell gates match `Bash|PowerShell`

On Windows **without** Git Bash, Claude Code does not register the Bash tool at
all — shell calls arrive as `PowerShell`. A gate matching only `Bash` never
fires there, and never says so.

`lib/commands.mjs` therefore understands both syntaxes and maps PowerShell verbs
and aliases (`Remove-Item`, `Get-Content`, `Set-Content`, `Invoke-WebRequest`,
`iwr`, `del`, `type`) onto the POSIX behaviour the rules ask about. The lint
fails any matcher covering `Bash` without `PowerShell`.

## Paths are normalised before anything compares them

File tools deliver **absolute paths with native separators** — backslashes on
Windows, even under Git Bash. Comparing those against forward-slash globs
matches nothing, which for a deny rule means the edit goes through.

Every path passes through `normalise()` first: forward slashes, no duplicate
separators, case-folded on win32. Matching is done on path segments rather than
anchored with `^`, since the path is absolute.

The same rule bit the repository key: it reached `repoKey()` spelled both ways
depending on the caller, hashed to two different state file names, and a session
silently lost its fix-mode lock. A test caught it; `repoKey()` now canonicalises
unconditionally.

## Component paths use forward slashes

A backslash anywhere in a component path makes that component load on Windows
**only** — it is rejected outright on macOS and Linux. `.gitattributes` pins LF
for the same reason, and the lint fails on any CRLF in a source file.

## State goes in `CLAUDE_PLUGIN_DATA`

`CLAUDE_PLUGIN_ROOT` is version-scoped: it changes on every plugin update, and
the previous directory is swept roughly fourteen days later. Anything written
there is lost. `CLAUDE_PLUGIN_DATA` survives updates, and the lint fails any
write under the root.

## Tested, not asserted

`.github/workflows/plugin-ci.yml` runs the suite on **windows-latest,
macos-latest and ubuntu-latest**, with fixtures that include Windows-backslash
path variants. Windows is listed first deliberately: it is the platform with no
OS sandbox beneath the hooks, so it is where a gate failing open has no second
line.

Portability is regression-prone in a specific way — a contributor adds a bash
one-liner "just for this check", a matcher loses its `|PowerShell`, a path picks
up a backslash. None of that fails visibly. The matrix plus the lint is what
keeps it true.

## Known limits

- **Windows without Git Bash** is supported for the hooks themselves (exec form
  needs no shell), but the `run` and `format` commands a repository configures
  are its own strings and may assume a shell. `command_shell` in the repo config
  selects one explicitly.
- **Native Windows has no OS sandbox.** The hooks are the only enforcement layer
  there, which is why the safety-critical gates fail closed on internal error.
- **Node must be on `PATH` for hook processes.** This is the one dependency that
  cannot be designed away, and the one whose absence fails open. The self-test
  is the check that catches it.
