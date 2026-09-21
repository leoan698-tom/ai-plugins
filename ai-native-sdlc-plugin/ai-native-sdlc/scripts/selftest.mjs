/**
 * Self-test — prove the gates are ARMED, not merely configured.
 *
 * Every other check in this plugin reports configuration: the policy file
 * parses, the commands are set, the paths look right. None of that answers the
 * question an auditor and an engineer both actually ask, which is *does it
 * fire*. A plugin can be installed, configured and completely inert — under
 * `allowManagedHooksOnly` without a force-enable, with `disableAllHooks` set,
 * or simply on a machine with no Node on PATH, where the interpreter exits 127
 * and the runtime treats that as a NON-blocking error and runs the tool anyway.
 *
 * So this replays synthetic hook payloads through the real dispatcher scripts
 * and asserts the exact decision. It turns "we installed it" into a test result.
 *
 * It is deliberately hermetic: it builds a throwaway repository, never touches
 * the user's own, and cleans up afterwards.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const CASES = [
  {
    name: 'credential in a diff is denied',
    policy: 'P28 — keep credentials out of the diff',
    hook: 'pre-file.mjs',
    payload: (r) => file(r, 'Write', { file_path: join(r, 'src', 'cfg.ts'), content: 'const k = "AKIAIOSFODNN7EXAMPLE";' }),
    expect: 'deny',
  },
  {
    name: 'secret must not appear in the block message',
    policy: 'P28 — a block that echoes the secret defeats itself',
    hook: 'pre-file.mjs',
    payload: (r) => file(r, 'Write', { file_path: join(r, 'src', 'cfg.ts'), content: 'const k = "AKIAIOSFODNN7EXAMPLE";' }),
    expect: 'deny',
    assert: (reason) => !reason.includes('AKIAIOSFODNN7EXAMPLE') || 'the block message contained the credential',
  },
  {
    name: 'push to the default branch is denied',
    policy: 'P55 — the agent has no path to main',
    hook: 'pre-bash.mjs',
    payload: (r) => shell(r, 'git push origin main'),
    expect: 'deny',
  },
  {
    name: 'self-merge of a pull request is denied',
    policy: 'P54 — the agent that wrote the code cannot approve it',
    hook: 'pre-bash.mjs',
    payload: (r) => shell(r, 'gh pr merge 1 --squash'),
    expect: 'deny',
  },
  {
    name: 'production deploy without authorization is denied',
    policy: 'P58 — the agent acts up to the production gate and cannot pass it',
    hook: 'pre-bash.mjs',
    payload: (r) => shell(r, 'helm upgrade api ./chart --namespace production'),
    expect: 'deny',
  },
  {
    name: 'test edit during a locked fix is denied',
    policy: 'P39 — an agent fixing code cannot weaken the check on that code',
    hook: 'pre-file.mjs',
    payload: (r) => file(r, 'Edit', { file_path: join(r, 'tests', 'a.test.ts'), old_string: 'a', new_string: 'b' }, 'locked'),
    expect: 'deny',
    needsLock: true,
  },
  {
    name: 'edit to the enforcement config is denied',
    policy: 'P18/P65 — the agent cannot loosen the gates that constrain it',
    hook: 'pre-file.mjs',
    payload: (r) => file(r, 'Write', { file_path: join(r, '.claude', 'sdlc', 'config.json'), content: '{}' }),
    expect: 'deny',
  },
  {
    name: 'write from a read-only agent is denied',
    policy: 'P34 — the verifier reports, it does not fix',
    hook: 'pre-file.mjs',
    payload: (r) => ({ ...file(r, 'Edit', { file_path: join(r, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }), agent_type: 'verifier' }),
    expect: 'deny',
  },
  {
    name: 'notebook cell is scanned too',
    policy: 'P28 — NotebookEdit uses notebook_path/new_source, not file_path/content',
    hook: 'pre-file.mjs',
    payload: (r) => file(r, 'NotebookEdit', { notebook_path: join(r, 'n.ipynb'), new_source: 'k = "ghp_abcdefghijabcdefghijabcdefghijabcdef"' }),
    expect: 'deny',
  },
  {
    name: 'an ordinary source edit is allowed',
    policy: 'the gates must not block ordinary work',
    hook: 'pre-file.mjs',
    payload: (r) => file(r, 'Edit', { file_path: join(r, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }),
    expect: 'allow',
  },
  {
    name: 'an ordinary command is allowed',
    policy: 'the gates must not block ordinary work',
    hook: 'pre-bash.mjs',
    payload: (r) => shell(r, 'git status'),
    expect: 'allow',
  },
];

function file(repo, tool, toolInput, session = 'selftest') {
  return {
    session_id: session, cwd: repo, hook_event_name: 'PreToolUse',
    tool_name: tool, tool_input: toolInput, tool_use_id: 'selftest',
  };
}
function shell(repo, command, session = 'selftest') {
  return {
    session_id: session, cwd: repo, hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: { command }, tool_use_id: 'selftest',
  };
}

/**
 * Build a throwaway repository whose policy mirrors the shape /sdlc-init
 * writes, so the cases exercise the same code paths a real repo would.
 */
function makeRepo(dataDir) {
  const repo = mkdtempSync(join(tmpdir(), 'sdlc-selftest-'));
  mkdirSync(join(repo, '.claude', 'sdlc'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'sdlc', 'config.json'), JSON.stringify({
    intent_home: 'intent',
    default_branch: 'main',
    protected_branches: ['main'],
    paths: { tests: ['tests/**'] },
  }), 'utf8');
  return repo;
}

/** Put the fake session into a locked fix so the test-lock case has something to hit. */
async function arrangeLock(repo, dataDir) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const state = await import('../lib/state.mjs');
  const { repoKey } = await import('../lib/git.mjs');
  state.write('locked', repoKey(repo), {
    ...state.EMPTY,
    fix: { phase: state.FIX_PHASE.LOCKED, locked: {}, entered_at: new Date().toISOString() },
  });
  if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
}

function runHook(hook, payload, dataDir) {
  const r = spawnSync(process.execPath, [join(ROOT, 'hooks', hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    timeout: 20000,
  });
  const out = (r.stdout ?? '').trim();
  if (r.error) return { outcome: 'error', reason: String(r.error.message) };
  if (out === '') return { outcome: 'allow', reason: '' };
  if (!out.startsWith('{')) {
    // Non-JSON on stdout means the runtime would have discarded the decision.
    return { outcome: 'error', reason: `stdout was not a JSON object: ${out.slice(0, 120)}` };
  }
  const json = JSON.parse(out);
  const d = json.hookSpecificOutput?.permissionDecision;
  if (d === 'deny') return { outcome: 'deny', reason: json.hookSpecificOutput.permissionDecisionReason ?? '' };
  if (json.systemMessage) return { outcome: 'warn', reason: json.systemMessage };
  return { outcome: 'allow', reason: '' };
}

export async function selftest() {
  const dataDir = mkdtempSync(join(tmpdir(), 'sdlc-selftest-data-'));
  const repo = makeRepo(dataDir);
  await arrangeLock(repo, dataDir);

  const results = [];
  for (const c of CASES) {
    const payload = c.payload(repo);
    if (c.needsLock) payload.session_id = 'locked';
    const { outcome, reason } = runHook(c.hook, payload, dataDir);

    let ok = outcome === c.expect;
    let note = '';
    if (ok && c.assert) {
      const verdict = c.assert(reason);
      if (verdict !== true) { ok = false; note = String(verdict); }
    }
    // A deny is only useful if it explains itself and names the route out.
    if (ok && c.expect === 'deny') {
      if (!/^Route: /m.test(reason)) { ok = false; note = 'the block message has no Route line'; }
      if (!/^Policy: /m.test(reason)) { ok = false; note = 'the block message has no Policy line'; }
    }
    results.push({ name: c.name, policy: c.policy, expected: c.expect, actual: outcome, ok, note });
  }

  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }

  return results;
}

export function formatResults(results) {
  const lines = [];
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    lines.push(`  ${mark}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.actual}${r.note ? ` — ${r.note}` : ''}`);
    if (!r.ok) lines.push(`        ${r.policy}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(failed === 0
    ? `  ${results.length}/${results.length} gates fired as expected. The enforcement layer is live.`
    : `  ${failed} of ${results.length} gates did NOT behave as expected. The enforcement layer is NOT fully live.`);
  if (failed > 0) {
    lines.push('');
    lines.push('  Most likely causes, in order:');
    lines.push('    - Node is not on PATH for hook processes (a missing interpreter exits 127,');
    lines.push('      which the runtime treats as non-blocking, so every gate fails open)');
    lines.push('    - the plugin is not enabled in this session (check /plugin)');
    lines.push('    - hooks are disabled (disableAllHooks, or --settings on the command line)');
    lines.push('    - managed settings set allowManagedHooksOnly without force-enabling this plugin');
    lines.push('      in enabledPlugins, which silently blocks every plugin hook');
  }
  return lines.join('\n');
}

// Runnable directly for CI and for /sdlc-doctor --selftest.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('selftest.mjs')) {
  const results = await selftest();
  const json = process.argv.includes('--json');
  if (json) {
    process.stdout.write(JSON.stringify({ tool: 'sdlc-selftest', results }, null, 2) + '\n');
  } else {
    process.stdout.write('ai-native-sdlc self-test — replaying synthetic hook payloads through the real gates\n\n');
    process.stdout.write(formatResults(results) + '\n');
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
