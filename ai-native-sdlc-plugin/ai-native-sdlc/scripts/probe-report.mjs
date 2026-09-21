/**
 * Phase 0 probe reporter — turns probe.jsonl into findings against the six
 * assumptions the plan flagged as undocumented.
 *
 * Usage: node scripts/probe-report.mjs [path/to/probe.jsonl]
 * Default path: ${CLAUDE_PLUGIN_DATA}/probe/probe.jsonl
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const explicit = process.argv[2];
const base = process.env.CLAUDE_PLUGIN_DATA
  || join(process.env.TEMP || process.env.TMPDIR || '.', 'ai-native-sdlc-probe');
const file = explicit || join(base, 'probe', 'probe.jsonl');

if (!existsSync(file)) {
  console.error(`No probe log at ${file}`);
  console.error('Run a session with --plugin-dir pointing at this plugin first.');
  process.exit(1);
}

const records = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, i) => {
    try { return JSON.parse(line); } catch { return { _unparseable: true, _line: i + 1 }; }
  });

console.log(`# Phase 0 probe report\n`);
console.log(`Source: ${file}`);
console.log(`Records: ${records.length}\n`);

const byLabel = new Map();
for (const r of records) {
  if (r._unparseable) continue;
  const key = `${r.label} / ${r.event ?? '?'} / ${r.tool ?? '-'}`;
  if (!byLabel.has(key)) byLabel.set(key, []);
  byLabel.get(key).push(r);
}

console.log('## Observed invocations\n');
for (const [key, rs] of [...byLabel.entries()].sort()) {
  const r = rs[0];
  console.log(`- **${key}** ×${rs.length}`);
  if (r.tool_input_keys) console.log(`    tool_input keys: ${r.tool_input_keys.join(', ')}`);
  if (r.tool_response_keys) {
    const v = Array.isArray(r.tool_response_keys) ? r.tool_response_keys.join(', ') : r.tool_response_keys;
    console.log(`    tool_response: ${v}`);
  }
  const top = Object.keys(r.stdin ?? {}).filter((k) => k !== 'tool_input' && k !== 'tool_response');
  console.log(`    stdin top-level: ${top.join(', ')}`);
}

console.log('\n## Assumption findings\n');

const sawTool = (name) => records.some((r) => r.tool === name);
const sawLabel = (name) => records.some((r) => r.label === name);

// A — does PreToolUse fire for ExitPlanMode?
const a = sawLabel('pre-exitplanmode');
console.log(`**A. PreToolUse fires for ExitPlanMode** → ${a ? 'CONFIRMED' : 'NOT OBSERVED'}`);
if (a) {
  const r = records.find((r) => r.label === 'pre-exitplanmode');
  console.log(`   tool_input keys: ${(r.tool_input_keys ?? []).join(', ')}`);
} else {
  console.log('   Either the event does not fire, or no plan was accepted during the probe run.');
  console.log('   Re-run with a session that actually exits plan mode before concluding.');
}

// B — are sensitive userConfig values exported to hook processes?
const withOpts = records.find((r) => r.plugin_options && Object.keys(r.plugin_options).length);
console.log(`\n**B. sensitive userConfig exported to hooks** →`);
if (!withOpts) {
  console.log('   NO CLAUDE_PLUGIN_OPTION_* variables seen at all.');
  console.log('   userConfig values are only set once the plugin is enabled and configured;');
  console.log('   --plugin-dir alone may not populate them. Inconclusive.');
} else {
  const keys = Object.keys(withOpts.plugin_options).sort();
  console.log(`   Exported keys: ${keys.join(', ')}`);
  const sensitive = keys.find((k) => k.endsWith('PROBE_SENSITIVE_VALUE'));
  console.log(`   sensitive key present: ${sensitive ? 'YES → HMAC approach is viable' : 'NO → keep env-var approvals, HMAC stays interface-only'}`);
}

// C — MultiEdit / NotebookEdit tool_input shapes
console.log(`\n**C. MultiEdit / NotebookEdit tool_input shape** →`);
for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
  const r = records.find((r) => r.tool === t && r.label === 'pre-file');
  console.log(`   ${t.padEnd(13)} ${r ? r.tool_input_keys.join(', ') : 'not observed'}`);
}

// E — Bash / PowerShell tool_response shape
console.log(`\n**E. Bash / PowerShell tool_response shape** →`);
for (const t of ['Bash', 'PowerShell']) {
  const r = records.find((r) => r.tool === t && r.label === 'post-bash');
  const v = r ? (Array.isArray(r.tool_response_keys) ? r.tool_response_keys.join(', ') : String(r.tool_response_keys)) : 'not observed';
  console.log(`   ${t.padEnd(13)} ${v}`);
  if (r && Array.isArray(r.tool_response_keys)) {
    const hasExit = r.tool_response_keys.some((k) => /exit|code|status/i.test(k));
    console.log(`   ${''.padEnd(13)} exit-code-like field: ${hasExit ? 'YES' : 'NO → verification evidence must re-run or match output'}`);
  }
}

// Placeholders and platform
const any = records.find((r) => r.env_paths);
if (any) {
  console.log(`\n**Placeholder substitution / environment** →`);
  for (const [k, v] of Object.entries(any.env_paths)) {
    console.log(`   ${k.padEnd(20)} ${v ?? '(not set)'}`);
  }
  console.log(`   platform             ${any.platform}`);
  console.log(`   node                 ${any.node}`);
  const bs = Object.values(any.env_paths).some((v) => typeof v === 'string' && v.includes('\\'));
  console.log(`   backslashes in paths: ${bs ? 'YES → normalise before matching' : 'no'}`);
}

// Subagent coverage
console.log(`\n**Subagent hooks** → SubagentStart ${sawLabel('subagent-start') ? 'observed' : 'not observed'}, SubagentStop ${sawLabel('subagent-stop') ? 'observed' : 'not observed'}`);
console.log(`**Read prefilter** → ${sawTool('Read') ? 'Read events observed' : 'no Read events'}`);
