/**
 * PostToolUse dispatcher for Bash | PowerShell.
 *
 * Two jobs, neither of which can block (the tool has already run):
 *
 * 1. **Record verification evidence.** When the command was one of the repo's
 *    configured verify commands, judge its output and store the verdict with a
 *    content fingerprint of the tree. The Stop gate consumes this.
 *
 * 2. **Advance the fix state machine.** Committing the reproduction test is what
 *    locks the test files. Before locking, this checks that the test was
 *    actually seen to FAIL — the course requires confirming it fails for the
 *    expected reason, and without that check an agent can write a vacuous
 *    passing test, commit it, and satisfy the entire loop.
 */

import { readPayload, emitAllow, emit } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';
import { shellCommand } from '../lib/toolinput.mjs';
import { parseCommand } from '../lib/commands.mjs';
import { matchVerifyCommand, judgeOutput, treeFingerprint } from '../lib/verify.mjs';
import * as state from '../lib/state.mjs';
import { repoKey as gitRepoKey, _git } from '../lib/git.mjs';
import { matchesAny } from '../lib/paths.mjs';
import { record } from '../lib/log.mjs';

const EVENT = 'PostToolUse';

async function main() {
  const payload = await readPayload();
  if (!payload) return emitAllow();

  const command = shellCommand(payload.tool_input ?? {});
  if (!command) return emitAllow();

  const cwd = payload.cwd || process.cwd();
  const { repoRoot, cfg, level } = loadConfig(cwd);
  const repoKey = gitRepoKey(repoRoot);
  const response = payload.tool_response ?? {};

  const notes = [];

  // --- 1. verification evidence ------------------------------------------
  const verifyCmd = matchVerifyCommand(cfg, command);
  if (verifyCmd) {
    const verdict = judgeOutput(verifyCmd, {
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      interrupted: Boolean(response.interrupted),
    });
    const { fingerprint } = treeFingerprint(repoRoot, cfg);

    state.update(payload.session_id, repoKey, (s) => {
      if (verdict === 'pass') {
        s.last_verified = { kind: verifyCmd.kind, verdict: 'pass', at: new Date().toISOString(), fingerprint };
      } else if (verdict === 'fail') {
        s.last_verified = { kind: verifyCmd.kind, verdict: 'fail', at: new Date().toISOString(), fingerprint };
        // A red run during the reproduce phase is the evidence the fix loop needs.
        if (s.fix?.phase === state.FIX_PHASE.REPRO) {
          s.fix.red_at = new Date().toISOString();
        }
      }
      return s;
    });

    record({
      hook: 'post-bash', event: EVENT, tool: payload.tool_name, level,
      rule: 'h21-verification-recorder', cls: 'B', decision: verdict,
      session: payload.session_id, repoKey, command, detail: `${verifyCmd.kind}:${verdict}`,
    });

    if (verdict === 'fail') {
      notes.push(
        `The ${verifyCmd.kind} command did not pass. Playbook Lesson 8: fix the code, not the test — `
        + 'a failing check is the signal the loop exists to produce.',
      );
    } else if (verdict === 'unknown') {
      notes.push(
        `The ${verifyCmd.kind} command ran but this repository has no healthy-output pattern configured, `
        + 'so the result is not usable as evidence. Lesson 8 step 2 calls for an example of healthy output '
        + '(it is what distinguishes "passed" from "passed but skipped 40 cases"). '
        + 'Run /ai-native-sdlc:sdlc-init --reconfigure to capture one.',
      );
    }
  }

  // --- 2. fix state machine ----------------------------------------------
  const subs = parseCommand(command);
  const committed = subs.some((s) => s.verb === 'git' && s.sub1 === 'commit');
  if (committed) {
    const s0 = state.read(payload.session_id, repoKey);
    if (s0.fix?.phase === state.FIX_PHASE.REPRO && !s0._corrupt) {
      // `git diff --cached` is empty after the commit, so use the paths the
      // commit actually carried.
      const touched = committedPaths(repoRoot);
      const testFiles = touched.filter((p) => matchesAny(cfg.paths?.tests, p));

      if (testFiles.length > 0) {
        if (!s0.fix.red_at) {
          // The course requires confirming the test fails for the expected
          // reason before the fix begins. Locking on an unproven test would
          // make the whole loop satisfiable by a test that never fails.
          notes.push(
            'A test was committed while /ai-native-sdlc:fix was in its reproduce phase, but no failing run of '
            + 'the verify command was recorded for it. Playbook Lesson 8 step 4 asks for the test to be run and '
            + 'confirmed to fail for the expected reason before the fix. Run the test command, confirm it fails, '
            + 'then commit — the lock engages once a red run is on record.',
          );
          record({
            hook: 'post-bash', event: EVENT, tool: payload.tool_name, level,
            rule: 'h21-fix-lock', cls: 'B', decision: 'warn',
            session: payload.session_id, repoKey, command, detail: 'repro-without-red',
          });
        } else {
          const locked = {};
          for (const rel of testFiles) locked[rel] = state.fileHash(`${repoRoot}/${rel}`);
          state.update(payload.session_id, repoKey, (s) => {
            s.fix = {
              ...s.fix,
              phase: state.FIX_PHASE.LOCKED,
              locked,
              entered_at: new Date().toISOString(),
            };
            return s;
          });
          notes.push(
            `Fix mode is now locked: ${testFiles.join(', ')} ${testFiles.length === 1 ? 'is' : 'are'} read-only `
            + 'until the verify command passes. Change the code, not the test.',
          );
          record({
            hook: 'post-bash', event: EVENT, tool: payload.tool_name, level,
            rule: 'h21-fix-lock', cls: 'A', decision: 'lock', hard: true,
            session: payload.session_id, repoKey, command, detail: `locked:${testFiles.length}`,
          });
        }
      }
    }
  }

  if (notes.length === 0) return emitAllow();
  // PostToolUse cannot undo the tool; additionalContext is how it reaches Claude.
  return emit({
    hookSpecificOutput: { hookEventName: EVENT, additionalContext: notes.join('\n\n') },
  });
}

/** Paths in the most recent commit, repo-relative with forward slashes. */
function committedPaths(repoRoot) {
  const r = _git(['show', '--name-only', '--pretty=format:', 'HEAD'], repoRoot);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
}

main().catch(() => {
  // This hook only records and advises. A failure here must never surface as a
  // blocking error on a tool that already ran.
  emitAllow();
});
