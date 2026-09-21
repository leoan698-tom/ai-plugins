/**
 * Doctor — is this repository actually protected, and is the loop closed?
 *
 * Deliberately non-mutating: it reports and names the fix, it never applies one.
 *
 * The check that matters most here is the one no design in the review had:
 * **whether server-side branch protection actually exists**. The local push gate
 * is defence in depth — it stops the agent, not a person with any other git
 * client. A team that installs this plugin, sees `git push origin main` blocked
 * and concludes separation of duties is enforced has a false belief that is
 * worse than no belief. So this asks the forge.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { configuredCommands } from '../lib/verify.mjs';
import { isRepo, defaultBranch, remotes } from '../lib/git.mjs';
import { validate } from '../lib/artifacts.mjs';

export const LEVELS = { ok: 'ok', warn: 'warn', fail: 'fail', info: 'info' };

export function doctor(repoRootArg) {
  const cwd = repoRootArg || process.cwd();
  const { repoRoot, cfg, level, user, configured, errors } = loadConfig(cwd);
  const checks = [];
  const add = (status, name, detail, fix) => checks.push({ status, name, detail, fix });

  // --- runtime ------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 18 ? LEVELS.ok : LEVELS.fail, 'Node runtime', `v${process.versions.node}`,
    'install Node 18 or newer; every gate runs on it, and a missing interpreter makes them all fail open');

  const git = which('git');
  add(git ? LEVELS.ok : LEVELS.fail, 'git available', git ?? 'not found',
    'install git; the plan-sync, turn-scan and branch gates all read it');

  add(isRepo(repoRoot) ? LEVELS.ok : LEVELS.warn, 'git repository', repoRoot,
    'initialise a repository; without one the git-backed gates are inert');

  // --- configuration ------------------------------------------------------
  // Order matters: a malformed file also reads as "not configured", and
  // reporting it as MISSING sends someone to re-run the scaffold when the real
  // problem is a typo they could fix in ten seconds.
  if (errors.length) {
    add(LEVELS.fail, 'repository policy file', `${user.configPath} — ${errors.join('; ')}`,
      'fix the syntax error; built-in defaults are being used meanwhile, so the repo-specific gates are inert');
  } else if (!configured) {
    add(LEVELS.fail, 'repository policy file', `missing ${user.configPath}`,
      'run /ai-native-sdlc:sdlc-init — until then the repo-specific gates have nothing to match against');
  } else {
    add(LEVELS.ok, 'repository policy file', user.configPath, '');
  }

  add(level === 'advisory' ? LEVELS.warn : LEVELS.ok, 'enforcement level', level,
    level === 'advisory'
      ? 'advisory means the level-dependent gates only warn. The always-hard set still blocks. '
        + 'Move to standard once the noise is tuned — /ai-native-sdlc:sdlc-status shows what would have blocked'
      : '');

  add(user.hardHooksLocked ? LEVELS.ok : LEVELS.warn, 'always-hard gates locked', String(user.hardHooksLocked),
    'hard_hooks_locked=false lets repository config weaken the safety-critical set; turn it back on');

  // --- the feedback loop --------------------------------------------------
  const cmds = configuredCommands(cfg);
  if (cmds.length === 0) {
    add(LEVELS.fail, 'verify command', 'none configured',
      'without a one-command way to check the work, nothing can prove a change works and the Stop gate is inert (Lesson 8)');
  } else {
    add(LEVELS.ok, 'verify commands', cmds.map((c) => `${c.kind}=${c.cmd}`).join(', '), '');
    const noPattern = cmds.filter((c) => !c.healthy_regex);
    if (noPattern.length) {
      add(LEVELS.warn, 'healthy-output pattern',
        `missing for ${noPattern.map((c) => c.kind).join(', ')}`,
        'Lesson 8 step 2 asks for an example of healthy output — it is what distinguishes "passed" '
        + 'from "passed but skipped 40 cases". Without it the Stop gate must re-run the command every time');
    }
  }

  // --- artifacts ----------------------------------------------------------
  const home = join(repoRoot, cfg.intent_home ?? 'intent');
  add(existsSync(home) ? LEVELS.ok : LEVELS.warn, 'intent home', cfg.intent_home ?? 'intent',
    'create it so artifacts have a shared, version-controlled place to live (Lesson 2)');

  const claudeMd = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    add(LEVELS.warn, 'CLAUDE.md', 'missing', 'the cheapest win in the playbook — run /init, then cut it to one page');
  } else {
    const text = readFileSync(claudeMd, 'utf8');
    const lines = text.split('\n').length;
    const max = cfg.claude_md?.max_lines ?? 120;
    add(lines <= max ? LEVELS.ok : LEVELS.warn, 'CLAUDE.md size', `${lines} lines (limit ${max})`,
      'it is read in full at every session start, so stale content costs context for no benefit');
    add(/verif|test|build/i.test(text) ? LEVELS.ok : LEVELS.warn, 'CLAUDE.md verification block',
      /verif/i.test(text) ? 'present' : 'no verification section found',
      'add a "Verifying your work" section listing the commands and an example of healthy output');
  }

  const reviewMd = join(repoRoot, 'REVIEW.md');
  if (!existsSync(reviewMd)) {
    add(LEVELS.warn, 'REVIEW.md', 'missing', 'write the review policy so every PR gets the same passes (Lesson 10)');
  } else {
    const text = readFileSync(reviewMd, 'utf8');
    const hasCap = /at most \d+|cap|maximum of \d+/i.test(text);
    add(hasCap ? LEVELS.ok : LEVELS.warn, 'REVIEW.md nit cap', hasCap ? 'present' : 'no nit cap found',
      'the main failure mode of AI review is noise, not misses — cap the nits (Lesson 10 step 6)');
  }

  // --- the control nobody else checks -------------------------------------
  checks.push(branchProtectionCheck(repoRoot, cfg));

  // --- duplicate / shadowed hooks -----------------------------------------
  const projectSettings = join(repoRoot, '.claude', 'settings.json');
  if (existsSync(projectSettings)) {
    try {
      const s = JSON.parse(readFileSync(projectSettings, 'utf8'));
      if (s.hooks && Object.keys(s.hooks).length) {
        add(LEVELS.warn, 'project hooks', `${Object.keys(s.hooks).join(', ')} defined in .claude/settings.json`,
          'a plugin hook is NOT de-duplicated against an identical project hook — both fire, and you get '
          + 'two sources of truth for one policy. Remove the project copy if this plugin now covers it');
      }
      const allow = s.permissions?.allow ?? [];
      const deny = s.permissions?.deny ?? [];
      add(allow.length ? LEVELS.ok : LEVELS.warn, 'safe inner loop pre-approved', `${allow.length} allow rule(s)`,
        'without it the deny set turns into prompt fatigue, and prompt fatigue is how a control gets switched off (Lesson 11)');
      const hasSecretDeny = deny.some((d) => /Read\(.*env|Read\(.*secret/i.test(d));
      add(hasSecretDeny ? LEVELS.ok : LEVELS.warn, 'secret read deny rules', hasSecretDeny ? 'present' : 'missing',
        'files pulled in with an @ reference never fire a PreToolUse hook, so a permissions.deny Read rule '
        + 'is the only coverage for them');
    } catch {
      add(LEVELS.warn, 'project settings', 'not valid JSON', 'fix .claude/settings.json');
    }
  } else {
    add(LEVELS.warn, 'project settings', 'missing .claude/settings.json',
      'run /ai-native-sdlc:sdlc-init to write the pre-approved inner loop and the secret deny rules');
  }

  // --- gitignore ----------------------------------------------------------
  const gi = join(repoRoot, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  add(/sdlc\/config\.local\.json|settings\.local\.json/.test(giText) ? LEVELS.ok : LEVELS.warn,
    '.gitignore covers local overrides', existsSync(gi) ? 'checked' : 'no .gitignore',
    'add .claude/sdlc/config.local.json and .claude/settings.local.json so personal overrides are not committed');

  return { repoRoot, level, configured, checks };
}

/**
 * Ask the forge whether the protected branches are actually protected.
 * Read-only, best-effort, and explicit when it cannot tell — "unknown" must
 * never be rendered as "fine".
 */
function branchProtectionCheck(repoRoot, cfg) {
  const branch = cfg.default_branch || defaultBranch(repoRoot) || 'main';
  const rs = remotes(repoRoot);
  const origin = rs.find((r) => r.name === 'origin')?.url ?? rs[0]?.url ?? '';

  if (!origin) {
    return { status: LEVELS.info, name: 'branch protection', detail: 'no git remote configured',
      fix: 'nothing to check yet; the local push gate is the only control until there is a remote' };
  }
  if (!/github\.com|github/i.test(origin)) {
    return { status: LEVELS.info, name: 'branch protection', detail: `remote is not GitHub (${redactUrl(origin)})`,
      fix: `verify protection on '${branch}' in your forge by hand — the local push gate stops the agent, not another git client` };
  }
  if (!which('gh')) {
    return { status: LEVELS.info, name: 'branch protection', detail: 'gh CLI not installed, cannot verify',
      fix: `install gh and re-run, or confirm by hand that '${branch}' is protected` };
  }

  const r = spawnSync('gh', ['api', `repos/{owner}/{repo}/branches/${branch}/protection`], {
    cwd: repoRoot, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000,
  });

  if (r.status === 0) {
    let requiresReview = false;
    try {
      const j = JSON.parse(r.stdout);
      requiresReview = Boolean(j.required_pull_request_reviews);
    } catch { /* treat as protected-but-unparsed */ }
    return requiresReview
      ? { status: LEVELS.ok, name: 'branch protection', detail: `'${branch}' requires pull request review`, fix: '' }
      : { status: LEVELS.warn, name: 'branch protection', detail: `'${branch}' is protected but does not require review`,
        fix: 'require a pull request review — separation of duties is enforced by the forge, not by this plugin' };
  }

  const err = (r.stderr ?? '').toLowerCase();
  if (err.includes('not protected') || err.includes('404')) {
    return { status: LEVELS.fail, name: 'branch protection', detail: `'${branch}' is NOT protected on the remote`,
      fix: 'this is more urgent than anything this plugin does. The local push gate stops the agent; anyone '
         + 'with another git client can still push to this branch, so separation of duties is not enforced. '
         + 'Enable branch protection requiring a pull request review' };
  }
  return { status: LEVELS.info, name: 'branch protection', detail: 'could not query the forge (not authenticated?)',
    fix: `run \`gh auth login\` and re-run, or confirm by hand that '${branch}' is protected` };
}

function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], { encoding: 'utf8', shell: false, windowsHide: true });
  return r.status === 0 ? (r.stdout ?? '').split('\n')[0].trim() : null;
}

function redactUrl(url) {
  return String(url).replace(/\/\/[^@]+@/, '//***@');
}

export function formatDoctor(result) {
  const order = { fail: 0, warn: 1, info: 2, ok: 3 };
  const mark = { ok: ' ok ', warn: 'WARN', fail: 'FAIL', info: 'info' };
  const rows = [...result.checks].sort((a, b) => order[a.status] - order[b.status]);
  const width = Math.max(...rows.map((c) => c.name.length));

  const out = [`ai-native-sdlc doctor — ${result.repoRoot}`, `enforcement level: ${result.level}`, ''];
  for (const c of rows) {
    out.push(`  [${mark[c.status]}] ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.status !== 'ok' && c.fix) out.push(`         ${wrap(c.fix, 92, ' '.repeat(9))}`);
  }
  const fails = rows.filter((c) => c.status === 'fail').length;
  const warns = rows.filter((c) => c.status === 'warn').length;
  out.push('', `  ${fails} blocking, ${warns} warning(s).`);
  if (fails === 0 && warns === 0) out.push('  This repository is configured and protected.');
  return out.join('\n');
}

function wrap(text, width, indent) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n' + indent);
}
