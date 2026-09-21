/**
 * Stop gate — the turn cannot end with unverified or tampered work.
 *
 * One process does both Stop jobs, for the same reason the PreToolUse gates
 * share a dispatcher: two registered Stop hooks mean two Node spawns at every
 * turn end.
 *
 *   1. **Turn scan.** The documentation is explicit that Edit/Write matchers do
 *      not see a file changed through the shell, and names a per-turn
 *      working-tree scan as the coverage pattern. This inspects results rather
 *      than intentions, so it catches what a command recogniser missed.
 *
 *   2. **Verification gate.** Lesson 8 step 6: run the checks before reporting a
 *      task complete, and show the output. Evidence comes from the toolchain.
 *
 * Loop discipline, which matters more here than anywhere else in the plugin:
 *   - `stop_hook_active` is read FIRST and returns immediately when true
 *   - a self-imposed cap of 2 blocks per turn chain, well under the documented
 *     8-continuation ceiling, after which the same content is delivered as
 *     non-error feedback so the human is never trapped in a loop they cannot exit
 */

import { readPayload, emitAllow, emitStopBlock, emitStopContext } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';
import { treeFingerprint, configuredCommands, runCommand, evidenceIsCurrent, describeRecord } from '../lib/verify.mjs';
import * as state from '../lib/state.mjs';
import { repoKey as gitRepoKey } from '../lib/git.mjs';
import { matchesAny, firstMatch } from '../lib/paths.mjs';
import { scan, describe as describeFindings } from '../lib/secrets.mjs';
import { record } from '../lib/log.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EVENT = 'Stop';
const BLOCK_CAP = 2;                 // documented ceiling is 8; stay well inside it
const DEFAULT_VERIFY_TIMEOUT_MS = 180000;

async function main() {
  const payload = await readPayload();
  if (!payload) return emitAllow();

  // The documented guard against blocking on a condition that never resolves.
  if (payload.stop_hook_active) return emitAllow();

  const cwd = payload.cwd || process.cwd();
  const { repoRoot, cfg, level, configured } = loadConfig(cwd);
  const repoKey = gitRepoKey(repoRoot);
  const s = state.read(payload.session_id, repoKey);

  const { fingerprint, files, degraded } = treeFingerprint(repoRoot, cfg);

  const hard = [];   // reasons that block
  const soft = [];   // observations that only inform

  // --- 1. fix-mode integrity: locked tests must be byte-identical ---------
  if (s.fix?.phase === state.FIX_PHASE.LOCKED && s.fix.locked) {
    for (const [rel, expected] of Object.entries(s.fix.locked)) {
      const actual = state.fileHash(join(repoRoot, rel));
      if (expected && actual !== expected) {
        hard.push(
          `[ai-native-sdlc] BLOCKED — locked test modified\n`
          + `Policy: an agent fixing code must not be able to weaken the check on that code (Playbook P39, Lesson 8)\n`
          + `Why: ${rel} no longer matches the content committed when the fix lock engaged\n`
          + `Route: restore it with \`git checkout -- ${rel}\`, then continue changing the code\n`
          + `Gate: always-hard while locked`,
        );
      }
    }
  }

  // --- 2. turn scan of what actually changed ------------------------------
  if (configured) {
    const p = cfg.paths ?? {};
    const protectedGlobs = [
      ...(p.generated ?? []),
      ...(p.frozen ?? []).map((f) => (typeof f === 'string' ? f : f?.glob)).filter(Boolean),
      ...(p.lockfiles ?? []),
      '.claude/sdlc/**', '.claude/settings.json', '.claude/hooks/**',
    ];

    for (const rel of files.slice(0, 500)) {
      const hit = firstMatch(protectedGlobs, rel);
      if (hit && !s.maintenance) {
        hard.push(
          `[ai-native-sdlc] BLOCKED — protected path changed in the working tree\n`
          + `Policy: generated, frozen and configuration paths are not editable from a session (Playbook P20/P65, Lesson 6)\n`
          + `Why: ${rel} matches '${hit}' and was modified this turn, whatever tool made the change\n`
          + `Route: revert it with \`git checkout -- ${rel}\`, or open a PR against the protected file\n`
          + `Gate: always-hard`,
        );
        break; // one is enough to stop the turn
      }
    }

    // Credentials that arrived through a path no PreToolUse matcher covers.
    for (const rel of files.slice(0, 200)) {
      if (matchesAny(p.secret_scan_allow, rel)) continue;
      let text;
      try {
        const buf = readFileSync(join(repoRoot, rel));
        if (buf.length > 512 * 1024 || buf.includes(0)) continue; // skip large/binary
        text = buf.toString('utf8');
      } catch { continue; }
      const findings = scan(text);
      if (findings.length) {
        hard.push(
          `[ai-native-sdlc] BLOCKED — credential-like literal in the working tree\n`
          + `Policy: keep credentials out of the diff (Playbook P28, Lesson 6)\n`
          + `Why: ${rel} matched ${describeFindings(findings)} (value not shown)\n`
          + `Route: replace it with an environment variable or a secret-manager lookup before this turn ends; `
          + `for a fixture, add the path to paths.secret_scan_allow in the repo config via PR\n`
          + `Gate: always-hard`,
        );
        break;
      }
    }
  }

  // --- 3. verification gate ----------------------------------------------
  const commands = configuredCommands(cfg);
  const nonExempt = files.length > 0;

  if (configured && commands.length > 0 && nonExempt && hard.length === 0) {
    if (evidenceIsCurrent(s.last_verified, fingerprint)) {
      // Nothing has changed since the recorded green run; no need to re-run.
    } else if (degraded) {
      soft.push(
        `${files.length} files changed, which is above the fingerprinting limit, so verification evidence `
        + 'could not be matched to the tree. Run the verify commands and paste the output before reporting done.',
      );
    } else {
      // The hybrid: the tree moved, so re-run for a real exit code rather than
      // trusting output text that could record a false green.
      const timeout = Number(cfg.verify_timeout_ms) || DEFAULT_VERIFY_TIMEOUT_MS;
      const primary = commands.find((c) => c.kind === 'test') ?? commands[0];
      const result = runCommand(primary, repoRoot, timeout, cfg.command_shell);

      record({
        hook: 'stop', event: EVENT, level, rule: 'h23-verify-evidence-gate', cls: 'B',
        decision: result.status, session: payload.session_id, repoKey,
        duration_ms: result.ms, detail: `${primary.kind}:${result.status}`,
      });

      if (result.status === 'pass') {
        state.update(payload.session_id, repoKey, (st) => {
          st.last_verified = { kind: primary.kind, verdict: 'pass', at: new Date().toISOString(), fingerprint };
          return st;
        });
      } else if (result.status === 'fail') {
        hard.push(
          `[ai-native-sdlc] BLOCKED — task reported done but ${primary.kind} does not pass\n`
          + `Policy: run the checks before reporting a task complete, and show the output (Playbook P40, Lesson 8)\n`
          + `Why: \`${primary.cmd}\` was re-run because the working tree changed since the last recorded pass; `
          + `it exited ${result.code ?? 'non-zero'}\n`
          + `Route: fix the code — not the test — then run \`${primary.cmd}\` and include the literal output\n`
          + `Gate: level=${level}\n`
          + `Last output:\n${result.tail}`,
        );
      } else if (result.status === 'timeout') {
        // A slow suite must not deadlock the turn. Degrade loudly instead.
        soft.push(
          `\`${primary.cmd}\` did not finish within ${Math.round(timeout / 1000)}s, so this turn ends without `
          + 'toolchain evidence. Run it yourself and confirm before treating the task as done. '
          + '(Raise verify_timeout_ms in the repo config if the suite is legitimately this slow.)',
        );
      } else {
        soft.push(`\`${primary.cmd}\` could not be run (${result.tail}). Verification evidence is missing for this turn.`);
      }
    }
  } else if (configured && commands.length === 0 && nonExempt) {
    soft.push(
      'Files changed but this repository has no verify command configured, so nothing can prove the change works. '
      + 'Lesson 8: always give the session a way to check its own work. Run /ai-native-sdlc:sdlc-init --reconfigure.',
    );
  }

  // --- 4. deliver ---------------------------------------------------------
  if (hard.length > 0) {
    const blocks = (s.stop_blocks ?? 0) + 1;
    state.update(payload.session_id, repoKey, (st) => { st.stop_blocks = blocks; return st; });

    if (blocks > BLOCK_CAP) {
      // Past the self-imposed cap, say the same thing without blocking. The
      // human keeps control; the ledger records that the gate escalated.
      record({
        hook: 'stop', event: EVENT, level, rule: 'h24-turn-scanner', cls: 'A',
        decision: 'escalated', hard: true, session: payload.session_id, repoKey,
        detail: `block-cap-${BLOCK_CAP}`,
      });
      return emitStopContext(EVENT, [
        ...hard,
        `This gate has blocked ${BLOCK_CAP} times in this turn chain and is now reporting instead of blocking, `
        + 'so the session is not trapped. The finding above still stands and is recorded.',
      ].join('\n\n'));
    }

    record({
      hook: 'stop', event: EVENT, level, rule: 'h24-turn-scanner', cls: 'A',
      decision: 'block', hard: true, session: payload.session_id, repoKey,
      detail: `blocks:${blocks}`,
    });
    return emitStopBlock([...hard, ...soft].join('\n\n'));
  }

  // A clean turn resets the counter so the next one starts with a full budget.
  if (s.stop_blocks) {
    state.update(payload.session_id, repoKey, (st) => { st.stop_blocks = 0; return st; });
  }

  if (soft.length > 0) return emitStopContext(EVENT, soft.join('\n\n'));
  return emitAllow();
}

main().catch(() => {
  // A Stop hook that throws must not strand the turn. Unlike PreToolUse, there
  // is no pending action to protect here: the work is already on disk and the
  // CI re-check still covers it.
  emitAllow();
});
