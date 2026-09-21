/**
 * Decision ledger.
 *
 * Lesson 11 makes *wait time per gate* the leading metric for whether an
 * enforcement layer is sustainable, and Lesson 7 measures steering time from the
 * OpenTelemetry export. Neither is answerable unless every decision is recorded
 * with a timestamp and a duration, so each hook appends exactly one line here.
 *
 * What is deliberately NOT recorded: command text, file contents, secret
 * material, ticket bodies. Paths are repo-relative and commands are hashed. The
 * ledger is meant to be shippable to an observability stack without a redaction
 * review, and a ledger that contains secrets is a new place secrets live.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SCHEMA_VERSION = 1;

function logDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA
    || join(process.env.TEMP || process.env.TMPDIR || '.', 'ai-native-sdlc-data');
  const d = join(base, 'logs');
  mkdirSync(d, { recursive: true });
  return d;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const short = (s) => (s ? createHash('sha1').update(String(s)).digest('hex').slice(0, 8) : null);

/**
 * Append one decision record.
 *
 * Field names are fixed and documented in docs/observability.md so several
 * repositories emit the same shape and can be aggregated into one
 * wait-time-per-gate view — otherwise the metric never leaves the laptop.
 */
export function record(entry) {
  if (process.env.CLAUDE_PLUGIN_OPTION_LOG_ENABLED === 'false') return;
  try {
    const line = {
      ts: new Date().toISOString(),
      v: SCHEMA_VERSION,
      hook: entry.hook ?? null,           // dispatcher script
      rule: entry.rule ?? null,           // e.g. "h10-production-gate"
      cls: entry.cls ?? null,             // A | B | C
      event: entry.event ?? null,
      tool: entry.tool ?? null,
      decision: entry.decision ?? null,   // allow | deny | warn | error | noop
      hard: Boolean(entry.hard),
      level: entry.level ?? null,
      session: entry.session ?? null,
      agent: entry.agent ?? null,         // agent_type inside a subagent
      repo: short(entry.repoKey),         // hashed: repo paths can be sensitive
      file: entry.file ?? null,           // repo-relative, never absolute
      cmd: short(entry.command),          // hashed: never the command text
      duration_ms: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
      detail: entry.detail ?? null,       // short reason id, not prose
    };
    appendFileSync(join(logDir(), `decisions-${today()}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
  } catch {
    // Logging must never break a session, and never turn an allow into a deny.
  }
}

/** Delete ledger files older than `days`. Called from SessionStart. */
export function prune(days = 30) {
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  let removed = 0;
  try {
    const dir = logDir();
    if (!existsSync(dir)) return 0;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('decisions-')) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}

export const ledgerDir = logDir;
export const schemaVersion = SCHEMA_VERSION;
