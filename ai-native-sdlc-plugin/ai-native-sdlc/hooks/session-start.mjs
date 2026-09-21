/**
 * SessionStart — bootstrap and an honest status line.
 *
 * The matcher includes `fork`. Omitting it was a real defect in the design this
 * was built from: a forked session would initialise no state, so fix mode, the
 * active change and the verification record would all read as defaults and the
 * test lock would be silently off in the fork.
 *
 * The injected context states facts rather than giving instructions — text
 * delivered as additionalContext is wrapped in a system reminder, and imperative
 * phrasing there can read as an injected instruction.
 *
 * It also says plainly when the repository is NOT protected. A plugin that stays
 * quiet when it is inert lets a team believe gates are armed that are not, which
 * is worse than having no plugin at all.
 */

import { readPayload, emitContext, emitAllow } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';
import { configuredCommands, describeRecord } from '../lib/verify.mjs';
import * as state from '../lib/state.mjs';
import { repoKey as gitRepoKey, isRepo, currentBranch } from '../lib/git.mjs';
import { prune as pruneLedger } from '../lib/log.mjs';

const EVENT = 'SessionStart';

async function main() {
  const payload = await readPayload();
  if (!payload) return emitAllow();

  const cwd = payload.cwd || process.cwd();
  const { repoRoot, cfg, level, user, configured, errors } = loadConfig(cwd);
  const repoKey = gitRepoKey(repoRoot);

  // Housekeeping: retention is a config value, not a hardcoded policy.
  try { pruneLedger(user.logRetentionDays); } catch { /* never fatal */ }
  try { state.prune(Math.max(user.logRetentionDays, 7)); } catch { /* never fatal */ }

  const s = state.read(payload.session_id, repoKey);
  // A fresh or forked session starts from a known state rather than inheriting
  // whatever happened to be on disk.
  if (!s._corrupt && payload.source !== 'resume') {
    state.update(payload.session_id, repoKey, (st) => {
      st.stop_blocks = 0;
      st.maintenance = false;
      return st;
    });
  }

  const lines = [];

  if (!state.hasPluginData()) {
    lines.push(
      'ai-native-sdlc: CLAUDE_PLUGIN_DATA is not set, so session state is being kept in a temporary '
      + 'directory. The fix-mode test lock may not survive a restart.',
    );
  }

  if (!configured) {
    lines.push(
      `ai-native-sdlc is installed but this repository is not configured: no ${user.configPath}. `
      + 'The always-hard gates (credentials, production deploy, protected branches, config self-protection) '
      + 'are active with built-in defaults; the repository-specific gates (protected paths, test lock, '
      + 'verification) have nothing to match against and are inert. '
      + 'Running /ai-native-sdlc:sdlc-init configures them.',
    );
  } else {
    const cmds = configuredCommands(cfg);
    const verify = cmds.length
      ? cmds.map((c) => `${c.kind}=\`${c.cmd}\``).join(', ')
      : 'none configured (nothing can prove a change works)';

    lines.push(
      `ai-native-sdlc is active at enforcement level ${level}. `
      + `Verification: ${verify}. `
      + `Artifact home: ${cfg.intent_home}/. `
      + `Fix mode: ${s.fix?.phase ?? 'off'}${s.fix?.phase === state.FIX_PHASE.LOCKED ? ' (test files are read-only)' : ''}. `
      + `Active change: ${s.change_dir ?? 'none'}. `
      + `${describeRecord(s.last_verified)}.`,
    );

    lines.push(
      'Always-hard gates, which the enforcement level does not affect: credentials in a diff, secret file reads, '
      + 'production deploys without an authorization, pushes to a protected branch, self-approval or self-merge, '
      + 'the fix-mode test lock, protected and generated paths, and edits to the plugin\'s own configuration.',
    );
  }

  if (!isRepo(repoRoot)) {
    lines.push(
      'This directory is not a git repository, so the gates that read git — plan/commit synchronisation, '
      + 'the turn scan of the working tree, and branch protection — cannot run.',
    );
  } else {
    const branch = currentBranch(repoRoot);
    if (branch) lines.push(`Branch: ${branch}.`);
  }

  if (errors.length) {
    lines.push(
      `The repository policy file has problems and built-in defaults are being used instead: ${errors.join('; ')}. `
      + 'Run /ai-native-sdlc:sdlc-doctor.',
    );
  }

  if (level === 'advisory') {
    lines.push(
      'At advisory level the level-dependent gates report instead of blocking. The always-hard set still blocks. '
      + `Every decision is recorded either way, so /ai-native-sdlc:sdlc-status can show what would have been blocked.`,
    );
  }

  return emitContext(EVENT, lines.join(' '));
}

main().catch(() => emitAllow());
