/**
 * Status — what is armed, what state the session is in, and what the gates cost.
 *
 * The cost part is not decoration. Lesson 11 makes *wait time per gate* the
 * leading metric for an enforcement layer, precisely so that a gate's price is
 * visible to the people who own the policy. A gate nobody measures is a gate
 * that gets switched off the week it becomes annoying, and the course is blunt
 * that this is the usual way a control dies.
 *
 * The would-block ledger is the other half: at advisory level every predicate
 * still evaluates and records what it *would* have denied, so moving to
 * standard is an argument backed by data instead of a mandate.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { configuredCommands, describeRecord } from '../lib/verify.mjs';
import { repoKey as gitRepoKey, currentBranch } from '../lib/git.mjs';
import * as state from '../lib/state.mjs';

function ledgerDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA
    || join(process.env.TEMP || process.env.TMPDIR || '.', 'ai-native-sdlc-data');
  return join(base, 'logs');
}

function readLedger(days) {
  const dir = ledgerDir();
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - days * 86400000;
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('decisions-')) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (Date.parse(r.ts) >= cutoff) rows.push(r);
      } catch { /* a truncated last line is normal for an append-only log */ }
    }
  }
  return rows;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

export function status(repoRootArg, { days = 7, sessionId = null } = {}) {
  const cwd = repoRootArg || process.cwd();
  const { repoRoot, cfg, level, user, configured } = loadConfig(cwd);
  const repoKey = gitRepoKey(repoRoot);
  const s = sessionId ? state.read(sessionId, repoKey) : null;

  const rows = readLedger(days);
  const byRule = new Map();
  for (const r of rows) {
    if (!r.rule) continue;
    if (!byRule.has(r.rule)) byRule.set(r.rule, { rule: r.rule, cls: r.cls, deny: 0, warn: 0, other: 0, durations: [] });
    const e = byRule.get(r.rule);
    if (r.decision === 'deny' || r.decision === 'block') e.deny++;
    else if (r.decision === 'warn') e.warn++;
    else e.other++;
    if (typeof r.duration_ms === 'number') e.durations.push(r.duration_ms);
  }

  const gates = [...byRule.values()].map((g) => ({
    ...g,
    p50: percentile(g.durations, 50),
    p95: percentile(g.durations, 95),
  })).sort((a, b) => (b.deny + b.warn) - (a.deny + a.warn));

  // "Would have blocked" is only meaningful while running below standard.
  const wouldBlock = level === 'advisory'
    ? rows.filter((r) => r.decision === 'warn' && r.cls === 'B').length
    : 0;

  const errors = rows.filter((r) => r.decision === 'error' || r.detail?.startsWith('rule-error')).length;

  return {
    repoRoot, level, configured, days,
    branch: currentBranch(repoRoot),
    commands: configuredCommands(cfg),
    intentHome: cfg.intent_home,
    hardLocked: user.hardHooksLocked,
    session: s ? {
      fix: s.fix?.phase ?? 'off',
      changeDir: s.change_dir,
      lastVerified: describeRecord(s.last_verified),
      stopBlocks: s.stop_blocks ?? 0,
      maintenance: Boolean(s.maintenance),
    } : null,
    totals: { decisions: rows.length, gates: gates.length, errors, wouldBlock },
    gates,
  };
}

export function formatStatus(st) {
  const out = [`ai-native-sdlc status — ${st.repoRoot}`, ''];

  out.push(`  enforcement level   ${st.level}${st.hardLocked ? ' (always-hard gates locked)' : ' (WARNING: always-hard gates unlocked)'}`);
  out.push(`  configured          ${st.configured ? 'yes' : 'no — run /ai-native-sdlc:sdlc-init'}`);
  out.push(`  branch              ${st.branch ?? 'not a git repository'}`);
  out.push(`  artifact home       ${st.intentHome}/`);
  out.push(`  verify commands     ${st.commands.length ? st.commands.map((c) => `${c.kind}=\`${c.cmd}\``).join(', ') : 'none configured'}`);

  if (st.session) {
    out.push('', '  session');
    out.push(`    fix mode          ${st.session.fix}${st.session.fix === 'locked' ? ' (test files read-only)' : ''}`);
    out.push(`    active change     ${st.session.changeDir ?? 'none'}`);
    out.push(`    verification      ${st.session.lastVerified}`);
    if (st.session.maintenance) out.push('    maintenance       ON — config self-protection is lifted');
  }

  out.push('', `  decisions in the last ${st.days} day(s): ${st.totals.decisions} across ${st.totals.gates} gate(s)`);
  if (st.totals.errors) {
    out.push(`  ${st.totals.errors} gate evaluation error(s) — run /ai-native-sdlc:sdlc-doctor`);
  }

  if (st.gates.length) {
    out.push('', '  gate                            deny  warn   p50    p95');
    for (const g of st.gates.slice(0, 15)) {
      out.push(`  ${g.rule.padEnd(30)}  ${String(g.deny).padStart(4)}  ${String(g.warn).padStart(4)}  `
        + `${g.p50 === null ? '   -' : String(g.p50).padStart(4)}  ${g.p95 === null ? '   -' : String(g.p95).padStart(4)}`);
    }
    out.push('');
    out.push('  p50/p95 are milliseconds per evaluation — Lesson 11 makes wait time per gate the leading');
    out.push('  metric, because a gate whose cost is invisible is a gate that gets switched off.');
  } else {
    out.push('', '  No decisions recorded yet. Every allow is silent by design; only findings are logged.');
  }

  if (st.level === 'advisory') {
    out.push('', `  ${st.totals.wouldBlock} finding(s) would have blocked at standard level.`);
    out.push('  Use that number to make the case for escalating, rather than mandating it.');
  }

  return out.join('\n');
}
