/**
 * Configuration loading and merging.
 *
 * Three layers, each owned by a different party — this is what makes one plugin
 * serve many repositories without a fork (requirement R1):
 *
 *   defaults      shipped here, deliberately conservative
 *   repo file     .claude/sdlc/config.json — version-controlled, PR-reviewed
 *   local file    .claude/sdlc/config.local.json — gitignored, MAY ONLY TIGHTEN
 *   userConfig    CLAUDE_PLUGIN_OPTION_* — organization level, wins on its keys
 *
 * The local layer is tighten-only *by construction*: protective lists are
 * unioned rather than replaced, and the enforcement level can only move upward.
 * An engineer who wants to run stricter than their team has somewhere to go; an
 * engineer who wants to run looser has to change a reviewed file.
 *
 * Repo root is found by walking up from the hook's stdin `cwd`, not from
 * CLAUDE_PROJECT_DIR: the documented behaviour is that CLAUDE_PROJECT_DIR stays
 * pinned to where the session started while `cwd` follows Claude into a
 * worktree, and the worktree is the tree being edited.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, parse as parsePath } from 'node:path';
import { normalise } from './paths.mjs';

export const LEVELS = ['advisory', 'standard', 'strict'];

export const DEFAULTS = {
  schema_version: 1,
  intent_home: 'intent',
  default_branch: '',
  protected_branches: ['main', 'master', 'trunk', 'release/*'],
  commands: {
    test: { cmd: '', healthy_regex: '', failure_regex: '' },
    build: { cmd: '', healthy_regex: '', failure_regex: '' },
    lint: { cmd: '', healthy_regex: '', failure_regex: '' },
    format: { cmd: '', extensions: [] },
    run: { cmd: '' },
  },
  command_shell: 'auto',
  paths: {
    tests: [
      '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**',
      '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py',
      '**/*Test.java', '**/*Tests.cs',
    ],
    generated: [],
    frozen: [],
    manifests: [],
    lockfiles: [
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
      'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
    ],
    migrations: [],
    infra: [],
    verify_exempt: ['**/*.md', '**/docs/**', '.gitignore', 'LICENSE'],
    secrets_read_deny: [
      '.env', '.env.*', '**/secrets/**', '**/*.pem', '**/*.key',
      '**/*.p12', '**/*.pfx', '**/id_rsa', '**/id_ed25519',
      '**/.aws/credentials', '**/.ssh/**', '**/.netrc',
    ],
    secrets_read_allow: ['.env.example', '.env.sample', '.env.template', '**/*.pub'],
    secret_scan_allow: ['**/*.example', '**/fixtures/**', '**/testdata/**'],
    plan_sync_ignore: ['**/*.lock', '**/package-lock.json'],
  },
  allowed_domains: [],
  claude_md: { max_lines: 120, max_bytes: 8000 },
  artifacts: { required_sections: null }, // null = use the built-in schema
  owners: { dependencies: '', policy: '' },
  readonly_agent_types: ['verifier', 'researcher', 'compliance-reviewer'],
  unparseable_tool_input: 'deny',
  advisory_grace_days: 14,
  ops: { bands_path: 'ops/bands.json', readonly_allow: [], routes: [] },
  waivers: [],
};

/** Keys whose repo value the LOCAL layer may only extend, never shrink. */
const TIGHTEN_ONLY_LISTS = [
  'paths.tests', 'paths.generated', 'paths.frozen', 'paths.manifests',
  'paths.lockfiles', 'paths.migrations', 'paths.infra', 'paths.secrets_read_deny',
  'protected_branches',
];

/** Find the repository root by walking up from `startDir` looking for .git. */
export function findRepoRoot(startDir) {
  let dir = startDir;
  const { root } = parsePath(dir);
  for (let i = 0; i < 64 && dir && dir !== root; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No git repository: treat the starting directory as the root so path rules
  // still work. git-dependent rules report themselves inert instead of failing.
  return startDir;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  // Strip a UTF-8 BOM: a Windows editor can add one and JSON.parse rejects it.
  return JSON.parse(text.replace(/^﻿/, ''));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge where later objects win. Arrays are replaced, not concatenated. */
function mergeDeep(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v);
    else out[k] = v;
  }
  return out;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Apply the local layer under tighten-only semantics:
 *   - protective lists are unioned with the repo's, never replaced
 *   - the enforcement level may only move up
 *   - everything else (commands, formatting) is an ordinary override
 */
function applyLocal(repoCfg, localCfg) {
  if (!isPlainObject(localCfg)) return repoCfg;

  const merged = mergeDeep(repoCfg, localCfg);

  for (const dotted of TIGHTEN_ONLY_LISTS) {
    const fromRepo = getPath(repoCfg, dotted);
    const fromLocal = getPath(localCfg, dotted);
    if (Array.isArray(fromRepo) && Array.isArray(fromLocal)) {
      setPath(merged, dotted, [...new Set([...fromRepo, ...fromLocal])]);
    } else if (Array.isArray(fromRepo)) {
      setPath(merged, dotted, fromRepo);
    }
  }

  // Waivers loosen policy, so the local layer may not introduce them.
  merged.waivers = Array.isArray(repoCfg.waivers) ? repoCfg.waivers : [];

  return merged;
}

/** Read the organization layer from the hook process environment. */
export function readUserConfig(env = process.env) {
  const get = (k) => env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`];
  const level = (get('enforcement_level') || '').trim().toLowerCase();
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    // Validated in code rather than through the manifest's `options` field,
    // which needs a newer runtime than the floor this plugin supports.
    level: LEVELS.includes(level) ? level : 'standard',
    hardHooksLocked: (get('hard_hooks_locked') ?? 'true').toString().toLowerCase() !== 'false',
    configPath: (get('sdlc_config_path') || '.claude/sdlc/config.json').trim(),
    releaseApprovalEnv: (get('release_approval_env') || 'SDLC_RELEASE_APPROVAL').trim(),
    releaseApprovalRoute: (get('release_approval_route') || '').trim(),
    releaseGateMode: (get('release_gate_mode') || 'deny').trim().toLowerCase() === 'warn' ? 'warn' : 'deny',
    policyUrl: (get('organization_policy_url') || '').trim(),
    logRetentionDays: num(get('log_retention_days'), 30),
    telemetryForwardCommand: (get('telemetry_forward_command') || '').trim(),
  };
}

/**
 * Load the full effective configuration for a hook invocation.
 * Never throws: a broken repo config is reported through `errors` so the caller
 * can surface it, rather than taking the session down.
 */
export function loadConfig(cwd, env = process.env) {
  const user = readUserConfig(env);
  const repoRoot = findRepoRoot(cwd || process.cwd());
  const errors = [];

  const repoFile = join(repoRoot, user.configPath);
  const localFile = repoFile.replace(/\.json$/, '.local.json');

  let repoCfg = null;
  let localCfg = null;

  try {
    repoCfg = readJson(repoFile);
  } catch (err) {
    errors.push(`repo config ${user.configPath} is not valid JSON: ${err.message}`);
  }
  try {
    localCfg = readJson(localFile);
  } catch (err) {
    errors.push(`local config is not valid JSON and was ignored: ${err.message}`);
  }

  const configured = repoCfg !== null;
  let cfg = mergeDeep(DEFAULTS, repoCfg ?? {});
  cfg = applyLocal(cfg, localCfg);

  // The local layer may raise the level but never lower it.
  let level = user.level;
  const localLevel = (localCfg?.enforcement_level || '').toLowerCase();
  if (LEVELS.includes(localLevel) && LEVELS.indexOf(localLevel) > LEVELS.indexOf(level)) {
    level = localLevel;
  }

  return {
    repoRoot: normalise(repoRoot),
    configured,          // false = repo has not run /sdlc-init yet
    configPath: user.configPath,
    level,
    user,
    cfg,
    errors,
  };
}
