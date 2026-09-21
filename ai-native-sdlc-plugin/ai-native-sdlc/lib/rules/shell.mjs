/**
 * Shell-command gates — evaluated before Bash / PowerShell runs.
 *
 * Every rule here walks the parsed subcommands rather than regexing the raw
 * string, so `npm run build && git push origin main` is caught and
 * `echo "git push origin main"` is not.
 *
 * These are a recogniser, not a boundary. None of them sees through base64, a
 * script file, or `eval`. That is stated in the block messages and recorded in
 * the enforcement matrix as defence in depth: the server-side branch protection
 * and the CI re-check are the real controls.
 */

import { CLASS, deny, allow, notApplicable } from '../decide.mjs';
import { block, redactCommand } from '../message.mjs';
import { matchesAny, firstMatch, globMatch, toRepoRelative } from '../paths.mjs';
import { parseCommand, writeTargets, readTargets, egressTargets, hostOf } from '../commands.mjs';
import { FIX_PHASE } from '../state.mjs';

const DEFAULT_PROD = /\b(prod|production|prd)\b/i;
const DEFAULT_DEPLOY = /\b(deploy|helm\s+(upgrade|install)|kubectl\s+(apply|rollout)|terraform\s+apply|pulumi\s+up|serverless\s+deploy|sam\s+deploy|cdk\s+deploy|flyctl?\s+deploy|eb\s+deploy)\b/i;

function shellBlock(ctx, { title, policy, id, lesson, why, route, note }) {
  return block({
    title, policy, id, lesson,
    attempted: `${ctx.tool} ${redactCommand(ctx.command)}`,
    why, route, note,
    gate: 'always-hard',
    policyUrl: ctx.user?.policyUrl || undefined,
  });
}

/**
 * h10 — production deploys need a named release authorization.
 *
 * The authorization is an environment variable read from the HOOK process
 * environment. A session cannot write that, so the agent cannot forge it; but a
 * human sets it, so it asserts rather than authenticates. The message says so
 * explicitly instead of implying a stronger guarantee than exists.
 */
export const productionGate = {
  id: 'h10-production-gate',
  policy: 'the agent may act up to the production gate and cannot pass it',
  lesson: 11,
  class: CLASS.A,
  evaluate(ctx) {
    const deployRe = ctx.cfg.deploy_pattern ? new RegExp(ctx.cfg.deploy_pattern, 'i') : DEFAULT_DEPLOY;
    const prodRe = ctx.cfg.production_pattern ? new RegExp(ctx.cfg.production_pattern, 'i') : DEFAULT_PROD;

    const hit = ctx.subcommands.find((s) => deployRe.test(s.raw) && prodRe.test(s.raw));
    if (!hit) return allow();

    const envName = ctx.user?.releaseApprovalEnv || 'SDLC_RELEASE_APPROVAL';
    const value = process.env[envName];
    if (value && value.trim()) {
      const fmt = ctx.cfg.release_approval_pattern;
      if (!fmt || new RegExp(fmt).test(value)) return allow();
      return deny(shellBlock(ctx, {
        title: 'release authorization does not match the required format',
        policy: 'production deploys require a named release authorization',
        id: 'P58', lesson: 11,
        why: `${envName} is set but does not match release_approval_pattern`,
        route: `obtain a correctly formatted authorization${routeSuffix(ctx)}`,
      }), 'release-approval-format');
    }

    return deny(shellBlock(ctx, {
      title: 'production deploy without release authorization',
      policy: 'the agent prepares the release; a named release manager authorizes it',
      id: 'P58', lesson: 11,
      why: `the environment variable ${envName} is not set for this session`,
      route: `ask for an authorization${routeSuffix(ctx)}, then a HUMAN restarts the session with `
           + `${envName}=<id> set. Do not retry this command.`,
      note: 'this gate checks that an authorization is present and attributable, not that it is genuine; '
          + 'the deploy credential itself should live in CI or behind an environment-scoped MCP tool',
    }), 'production-deploy-unauthorized');
  },
};

function routeSuffix(ctx) {
  const r = ctx.user?.releaseApprovalRoute;
  return r ? ` (${r})` : '';
}

/**
 * h11 — no path to main, and no approving your own work.
 * Server-side branch protection remains the real control; this is the fast,
 * local half that explains itself before the push fails.
 */
export const branchProtectionGuard = {
  id: 'h11-branch-protection-guard',
  policy: 'anything the agent writes arrives as a PR; the agent that wrote the code cannot approve it',
  lesson: 12,
  class: CLASS.A,
  evaluate(ctx) {
    const protectedBranches = ctx.cfg.protected_branches ?? [];
    const defaultBranch = ctx.cfg.default_branch || ctx.defaultBranch;
    const isProtected = (name) => {
      if (!name) return false;
      const n = name.replace(/^refs\/heads\//, '').replace(/^\+/, '');
      if (defaultBranch && n === defaultBranch) return true;
      return protectedBranches.some((p) => globMatch(p, n));
    };

    for (const s of ctx.subcommands) {
      if (s.verb === 'git' && s.sub1 === 'push') {
        // Refspec forms: `git push origin main`, `git push origin HEAD:main`.
        const refs = s.operands.slice(2);
        const targets = refs.map((r) => (r.includes(':') ? r.split(':').pop() : r));
        const destination = targets.find(isProtected)
          ?? (refs.length === 0 && isProtected(ctx.branch) ? ctx.branch : null);

        if (destination) {
          return deny(shellBlock(ctx, {
            title: `push to protected branch '${destination}'`,
            policy: 'anything the agent writes arrives as a PR through branch protection; it has no path to main',
            id: 'P55', lesson: 12,
            why: `'${destination}' is a protected branch`,
            route: 'create a branch, push that, and open a PR; approval comes from a code owner',
            note: 'server-side branch protection is the authoritative control — run /ai-native-sdlc:sdlc-doctor to confirm it is configured',
          }), `push-protected:${destination}`);
        }
        if (s.hasFlag('--force', '-f') && (refs.length === 0 || targets.some(isProtected))) {
          return deny(shellBlock(ctx, {
            title: 'force push to a protected branch',
            policy: 'history on protected branches is not rewritten from a session',
            id: 'P55', lesson: 12,
            why: 'the push carries --force at a protected destination',
            route: 'use --force-with-lease on your own feature branch, or ask a maintainer',
          }), 'force-push-protected');
        }
        if (s.hasFlag('--mirror')) {
          return deny(shellBlock(ctx, {
            title: 'mirror push', policy: 'a mirror push rewrites every ref on the remote',
            id: 'P55', lesson: 12, why: 'the push carries --mirror',
            route: 'push the specific branch you intend to publish',
          }), 'mirror-push');
        }
      }

      // Separation of duties: the author cannot approve or merge its own work.
      if (s.verb === 'gh' && s.sub1 === 'pr' && ['merge', 'review'].includes(s.sub2)) {
        const approving = s.sub2 === 'merge' || s.hasFlag('--approve');
        if (approving) {
          return deny(shellBlock(ctx, {
            title: `self-${s.sub2 === 'merge' ? 'merge' : 'approval'} of a pull request`,
            policy: 'the agent that wrote the code has no way to approve it',
            id: 'P54', lesson: 10,
            why: `\`gh pr ${s.sub2}\` would ${s.sub2 === 'merge' ? 'merge' : 'approve'} without a second party`,
            route: 'request review from a code owner; findings inform the decision, a human makes it',
          }), `self-${s.sub2}`);
        }
      }

      // Hook and history bypasses.
      if (s.verb === 'git' && s.hasFlag('--no-verify', '-n') && ['commit', 'push'].includes(s.sub1)) {
        return deny(shellBlock(ctx, {
          title: 'repository hooks bypassed with --no-verify',
          policy: 'the checks a repository runs on commit are not optional for an agent',
          id: 'P55', lesson: 12,
          why: `\`git ${s.sub1}\` carries --no-verify`,
          route: 'fix what the hook is reporting, then commit normally',
        }), 'no-verify');
      }
      if (s.verb === 'git' && s.sub1 === 'config' && /core\.hookspath|alias\./i.test(s.raw)) {
        return deny(shellBlock(ctx, {
          title: 'git configuration change that would move or alias the enforcement surface',
          policy: 'the agent cannot reconfigure the checks that constrain it',
          id: 'P65', lesson: 11,
          why: 'the command rewrites core.hooksPath or a git alias',
          route: 'a human changes git configuration outside the session if it is genuinely needed',
        }), 'git-config-tamper');
      }
    }
    return allow();
  },
};

/**
 * h14 — the file gates cannot be stepped around by writing through the shell.
 *
 * The documentation is explicit that Edit/Write matchers do not see a file
 * changed by `sed -i` or a redirect, and names a per-turn working-tree scan as
 * the coverage pattern. This is the fast half of that pairing; stop-scan is the
 * backstop for anything this recogniser misses.
 */
export const shellWriteShadow = {
  id: 'h14-shell-write-shadow',
  policy: 'the file guards cannot be evaded by writing through the shell',
  lesson: 6,
  class: CLASS.A,
  evaluate(ctx) {
    const p = ctx.cfg.paths ?? {};
    const phase = ctx.state?.fix?.phase ?? FIX_PHASE.OFF;

    const protectedGlobs = [
      ...(p.generated ?? []),
      ...(p.frozen ?? []).map((f) => (typeof f === 'string' ? f : f?.glob)).filter(Boolean),
      ...(p.lockfiles ?? []),
      '.claude/sdlc/**', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/**',
    ];

    for (const s of ctx.subcommands) {
      for (const raw of writeTargets(s)) {
        const rel = toRel(ctx, raw);
        if (!rel) continue;

        if (phase === FIX_PHASE.LOCKED && matchesAny(p.tests, rel)) {
          return deny(shellBlock(ctx, {
            title: 'test file changed through the shell during a fix',
            policy: 'an agent fixing code must not be able to weaken the check on that code',
            id: 'P39', lesson: 8,
            why: `the command writes to '${rel}', which matches paths.tests, while fix mode is locked`,
            route: 'change the code until the committed test passes; only a human may run /ai-native-sdlc:fix abort',
          }), 'shell-test-write');
        }

        const hit = firstMatch(protectedGlobs, rel);
        if (hit) {
          return deny(shellBlock(ctx, {
            title: 'protected path written through the shell',
            policy: 'generated, frozen and configuration paths are not editable from a session',
            id: 'P20/P65', lesson: 6,
            why: `the command writes to '${rel}', which matches '${hit}'`,
            route: 'change the source that generates it, or open a PR against the protected file',
          }), `shell-protected-write:${hit}`);
        }
      }
    }
    return allow();
  },
};

/**
 * h06s — credentials are not read into context through the shell either.
 * `permissions.deny` on Read is the primary control (it also covers @-references,
 * which never fire a PreToolUse hook at all); this closes the shell path.
 */
export const shellSecretRead = {
  id: 'h06-shell-secret-read',
  policy: 'credentials never enter the agent’s context',
  lesson: 11,
  class: CLASS.A,
  evaluate(ctx) {
    const p = ctx.cfg.paths ?? {};
    const extra = ['**/.ssh/**', '**/.aws/credentials', '**/.netrc', '**/.npmrc', '**/.docker/config.json'];
    const denyGlobs = [...(p.secrets_read_deny ?? []), ...extra];

    for (const s of ctx.subcommands) {
      // `printenv`/`env` with no operand dumps the whole environment.
      if ((s.verb === 'printenv' || s.rawVerb === 'env') && s.operands.length === 0) {
        return deny(shellBlock(ctx, {
          title: 'environment dump',
          policy: 'credentials never enter the agent’s context',
          id: 'P62', lesson: 11,
          why: 'the command prints the entire environment, which carries tokens',
          route: 'read the one variable you need by name, e.g. `printenv PATH`',
        }), 'env-dump');
      }

      for (const raw of readTargets(s)) {
        const rel = toRel(ctx, raw) ?? raw.replace(/\\/g, '/');
        if (matchesAny(p.secrets_read_allow, rel)) continue;
        const hit = firstMatch(denyGlobs, rel);
        if (hit) {
          return deny(shellBlock(ctx, {
            title: 'secret file read through the shell',
            policy: 'credentials never enter the agent’s context',
            id: 'P62/P67', lesson: 11,
            why: `the command reads '${rel}', which matches '${hit}'`,
            route: 'ask the human for the variable NAMES you need; the values belong in the environment or a secret manager',
            note: 'this is defence in depth — indirection can evade a recogniser, and on native Windows there is no OS sandbox behind it',
          }), `shell-secret-read:${hit}`);
        }
      }
    }
    return allow();
  },
};

/**
 * h28 — arbitrary network egress. Class B: blocks at standard, warns at
 * advisory, because a false positive here stalls ordinary work.
 * localhost is always allowed: feedback loops hit local endpoints.
 */
export const egressGuard = {
  id: 'h28-egress-guard',
  policy: 'arbitrary network egress is not available to the agent',
  lesson: 11,
  class: CLASS.B,
  evaluate(ctx) {
    const allowed = ctx.cfg.allowed_domains ?? [];
    for (const s of ctx.subcommands) {
      for (const url of egressTargets(s)) {
        const host = hostOf(url);
        if (!host) continue;
        if (/^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/.test(host) || host.endsWith('.localhost')) continue;
        if (allowed.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()))) continue;
        return deny(shellBlock(ctx, {
          title: `network egress to ${host}`,
          policy: 'network egress goes to an allow-listed host or through an approved tool',
          id: 'P63', lesson: 11,
          why: `'${host}' is not in allowed_domains and is not localhost`,
          route: `add '${host}' to allowed_domains in the repo config via PR, or use the approved MCP tool`,
          note: 'a tool-level deny does not stop a script that fetches; the OS-level allowlist is the airtight layer and is unavailable on native Windows',
        }), `egress:${host}`);
      }
    }
    return allow();
  },
};

function toRel(ctx, rawPath) {
  const cleaned = String(rawPath).replace(/^["']|["']$/g, '');
  if (!cleaned || cleaned.startsWith('-')) return null;
  if (/^([A-Za-z]:[\\/]|\/)/.test(cleaned)) return toRepoRelative(cleaned, ctx.repoRoot);
  return cleaned.replace(/\\/g, '/').replace(/^\.\//, '');
}

export const shellRules = [
  productionGate,
  branchProtectionGuard,
  shellSecretRead,
  shellWriteShadow,
  egressGuard,
];
