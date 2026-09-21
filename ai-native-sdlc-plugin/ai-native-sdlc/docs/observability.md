# Observability

## Why this is specified rather than left to each repository

Lesson 11 makes **wait time per gate** the leading metric for an enforcement
layer, precisely so that a gate's price is visible to the people who own the
policy. A gate whose cost nobody measures is a gate that gets switched off the
week it becomes annoying.

That only works if several repositories emit the *same shape*. Five teams
emitting five different record formats cannot be aggregated into one
wait-time-per-gate view, and the metric never leaves the laptop. So the schema
below is fixed.

## Where the ledger lives

`${CLAUDE_PLUGIN_DATA}/logs/decisions-YYYY-MM-DD.jsonl`

One JSON object per line, appended. `SessionStart` prunes files older than
`log_retention_days` (default 30).

`CLAUDE_PLUGIN_DATA` resolves to `~/.claude/plugins/data/<plugin-id>/` and
survives plugin updates. Nothing is written under `CLAUDE_PLUGIN_ROOT`: that
path is version-scoped and documented as ephemeral.

## Record schema (v1)

```jsonc
{
  "ts": "2026-09-20T22:41:07.913Z",  // ISO-8601, from the hook's own clock
  "v": 1,                            // schema version
  "hook": "pre-file",                // dispatcher that ran
  "rule": "h03-credential-guard",    // stable rule id
  "cls": "A",                        // A | B | C
  "event": "PreToolUse",
  "tool": "Write",
  "decision": "deny",                // allow | deny | warn | block | error | escalated
  "hard": true,                      // did this ignore enforcement_level
  "level": "standard",               // level in force at the time
  "session": "abc123",
  "agent": "verifier",               // agent_type when inside a subagent, else null
  "repo": "a1b2c3d4",                // sha1-8 of the repo key — hashed, not the path
  "file": "src/config.ts",           // repo-relative, never absolute
  "cmd": "9f8e7d6c",                 // sha1-8 of the command — never the text
  "duration_ms": 41,
  "detail": "secret:aws-access-key-id"  // short reason id, not prose
}
```

## What is deliberately absent

No command text. No file contents. No secret material. No ticket bodies.
Repository paths are hashed, and commands are hashed rather than recorded.

This is so the ledger can be shipped to an observability stack **without a
redaction review**. A decision log that contains secrets is a new place secrets
live, and a gate that leaks what it blocked has defeated itself.

The cost is real: you can tell that a credential gate fired on `src/config.ts`,
but not which credential. That is the right trade — the engineer who hit the
block already saw the reason, and the aggregate view does not need it.

## Deriving the metrics

| Metric | How |
|---|---|
| Wait time per gate | `p50`/`p95` of `duration_ms` grouped by `rule` |
| Which gates fire most | count of `decision=deny` by `rule` — usually a config problem, not a discipline problem |
| Would-have-blocked | `decision=warn` and `cls=B` while `level=advisory` — the evidence for escalating |
| Days in advisory | earliest `ts` with `level=advisory` since the last `standard` record |
| Gate error rate | `decision=error`, or `detail` starting `rule-error` — a Class A error means a fail-closed denial happened |
| Fix cycles | `rule=h21-fix-lock`, `detail` starting `locked:` |

`/ai-native-sdlc:sdlc-status` computes all of these locally.

## Shipping it off the machine

Set `telemetry_forward_command` in the plugin's user config to any command that
takes the ledger directory. Nothing is forwarded by default — a decision log
leaving a developer's machine is a privacy question, and the default answer to
a privacy question should be "no".

### OpenTelemetry collector

A `filelog` receiver is enough; the records are already structured.

```yaml
receivers:
  filelog:
    include: [ '${env:HOME}/.claude/plugins/data/*/logs/decisions-*.jsonl' ]
    operators:
      - type: json_parser
        timestamp: { parse_from: attributes.ts, layout_type: gotime, layout: 'RFC3339' }

processors:
  attributes/rename:
    actions:
      - { key: sdlc.rule,     from_attribute: rule,        action: upsert }
      - { key: sdlc.class,    from_attribute: cls,         action: upsert }
      - { key: sdlc.decision, from_attribute: decision,    action: upsert }
      - { key: sdlc.level,    from_attribute: level,       action: upsert }
      - { key: sdlc.repo,     from_attribute: repo,        action: upsert }
      - { key: sdlc.duration, from_attribute: duration_ms, action: upsert }

exporters:
  otlp: { endpoint: '${env:OTEL_EXPORTER_OTLP_ENDPOINT}' }

service:
  pipelines:
    logs:
      receivers: [filelog]
      processors: [attributes/rename]
      exporters: [otlp]
```

### Before you turn it on

Decide three things and write them down:

1. **Retention** — `log_retention_days` controls the local copy only; the
   collector has its own.
2. **Who can read it.** The ledger shows which engineer hit which gate and how
   often. That is performance-adjacent data, and it will be read that way
   whether or not it was meant to be.
3. **What it is for.** The course's use is tuning the gates — finding the one
   that fires constantly because a glob is too broad. Used for anything else it
   stops being a diagnostic and starts being surveillance, and people will
   quietly stop running the plugin.
