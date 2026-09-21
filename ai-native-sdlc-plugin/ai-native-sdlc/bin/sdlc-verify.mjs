#!/usr/bin/env node
/**
 * sdlc-verify — re-run every deterministic policy check against a diff range.
 *
 * WHY THIS IS THE PRIMARY CONTROL, not a nicety.
 *
 * The local hooks make the gates unbypassable *by the agent*: a PreToolUse deny
 * fires before any permission check and beats even --dangerously-skip-permissions.
 * They do not make them unbypassable *by a person*. Without organization-deployed
 * managed settings, `/plugin disable`, `disableAllHooks: true` and
 * `--settings '{"disableAllHooks":true}'` are all available, and a missing Node
 * interpreter exits 127, which the runtime treats as a NON-blocking error — so
 * every gate fails open, silently, on a machine that never installed Node.
 *
 * This command closes that hole. It trusts no session state, no plugin
 * installation and no local configuration beyond the repository's own committed
 * policy file. It reads a diff and exits non-zero. Wire it as a required status
 * check and the policy set holds on machines where the hooks never ran.
 *
 * Usage:
 *   node bin/sdlc-verify.mjs --base origin/main --head HEAD
 *   node bin/sdlc-verify.mjs --base origin/main --json
 *   node bin/sdlc-verify.mjs --staged          # pre-commit use
 *
 * Exit codes: 0 clean · 1 violations found · 2 could not run
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { matchesAny, firstMatch, globMatch } from '../lib/paths.mjs';
import { scan, describe as describeFindings } from '../lib/secrets.mjs';
import { validate, filesThatChange, artifactKind } from '../lib/artifacts.mjs';

const args = parseArgs(process.argv.slice(2));
const repoRoot = args.repo || process.cwd();

function parseArgs(argv) {
  const out = { base: '', head: 'HEAD', json: false, staged: false, repo: '', level: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--head') out.head = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--level') out.level = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--staged') out.staged = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function git(gitArgs) {
  const r = spawnSync('git', gitArgs, {
    cwd: repoRoot, shell: false, windowsHide: true, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

if (args.help) {
  process.stdout.write(`sdlc-verify — re-run the deterministic SDLC policy checks over a diff.

  --base <ref>    compare against this ref (e.g. origin/main)
  --head <ref>    compare up to this ref (default HEAD)
  --staged        check the staged changes instead of a range
  --level <name>  advisory | standard | strict (default: repo config)
  --json          machine-readable output
  --repo <path>   repository root (default: cwd)

Exits 1 when a violation is found, 2 when it could not run.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

const findings = [];
const add = (severity, policy, id, lesson, file, detail, route) =>
  findings.push({ severity, policy, id, lesson, file, detail, route });

function main() {
  if (!git(['rev-parse', '--is-inside-work-tree']).ok) {
    fail(`${repoRoot} is not a git repository`);
  }

  const { cfg, level: cfgLevel, configured } = loadConfig(repoRoot, {});
  const level = args.level || cfgLevel;

  if (!configured) {
    // Not an error: a repository may legitimately not use the playbook yet.
    // But say so, because "no findings" would otherwise look like "compliant".
    report([], level, { skipped: true });
    process.exit(0);
  }

  const changed = changedFiles();
  if (changed.length === 0) {
    report([], level, { empty: true });
    process.exit(0);
  }

  for (const file of changed) {
    checkProtectedPath(file, cfg);
    checkSecrets(file, cfg);
    checkTestWeakening(file, cfg);
    checkClaudeMdSize(file, cfg);
    checkArtifactStructure(file, cfg, level);
  }

  checkPlanSync(changed, cfg, level);
  checkArtifactAuthorship(changed, cfg);

  report(findings, level, {});
  const blocking = findings.filter((f) => f.severity === 'error');
  process.exit(blocking.length ? 1 : 0);
}

/** The set of files this invocation is responsible for. */
function changedFiles() {
  if (args.staged) {
    const r = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    return lines(r.out);
  }
  if (args.base) {
    // Three-dot: what HEAD added relative to the merge base, which is what a PR
    // is actually proposing — two-dot would also flag whatever landed on the
    // base branch since the fork.
    const r = git(['diff', '--name-only', '--diff-filter=ACMR', `${args.base}...${args.head}`]);
    if (!r.ok) fail(`could not diff ${args.base}...${args.head}: ${r.err.trim()}`);
    return lines(r.out);
  }
  const r = git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
  return lines(r.out);
}

const lines = (s) => s.split('\n').map((x) => x.trim().replace(/\\/g, '/')).filter(Boolean);

/** Content of a file as it stands at --head (or the working tree). */
function contentAt(file) {
  if (args.staged) {
    const r = git(['show', `:${file}`]);
    return r.ok ? r.out : null;
  }
  if (args.base) {
    const r = git(['show', `${args.head}:${file}`]);
    return r.ok ? r.out : null;
  }
  const abs = join(repoRoot, file);
  try { return existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch { return null; }
}

/** Lines this change ADDED, so a pre-existing secret is not re-reported forever. */
function addedLines(file) {
  const range = args.staged ? ['diff', '--cached', '-U0', '--', file]
    : args.base ? ['diff', '-U0', `${args.base}...${args.head}`, '--', file]
      : ['diff', '-U0', 'HEAD', '--', file];
  const r = git(range);
  if (!r.ok) return null;
  return r.out.split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
}

// --- checks ----------------------------------------------------------------

function checkProtectedPath(file, cfg) {
  const p = cfg.paths ?? {};
  const generated = firstMatch(p.generated, file);
  if (generated) {
    return add('error', 'generated files are produced, not edited', 'P20', 5, file,
      `matches paths.generated '${generated}'`,
      'change the source that generates this file and re-run the generator');
  }
  for (const entry of p.frozen ?? []) {
    const glob = typeof entry === 'string' ? entry : entry?.glob;
    if (glob && globMatch(glob, file)) {
      const successor = typeof entry === 'object' ? entry.successor : null;
      return add('error', 'frozen packages are read-only; changes go to the successor', 'P20', 5, file,
        `matches paths.frozen '${glob}'`,
        successor ? `implement this in ${successor}` : 'implement this in the successor package');
    }
  }
  const lock = firstMatch([...(p.lockfiles ?? []), ...(p.manifests ?? [])], file);
  if (lock) {
    add('error', 'do not bump dependency versions; the platform team owns them', 'P19', 5, file,
      `matches '${lock}'`,
      cfg.owners?.dependencies ? `route this through ${cfg.owners.dependencies}` : 'route this through the dependency process');
  }
  const infra = firstMatch([...(p.migrations ?? []), ...(p.infra ?? [])], file);
  if (infra) {
    add('warning', 'no edits to migrations or infrastructure without a change ticket', 'P59', 11, file,
      `matches '${infra}'`,
      'confirm a change ticket covers this before merging');
  }
}

function checkSecrets(file, cfg) {
  if (matchesAny(cfg.paths?.secret_scan_allow, file)) return;
  const added = addedLines(file);
  if (added === null) return;
  const f = scan(added);
  if (f.length) {
    add('error', 'keep credentials out of the diff', 'P28', 6, file,
      `${describeFindings(f)} (value not shown)`,
      'replace with an environment variable or a secret-manager lookup, and rotate the exposed credential');
  }
}

const SKIP_MARKERS = [
  /\.skip\s*\(/, /\bxit\s*\(/, /\bxdescribe\s*\(/, /\.only\s*\(/,
  /@Disabled\b/, /@Ignore\b/, /\bpytest\.mark\.(skip|xfail)\b/,
  /@unittest\.skip/, /\bt\.Skip\s*\(/, /#\[ignore\]/, /\[Ignore\]/,
];

function checkTestWeakening(file, cfg) {
  if (!matchesAny(cfg.paths?.tests, file)) return;
  if (cfg.allow_test_skips) return;
  const added = addedLines(file);
  if (!added) return;
  const marker = SKIP_MARKERS.find((re) => re.test(added));
  if (marker) {
    add('error', 'if a test fails, fix the code, not the test', 'P41', 8, file,
      `this change adds a skip/ignore marker (${String(marker)})`,
      'fix the code under test, or remove the obsolete test in a separate reviewed PR');
  }
}

function checkClaudeMdSize(file, cfg) {
  if (file.split('/').pop() !== 'CLAUDE.md') return;
  const text = contentAt(file);
  if (text === null) return;
  const maxLines = cfg.claude_md?.max_lines ?? 120;
  const maxBytes = cfg.claude_md?.max_bytes ?? 8000;
  const n = text.split('\n').length;
  if (n > maxLines || Buffer.byteLength(text) > maxBytes) {
    add('warning', 'CLAUDE.md is read in full at every session start; stale content is a liability', 'P16', 5, file,
      `${n} lines / ${Buffer.byteLength(text)} bytes (limits ${maxLines} / ${maxBytes})`,
      'prune stale entries or move detail into a linked document');
  }
}

function checkArtifactStructure(file, cfg, level) {
  const kind = artifactKind(file);
  if (!kind) return;
  if (/(^|\/)(_templates|templates|examples)\//.test(file)) return;
  const text = contentAt(file);
  if (text === null) return;

  const res = validate(kind, text, { level, aliasOverrides: cfg.artifacts?.aliases });
  if (!res.ok) {
    add('error', res.schema.policy, res.schema.id, res.schema.lesson, file,
      `missing ${res.missing.join(', ')}`,
      `add the missing sections (English or Chinese headings are both accepted)`);
  }

  // A spec without the intent it came from loses the pair that records what was
  // asked for and what was decided.
  if (kind === 'spec.md') {
    const dir = file.slice(0, file.lastIndexOf('/'));
    if (dir && !existsSync(join(repoRoot, dir, 'intent.md'))) {
      add(level === 'strict' ? 'error' : 'warning',
        'spec.md is committed together with intent.md; the pair records what was asked and what was decided',
        'P09', 3, file, `no intent.md beside it in ${dir}/`,
        'write the intent first, or move the spec next to its intent');
    }
  }
}

/**
 * Plan / implementation synchronisation — the hook the course names explicitly.
 * If source files outside the plan's declared set changed, the plan is stale.
 */
function checkPlanSync(changed, cfg, level) {
  const home = (cfg.intent_home ?? 'intent').replace(/^\/+|\/+$/g, '');
  const plans = changed.filter((f) => f.startsWith(`${home}/`) && f.endsWith('/plan.md'));

  // Find the plan governing this change: one touched here, else the only plan
  // whose declared file set overlaps what changed.
  let planFile = plans[0] ?? null;
  const sourceChanges = changed.filter((f) =>
    !f.startsWith(`${home}/`)
    && !matchesAny(cfg.paths?.verify_exempt, f)
    && !matchesAny(cfg.paths?.plan_sync_ignore, f));

  if (!planFile) {
    const all = lines(git(['ls-files', `${home}/*/plan.md`]).out);
    let best = null; let bestOverlap = 0;
    for (const p of all) {
      const text = contentAt(p) ?? readSafe(join(repoRoot, p));
      if (!text) continue;
      const declared = filesThatChange(text, cfg.artifacts?.aliases);
      const overlap = sourceChanges.filter((c) => declared.some((d) => c === d || c.startsWith(d.replace(/\/$/, '') + '/'))).length;
      if (overlap > bestOverlap) { best = p; bestOverlap = overlap; }
    }
    planFile = best;
  }

  if (!planFile) {
    if (sourceChanges.length > 0) {
      add(level === 'strict' ? 'error' : 'warning',
        'work starts from a written plan that later stages can check the diff against', 'P11', 4,
        sourceChanges[0], `${sourceChanges.length} source file(s) changed and no plan.md governs them`,
        `run /ai-native-sdlc:plan and commit ${home}/<change>/plan.md`);
    }
    return;
  }

  const text = contentAt(planFile) ?? readSafe(join(repoRoot, planFile));
  if (!text) return;
  const declared = filesThatChange(text, cfg.artifacts?.aliases);
  const undeclared = sourceChanges.filter((c) => !declared.some((d) => c === d || c.startsWith(d.replace(/\/$/, '') + '/')));

  // The question a range check asks is whether the plan AS IT STANDS AT HEAD
  // accounts for everything this change touches — not whether plan.md happened
  // to be edited somewhere in the range. A plan written in this very PR that
  // still omits half the files it changed is exactly the drift being looked for.
  // (The commit-scoped variant of this rule lives in the local hook, where
  // "updated in the same commit" is the right question to ask.)
  if (undeclared.length) {
    add('error', 'when the implementation departs from the plan, plan.md is updated with it', 'P15', 4,
      planFile,
      `changed but not listed under "Files that change": ${undeclared.slice(0, 8).join(', ')}${undeclared.length > 8 ? ` (+${undeclared.length - 8})` : ''}`,
      'add these paths to plan.md, or add a glob to paths.plan_sync_ignore if they are incidental');
  }
}

/**
 * P05's machine-checkable half: intent.md claims an author, and git records who
 * committed it. Nothing else distinguishes a human-authored intent from an
 * agent-generated one at read time.
 */
function checkArtifactAuthorship(changed, cfg) {
  const home = (cfg.intent_home ?? 'intent').replace(/^\/+|\/+$/g, '');
  for (const file of changed.filter((f) => f.startsWith(`${home}/`) && f.endsWith('/intent.md'))) {
    const text = contentAt(file);
    if (text === null) continue;
    const m = /^\s*(?:\*\*)?Author(?:\*\*)?\s*[:：]\s*(.+?)\s*$/mi.exec(text);
    if (!m) {
      add('warning', 'intent.md records its author, so the artifact carries who asked for the change', 'P05', 2,
        file, 'no Author line found',
        'add "Author: <name> (<role>)" near the top');
    }
  }
}

function readSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }

// --- output ----------------------------------------------------------------

function report(list, level, flags) {
  if (args.json) {
    process.stdout.write(JSON.stringify({
      tool: 'sdlc-verify', level,
      base: args.base || null, head: args.head, staged: args.staged,
      configured: !flags.skipped,
      errors: list.filter((f) => f.severity === 'error').length,
      warnings: list.filter((f) => f.severity === 'warning').length,
      findings: list,
    }, null, 2) + '\n');
    return;
  }

  if (flags.skipped) {
    process.stdout.write('sdlc-verify: this repository has no SDLC policy file, so no checks ran.\n'
      + 'Run /ai-native-sdlc:sdlc-init to configure it.\n');
    return;
  }
  if (flags.empty) {
    process.stdout.write('sdlc-verify: no changed files in range.\n');
    return;
  }

  const errors = list.filter((f) => f.severity === 'error');
  const warnings = list.filter((f) => f.severity === 'warning');

  if (!list.length) {
    process.stdout.write(`sdlc-verify: clean (level ${level}).\n`);
    return;
  }

  for (const group of [['ERROR', errors], ['WARNING', warnings]]) {
    const [label, items] = group;
    for (const f of items) {
      process.stdout.write(
        `${label} ${f.file}\n`
        + `  Policy: ${f.policy} (Playbook ${f.id}, Lesson ${f.lesson})\n`
        + `  Why:    ${f.detail}\n`
        + `  Route:  ${f.route}\n\n`,
      );
    }
  }
  process.stdout.write(`sdlc-verify: ${errors.length} error(s), ${warnings.length} warning(s) at level ${level}.\n`);
  if (errors.length) {
    process.stdout.write(
      'These checks re-run the same policies the local hooks enforce, without trusting local state, '
      + 'so they hold even where the plugin was never installed.\n',
    );
  }
}

function fail(msg) {
  process.stderr.write(`sdlc-verify: ${msg}\n`);
  process.exit(2);
}

main();
