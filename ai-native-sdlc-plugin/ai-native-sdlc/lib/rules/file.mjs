/**
 * File-write gates — everything evaluated before Edit / Write / MultiEdit /
 * NotebookEdit runs.
 *
 * All of these are Class A: they ignore the enforcement level and fail closed.
 * They are the set the plan calls safety-critical, and on native Windows there
 * is no sandbox beneath them, so they are the only layer.
 *
 * Rules run in order and the first deny short-circuits, so the cheapest and
 * most decisive checks come first.
 */

import { CLASS, deny, allow, notApplicable } from '../decide.mjs';
import { block, describeTarget } from '../message.mjs';
import { matchesAny, firstMatch, globMatch } from '../paths.mjs';
import { scanAll, describe as describeFindings } from '../secrets.mjs';
import { FIX_PHASE } from '../state.mjs';
import { validate, artifactKind } from '../artifacts.mjs';

const CLAUDE_CONFIG_GLOBS = [
  '.claude/sdlc/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/**',
  '.claude-plugin/**',
];

/** Markers that disable a test rather than fix the code it guards. */
const SKIP_MARKERS = [
  /\.skip\s*\(/, /\bxit\s*\(/, /\bxdescribe\s*\(/, /\.only\s*\(/,
  /@Disabled\b/, /@Ignore\b/, /\bpytest\.mark\.(skip|xfail)\b/,
  /@unittest\.skip/, /\bt\.Skip\s*\(/, /#\[ignore\]/, /\[Ignore\]/,
  /\[Fact\(Skip/, /\bTODO:\s*re-?enable/i,
];

/**
 * h26 — a read-only subagent may not write, whatever its frontmatter says.
 *
 * The shipped verifier has no write tools, which is a hard restriction. But the
 * moment someone copies verifier.md into .claude/agents/ and adds Edit — which
 * the docs actively encourage for agents that need hooks or permissionMode —
 * that restriction is gone. Plugin hooks DO run inside subagents and the payload
 * carries agent_type, so this check survives the copy.
 */
export const agentTypeWriteDeny = {
  id: 'h26-agent-type-write-deny',
  policy: 'a verifying agent reports, it does not fix',
  lesson: 7,
  class: CLASS.A,
  evaluate(ctx) {
    const at = ctx.agentType;
    if (!at) return notApplicable();
    const readonly = ctx.cfg.readonly_agent_types ?? [];
    if (!readonly.some((t) => String(t).toLowerCase() === String(at).toLowerCase())) return allow();
    return deny(
      block({
        title: `write from read-only agent '${at}'`,
        policy: 'the verifier exercises the change and reports; it does not fix anything',
        id: 'P34', lesson: 7,
        attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
        why: `agent_type '${at}' is listed in readonly_agent_types`,
        route: 'report the finding to the main session and let it make the change; '
             + 'to let this agent write, remove it from readonly_agent_types in the repo config via PR',
        gate: 'always-hard',
      }),
      `readonly-agent:${at}`,
    );
  },
};

/**
 * h25 — the agent may not rewrite the configuration that constrains it.
 *
 * A control layer the controlled thing can edit is not a control layer. Only a
 * user-invoked maintenance command (which is disable-model-invocation, so the
 * model cannot call it) lifts this.
 */
export const configSelfProtection = {
  id: 'h25-config-self-protection',
  policy: 'agent configuration is code and changes through review',
  lesson: 5,
  class: CLASS.A,
  evaluate(ctx) {
    if (!ctx.relPath) return notApplicable();
    if (ctx.state?.maintenance) return allow();
    const hit = firstMatch(CLAUDE_CONFIG_GLOBS, ctx.relPath);
    if (!hit) return allow();
    return deny(
      block({
        title: 'edit to the enforcement configuration',
        policy: 'the agent cannot loosen the gates that constrain it; config changes go through review',
        id: 'P18/P65', lesson: 5,
        attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
        why: `path matches protected configuration '${hit}'`,
        route: 'a human runs /ai-native-sdlc:sdlc-init --reconfigure, or edits the file directly and opens a PR',
        gate: 'always-hard',
      }),
      `config-self-protection:${hit}`,
    );
  },
};

/**
 * h03 — credentials never enter the diff.
 *
 * Scans only the NEW content. Scanning old_string would flag a secret being
 * removed, which is the one change you most want to encourage.
 */
export const credentialGuard = {
  id: 'h03-credential-guard',
  policy: 'keep credentials out of the diff',
  lesson: 6,
  class: CLASS.A,
  evaluate(ctx) {
    const strings = ctx.content?.strings ?? [];
    if (strings.length === 0) return notApplicable();
    if (ctx.relPath && matchesAny(ctx.cfg.paths?.secret_scan_allow, ctx.relPath)) return allow();

    const findings = scanAll(strings);
    if (findings.length === 0) return allow();

    return deny(
      block({
        title: 'credential-like literal in new content',
        policy: 'keep credentials out of the diff',
        id: 'P28', lesson: 6,
        attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
        // The value is never shown: naming the pattern and the line is enough
        // to act on, and putting the secret in the message would defeat the gate.
        why: `matched ${describeFindings(findings)} (value not shown)`,
        route: 'read the value from an environment variable or your secret manager; '
             + 'for a fixture, add the path to paths.secret_scan_allow in the repo config via PR',
        gate: 'always-hard',
      }),
      `secret:${findings.map((f) => f.pattern).join('+')}`,
    );
  },
};

/**
 * h04 — during a fix task the agent must not weaken the check on the code it
 * is fixing. The plan calls this the hook that protects the whole feedback loop.
 */
export const testLock = {
  id: 'h04-test-lock',
  policy: 'an agent fixing code must not be able to weaken the check on that code',
  lesson: 8,
  class: CLASS.A,
  evaluate(ctx) {
    if (!ctx.relPath) return notApplicable();
    const phase = ctx.state?.fix?.phase ?? FIX_PHASE.OFF;
    const isTest = matchesAny(ctx.cfg.paths?.tests, ctx.relPath);

    if (phase === FIX_PHASE.LOCKED && isTest) {
      const since = ctx.state?.fix?.entered_at ? ` (locked since ${ctx.state.fix.entered_at})` : '';
      return deny(
        block({
          title: 'test edit during a fix',
          policy: 'an agent fixing code must not be able to weaken the check on that code',
          id: 'P39', lesson: 8,
          attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
          why: `fix mode is locked${since}; this path matches paths.tests`,
          route: 'change the code until the committed test passes, then run /ai-native-sdlc:verify. '
               + 'Only a human may run /ai-native-sdlc:fix abort, which is recorded.',
          gate: 'always-hard while locked',
        }),
        'test-lock:locked',
      );
    }

    // Outside a fix, a test may be edited — but not to switch itself off.
    if (isTest) {
      const added = (ctx.content?.strings ?? []).join('\n');
      const removed = (ctx.outgoing ?? []).join('\n');
      const marker = SKIP_MARKERS.find((re) => re.test(added) && !re.test(removed));
      if (marker && !ctx.cfg.allow_test_skips) {
        return deny(
          block({
            title: 'test disabled rather than fixed',
            policy: 'if a test fails, fix the code, not the test; never skip or delete a failing test',
            id: 'P41', lesson: 8,
            attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
            why: `the new content adds a skip/ignore marker (${String(marker)}) that the old content did not have`,
            route: 'fix the code under test; if the test is genuinely obsolete, remove it in a separate PR '
                 + 'with reviewer sign-off, or set allow_test_skips in the repo config via PR',
            gate: 'always-hard',
          }),
          'test-skip-marker',
        );
      }
    }
    return allow();
  },
};

/**
 * h05 — generated, frozen, dependency-manifest, migration and infrastructure
 * paths. One rule because they share a shape: a path list plus a route.
 */
export const protectedPathGuard = {
  id: 'h05-protected-path-guard',
  policy: 'generated and frozen paths are read-only; dependency and infrastructure changes are owned elsewhere',
  lesson: 5,
  class: CLASS.A,
  evaluate(ctx) {
    if (!ctx.relPath) return notApplicable();
    const p = ctx.cfg.paths ?? {};

    const generated = firstMatch(p.generated, ctx.relPath);
    if (generated) {
      return deny(makeBlock(ctx, {
        title: 'edit to a generated path',
        policy: 'generated files are produced, not edited; change the source that generates them',
        id: 'P20', lesson: 5,
        why: `path matches paths.generated '${generated}'`,
        route: 'edit the schema or template that generates this file and re-run the generator',
      }), `generated:${generated}`);
    }

    // Frozen entries may carry a successor so the message can point somewhere.
    for (const entry of p.frozen ?? []) {
      const glob = typeof entry === 'string' ? entry : entry?.glob;
      if (glob && globMatch(glob, ctx.relPath)) {
        const successor = typeof entry === 'object' ? entry.successor : null;
        return deny(makeBlock(ctx, {
          title: 'edit to a frozen path',
          policy: 'frozen packages are read-only; changes go to the successor',
          id: 'P20', lesson: 5,
          why: `path matches paths.frozen '${glob}'`,
          route: successor
            ? `implement this in ${successor} instead`
            : 'implement this in the successor package; if the frozen path truly must change, '
              + 'a human opens a PR editing paths.frozen with the owner’s sign-off',
        }), `frozen:${glob}`);
      }
    }

    const lock = firstMatch(p.lockfiles, ctx.relPath);
    if (lock) {
      return deny(makeBlock(ctx, {
        title: 'edit to a dependency lockfile',
        policy: 'do not bump dependency versions; the platform team owns them',
        id: 'P19', lesson: 5,
        why: `path matches paths.lockfiles '${lock}'`,
        route: ownerRoute(ctx, 'regenerate the lockfile through the dependency process'),
      }), `lockfile:${lock}`);
    }

    const manifest = firstMatch(p.manifests, ctx.relPath);
    if (manifest && changesVersionSpecifier(ctx)) {
      return deny(makeBlock(ctx, {
        title: 'dependency version change',
        policy: 'do not bump dependency versions; the platform team owns them',
        id: 'P19', lesson: 5,
        why: `the new content changes a version specifier in '${manifest}'`,
        route: ownerRoute(ctx, 'request the bump through the dependency process'),
      }), `manifest-version:${manifest}`);
    }

    const infra = firstMatch([...(p.migrations ?? []), ...(p.infra ?? [])], ctx.relPath);
    if (infra && !hasChangeTicket(ctx)) {
      return deny(makeBlock(ctx, {
        title: 'migration or infrastructure change without a change ticket',
        policy: 'no edits to migrations or infrastructure without a change ticket',
        id: 'P59', lesson: 11,
        why: `path matches '${infra}' and no change ticket was found on the branch name or in the environment`,
        route: `obtain a change ticket${ctx.user?.releaseApprovalRoute ? ` (${ctx.user.releaseApprovalRoute})` : ''}, `
             + 'then branch as <TICKET>-<change> or set the change-ticket environment variable before starting the session',
      }), `no-change-ticket:${infra}`);
    }

    return allow();
  },
};

/**
 * h07 — artifacts live in the intent home, and a spec does not exist without
 * the intent it came from.
 */
export const artifactHomeGuard = {
  id: 'h07-artifact-home-guard',
  policy: 'each stage ends by committing its artifact, and the pair records what was asked and what was decided',
  lesson: 2,
  class: CLASS.A,
  evaluate(ctx) {
    if (!ctx.relPath) return notApplicable();
    const base = ctx.relPath.slice(ctx.relPath.lastIndexOf('/') + 1).toLowerCase();
    if (!['intent.md', 'spec.md', 'plan.md'].includes(base)) return allow();

    const home = (ctx.cfg.intent_home ?? 'intent').replace(/^\/+|\/+$/g, '');
    if (!home) return allow();
    const inHome = ctx.relPath === `${home}/${base}` || ctx.relPath.startsWith(`${home}/`);
    if (inHome) return allow();

    // A template directory is not an artifact.
    if (/(^|\/)(_templates|templates|examples)\//.test(ctx.relPath)) return allow();

    return deny(makeBlock(ctx, {
      title: `${base} written outside the intent home`,
      policy: 'artifacts are committed to the shared, version-controlled intent home so author and timestamp join the record',
      id: 'P05', lesson: 2,
      why: `'${ctx.relPath}' is not under '${home}/'`,
      route: `write it to ${home}/<change-name>/${base}; to move the intent home, change intent_home in the repo config via PR`,
    }), `artifact-outside-home:${base}`);
  },
};

// --- helpers ---------------------------------------------------------------

function makeBlock(ctx, { title, policy, id, lesson, why, route }) {
  return block({
    title, policy, id, lesson,
    attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
    why, route,
    gate: 'always-hard',
    policyUrl: ctx.user?.policyUrl || undefined,
  });
}

function ownerRoute(ctx, fallback) {
  const owner = ctx.cfg.owners?.dependencies;
  return owner
    ? `ask ${owner} to make this change`
    : `${fallback}; if this repository lets engineers manage versions, set paths.manifests to [] in the repo config via PR`;
}

/** Does the incoming content change a version specifier in a manifest? */
function changesVersionSpecifier(ctx) {
  const added = (ctx.content?.strings ?? []).join('\n');
  const removed = (ctx.outgoing ?? []).join('\n');
  const VERSION = /("[^"]+"\s*:\s*"[~^><=]*\d+[\w.\-+*]*")|(<version>[^<]+<\/version>)|(^\s*[\w.\-]+\s*[=<>~!]=\s*\d)|(\brequire\s+[\w./-]+\s+v?\d)/m;
  // A Write replaces the whole file, so there is no old side to compare with;
  // treat any version-looking line as a change rather than guessing.
  if (!removed) return VERSION.test(added);
  return VERSION.test(added) && added !== removed;
}

function hasChangeTicket(ctx) {
  const pattern = ctx.cfg.change_ticket_pattern
    ? new RegExp(ctx.cfg.change_ticket_pattern)
    : /\b[A-Z][A-Z0-9]+-\d+\b/;
  const envName = ctx.cfg.change_ticket_env || 'SDLC_CHANGE_TICKET';
  const candidates = [ctx.branch, process.env[envName], ctx.state?.change_ticket].filter(Boolean);
  return candidates.some((c) => pattern.test(String(c)));
}

/**
 * h08 — an artifact carries the sections that make it usable by the next stage.
 *
 * Class B: this is structure, not safety, and a team mid-migration should be
 * able to run it as a warning. Headings are matched through the bilingual alias
 * table, so a Chinese-language intent.md is not rejected for sections that are
 * present under their Chinese names.
 */
export const artifactStructure = {
  id: 'h08-artifact-structure',
  policy: 'each artifact carries the sections the next stage reads',
  lesson: 2,
  class: CLASS.B,
  evaluate(ctx) {
    if (!ctx.relPath) return notApplicable();
    const kind = artifactKind(ctx.relPath);
    if (!kind) return notApplicable();
    if (/(^|\/)(_templates|templates|examples)\//.test(ctx.relPath)) return allow();

    // Only a whole-file write can be validated from tool input alone; a partial
    // Edit is checked against the resulting file by the turn scan instead.
    const whole = ctx.toolInput?.content;
    if (typeof whole !== 'string') return notApplicable();

    const res = validate(kind, whole, {
      level: ctx.level,
      aliasOverrides: ctx.cfg.artifacts?.aliases,
    });
    if (res.ok) return allow();

    return deny(
      block({
        title: `${kind} is missing required sections`,
        policy: res.schema.policy,
        id: res.schema.id, lesson: res.schema.lesson,
        attempted: describeTarget(ctx.tool, ctx.relPath, ctx.absPath),
        why: `missing ${res.missing.join(', ')}`,
        route: 'add the missing sections — headings are accepted in English or Chinese, '
             + 'and further names can be mapped under artifacts.aliases in the repo config',
        gate: `level=${ctx.level}`,
        policyUrl: ctx.user?.policyUrl || undefined,
      }),
      res.detail,
    );
  },
};

/**
 * Rules in evaluation order: cheapest and most decisive first, so the common
 * allow path does the least work and a deny short-circuits the rest.
 */
export const fileRules = [
  agentTypeWriteDeny,
  configSelfProtection,
  credentialGuard,
  testLock,
  protectedPathGuard,
  artifactHomeGuard,
  artifactStructure,
];
