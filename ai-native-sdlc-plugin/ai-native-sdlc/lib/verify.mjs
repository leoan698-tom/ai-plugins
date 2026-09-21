/**
 * Verification evidence.
 *
 * Lesson 8: "evidence comes from the toolchain", not from the model saying it
 * ran the tests. Phase 0 confirmed the obstacle: the documented Bash
 * `tool_response` carries stdout, stderr and interrupted — **there is no exit
 * code**. A PostToolUse hook therefore cannot learn whether `npm test` passed;
 * it can only match the output text, and text matching can record a FALSE
 * GREEN, which is a silent bypass of the whole gate.
 *
 * Hence the hybrid the plan settled on:
 *
 *   record   — after a verify command runs, match its output and store a
 *              verdict together with a CONTENT fingerprint of the tree
 *   trust    — at Stop, if the tree still hashes to the recorded fingerprint,
 *              the recorded verdict still applies and nothing re-runs
 *   re-run   — if the tree has changed, run the command for real and read its
 *              exit code, which is the only fully deterministic signal available
 *
 * The fingerprint is a hash of file CONTENT, never mtime: the plugin's own
 * formatter hook rewrites files after an edit, which bumps mtime without
 * changing what was verified and would invalidate every green record.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { statusPaths } from './git.mjs';
import { matchesAny } from './paths.mjs';

/** Files larger than this are fingerprinted by size rather than content. */
const MAX_HASH_BYTES = 2 * 1024 * 1024;
/** Above this many changed files, fingerprint paths+sizes only and say so. */
const MAX_HASH_FILES = 200;

/**
 * Content fingerprint of the working tree's changed files.
 * @returns {{fingerprint: string, files: string[], degraded: boolean}}
 */
export function treeFingerprint(repoRoot, cfg) {
  const exempt = cfg?.paths?.verify_exempt ?? [];
  const changed = statusPaths(repoRoot).filter((p) => !matchesAny(exempt, p));
  const h = createHash('sha1');
  let degraded = changed.length > MAX_HASH_FILES;

  for (const rel of [...changed].sort()) {
    h.update(rel).update('\0');
    if (degraded) continue;
    const abs = join(repoRoot, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) { h.update('-\n'); continue; }
      if (st.size > MAX_HASH_BYTES) { h.update(`size:${st.size}\n`); continue; }
      h.update(createHash('sha1').update(readFileSync(abs)).digest('hex')).update('\n');
    } catch {
      // Deleted between listing and hashing: record the absence, not an error.
      h.update('missing\n');
    }
  }

  return { fingerprint: h.digest('hex'), files: changed, degraded };
}

/** The verify commands a repo has configured, in the order a human would run them. */
export function configuredCommands(cfg) {
  const out = [];
  for (const kind of ['build', 'test', 'lint']) {
    const c = cfg?.commands?.[kind];
    if (c?.cmd && String(c.cmd).trim()) out.push({ kind, ...c });
  }
  return out;
}

/** Does this shell command look like one of the configured verify commands? */
export function matchVerifyCommand(cfg, command) {
  if (!command) return null;
  const norm = String(command).replace(/\s+/g, ' ').trim().toLowerCase();
  for (const c of configuredCommands(cfg)) {
    const target = String(c.cmd).replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm === target || norm.includes(target)) return c;
  }
  return null;
}

/**
 * Judge a completed run from its output text alone.
 *
 * `healthy_regex` is captured during onboarding from a REAL passing run, which
 * is Lesson 8 step 2's "example of healthy output" — the thing that catches a
 * run that passed while skipping forty cases. Without it there is no positive
 * evidence, so the verdict is `unknown` and the caller must re-run rather than
 * assume green.
 *
 * @returns {'pass'|'fail'|'unknown'}
 */
export function judgeOutput(cmdCfg, { stdout = '', stderr = '', interrupted = false } = {}) {
  if (interrupted) return 'fail';
  const text = `${stdout}\n${stderr}`;

  if (cmdCfg?.failure_regex) {
    try { if (new RegExp(cmdCfg.failure_regex, 'i').test(text)) return 'fail'; } catch { /* bad regex: ignore */ }
  }
  if (cmdCfg?.healthy_regex) {
    try { return new RegExp(cmdCfg.healthy_regex, 'i').test(text) ? 'pass' : 'fail'; } catch { /* bad regex */ }
  }
  // No configured signal. Refusing to guess is the point: an inferred green is
  // exactly the false evidence this module exists to avoid.
  return 'unknown';
}

/**
 * Run a configured command for real and read its exit code.
 *
 * This is the one place a shell is used deliberately. The command comes from the
 * repository's own reviewed config (`npm test`, `make test`), not from tool
 * input, and on Windows `npm` is a .cmd shim that cannot be spawned without one.
 * Everywhere else the plugin uses exec form precisely to avoid a shell.
 *
 * @returns {{status: 'pass'|'fail'|'timeout'|'error', code: number|null, ms: number, tail: string}}
 */
export function runCommand(cmdCfg, repoRoot, timeoutMs, shellPref = 'auto') {
  const started = Date.now();
  const shell = pickShell(shellPref);
  try {
    const r = spawnSync(cmdCfg.cmd, {
      cwd: repoRoot,
      shell,
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: process.env.CI ?? '1' },
    });
    const ms = Date.now() - started;
    const tail = tailOf(`${r.stdout ?? ''}${r.stderr ?? ''}`);

    if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
      return { status: 'timeout', code: null, ms, tail };
    }
    if (r.error) return { status: 'error', code: null, ms, tail: String(r.error.message).slice(0, 400) };

    // The exit code is authoritative. The healthy pattern is still consulted so
    // a suite that exits 0 while skipping everything is not counted as evidence.
    if (r.status !== 0) return { status: 'fail', code: r.status, ms, tail };
    const judged = judgeOutput(cmdCfg, { stdout: r.stdout, stderr: r.stderr });
    return { status: judged === 'fail' ? 'fail' : 'pass', code: r.status, ms, tail };
  } catch (err) {
    return { status: 'error', code: null, ms: Date.now() - started, tail: String(err?.message).slice(0, 400) };
  }
}

function pickShell(pref) {
  const p = String(pref || 'auto').toLowerCase();
  if (p === 'bash') return 'bash';
  if (p === 'powershell') return process.platform === 'win32' ? 'powershell.exe' : true;
  if (p === 'cmd') return process.platform === 'win32' ? 'cmd.exe' : true;
  if (p === 'sh') return 'sh';
  return true; // platform default
}

function tailOf(text, lines = 20) {
  const arr = String(text).split('\n');
  return arr.slice(-lines).join('\n').slice(-2000);
}

/** Is the recorded verdict still valid for the tree as it stands now? */
export function evidenceIsCurrent(record, fingerprint) {
  return Boolean(record && record.verdict === 'pass' && record.fingerprint === fingerprint);
}

/** Human-readable age of a record, for status output and block messages. */
export function describeRecord(record) {
  if (!record) return 'no verification has been recorded this session';
  const when = record.at ? new Date(record.at).toISOString().replace('T', ' ').slice(0, 19) : 'unknown time';
  return `last ${record.kind ?? 'verify'} was ${record.verdict} at ${when}`;
}
