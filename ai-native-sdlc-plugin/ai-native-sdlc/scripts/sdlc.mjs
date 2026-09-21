#!/usr/bin/env node
/**
 * sdlc — the CLI the skills call.
 *
 * Skills invoke this rather than reimplementing logic in prose, so a policy
 * question has exactly one answer whether it is asked by a hook, by a skill or
 * by CI. Each skill declares `allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/run.mjs *)`
 * and the shim forwards here — `${CLAUDE_SKILL_DIR}` substitution inside
 * allowed-tools is documented, whereas `${CLAUDE_PLUGIN_ROOT}` there is not.
 *
 *   sdlc.mjs status   [--days N] [--session ID] [--json]
 *   sdlc.mjs doctor   [--json] [--selftest]
 *   sdlc.mjs selftest [--json]
 *   sdlc.mjs state    get|set|clear [--session ID] [--key K] [--value V]
 *   sdlc.mjs config   [--json]
 */

import { status, formatStatus } from './status.mjs';
import { doctor, formatDoctor } from './doctor.mjs';
import { selftest, formatResults } from './selftest.mjs';
import { loadConfig } from '../lib/config.mjs';
import { repoKey as gitRepoKey } from '../lib/git.mjs';
import * as state from '../lib/state.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
}
const has = (name) => argv.includes(`--${name}`);
const json = has('json');
const repo = flag('repo') || process.cwd();

const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

switch (cmd) {
  case 'status': {
    const st = status(repo, { days: Number(flag('days', 7)) || 7, sessionId: flag('session') });
    out(json ? JSON.stringify(st, null, 2) : formatStatus(st));
    break;
  }

  case 'doctor': {
    const d = doctor(repo);
    if (has('selftest')) {
      const results = await selftest();
      d.selftest = results;
      if (!json) {
        out(formatDoctor(d));
        out('\n  gate self-test — replaying synthetic payloads through the real hooks\n');
        out(formatResults(results));
        process.exit(results.every((r) => r.ok) && !d.checks.some((c) => c.status === 'fail') ? 0 : 1);
      }
    }
    out(json ? JSON.stringify(d, null, 2) : formatDoctor(d));
    process.exit(d.checks.some((c) => c.status === 'fail') ? 1 : 0);
    break;
  }

  case 'selftest': {
    const results = await selftest();
    out(json ? JSON.stringify({ tool: 'sdlc-selftest', results }, null, 2)
      : 'ai-native-sdlc self-test\n\n' + formatResults(results));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
    break;
  }

  case 'state': {
    const sub = argv[1];
    const { repoRoot } = loadConfig(repo);
    const key = gitRepoKey(repoRoot);
    const session = flag('session');
    if (!session) { process.stderr.write('sdlc state: --session is required\n'); process.exit(2); }

    if (sub === 'get') {
      const s = state.read(session, key);
      const { _file, ...clean } = s;
      out(JSON.stringify(clean, null, 2));
    } else if (sub === 'set') {
      const k = flag('key');
      let v = flag('value');
      if (!k) { process.stderr.write('sdlc state set: --key is required\n'); process.exit(2); }
      try { v = JSON.parse(v); } catch { /* keep the raw string */ }
      const next = state.update(session, key, (s) => {
        // Dotted keys so a skill can set fix.phase without rewriting the object.
        const parts = String(k).split('.');
        let cur = s;
        for (let i = 0; i < parts.length - 1; i++) {
          if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = v;
        return s;
      });
      const { _file, ...clean } = next;
      out(JSON.stringify(clean, null, 2));
    } else if (sub === 'clear') {
      const next = state.update(session, key, () => ({ ...state.EMPTY }));
      const { _file, ...clean } = next;
      out(JSON.stringify(clean, null, 2));
    } else {
      process.stderr.write('sdlc state: expected get | set | clear\n');
      process.exit(2);
    }
    break;
  }

  case 'scaffold': {
    // The skill gathers answers interactively, then hands them here so the
    // files are written deterministically and the manifest is maintained.
    // Writing them from the skill directly would skip the manifest, and the
    // upgrade path depends on it entirely.
    const { detectStacks, detectProtectedPaths, PROFILES, plan, apply, template,
      innerLoopRules, mergeProjectSettings } = await import('./scaffold.mjs');
    const { readFileSync } = await import('node:fs');

    if (has('detect')) {
      out(JSON.stringify({
        stacks: detectStacks(repo),
        profiles: Object.fromEntries(detectStacks(repo).map((s) => [s, PROFILES[s]])),
        protected: detectProtectedPaths(repo),
      }, null, 2));
      break;
    }

    const answersPath = flag('answers');
    if (!answersPath) { process.stderr.write('sdlc scaffold: --answers <file.json> is required (or --detect)\n'); process.exit(2); }

    // A raw JSON.parse stack trace is a useless thing to hand someone who has a
    // typo in a config file. Say which file, which position, and what to do.
    let a;
    try {
      a = JSON.parse(readFileSync(answersPath, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      process.stderr.write(
        `sdlc scaffold: ${answersPath} is not valid JSON — ${err.message}\n`
        + 'A backslash inside a JSON string must be doubled: write "\\\\d+ passing", not "\\d+ passing".\n');
      process.exit(2);
    }

    const tokens = {
      PROJECT_NAME: a.project_name ?? 'this repository',
      BUILD_CMD: a.commands?.build?.cmd ?? '',
      TEST_CMD: a.commands?.test?.cmd ?? '',
      LINT_CMD: a.commands?.lint?.cmd ?? '',
      TEST_HEALTHY_EXAMPLE: a.test_healthy_example ?? '(capture one from a real passing run)',
      CLAUDE_MD_MAX_LINES: a.claude_md?.max_lines ?? 120,
      INTENT_HOME: a.intent_home ?? 'intent',
      GENERATED_PATHS: (a.paths?.generated ?? []).join(', ') || '(none configured)',
      CHANGE_NAME: '<change-name>',
      AUTHOR: a.author ?? '<name> (<role>)',
    };
    const home = tokens.INTENT_HOME;

    const files = [
      { path: '.claude/sdlc/config.json', content: JSON.stringify(a, null, 2) + '\n' },
      { path: 'REVIEW.md', content: template('REVIEW.md.tmpl', tokens) },
      { path: `${home}/_templates/intent.md`, content: template('intent.md.tmpl', tokens) },
      { path: `${home}/_templates/spec.md`, content: template('spec.md.tmpl', tokens) },
      { path: `${home}/_templates/plan.md`, content: template('plan.md.tmpl', tokens) },
    ];
    if (!has('no-claude-md')) files.push({ path: 'CLAUDE.md', content: template('CLAUDE.md.tmpl', tokens) });

    const settings = mergeProjectSettings(repo, innerLoopRules(a));
    files.push({ path: settings.path, content: settings.content });

    const planned = plan(repo, files, a.plugin_version ?? null);

    if (has('apply')) {
      const written = apply(repo, planned);
      out(JSON.stringify({ applied: written, manifest: '.claude/.sdlc-scaffold.json' }, null, 2));
    } else {
      out(JSON.stringify({
        plan: planned.actions.map(({ path, status, proposedPath }) => ({ path, status, proposedPath })),
        note: 'nothing written; pass --apply to write. "modified" files are offered as <name>.sdlc-proposed.',
      }, null, 2));
    }
    break;
  }

  case 'config': {
    const c = loadConfig(repo);
    out(JSON.stringify({
      repoRoot: c.repoRoot, configured: c.configured, level: c.level,
      errors: c.errors, config: c.cfg,
    }, null, 2));
    break;
  }

  default:
    process.stdout.write(`sdlc — ai-native-sdlc helper CLI

  status   [--days N] [--session ID] [--json]   what is armed, session state, gate cost
  doctor   [--json] [--selftest]                repository readiness; --selftest proves the gates fire
  selftest [--json]                             replay synthetic payloads through the real hooks
  state    get|set|clear --session ID           inspect or change session state
  config   [--json]                             the effective merged configuration

Exit codes: doctor and selftest exit 1 on a blocking finding.
`);
    process.exit(cmd ? 2 : 0);
}
