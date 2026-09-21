/**
 * Per-session state: fix-mode phase, locked test hashes, active change
 * directory, last verification record, maintenance flag.
 *
 * Location: ${CLAUDE_PLUGIN_DATA}, never ${CLAUDE_PLUGIN_ROOT}. The root path is
 * version-scoped and the documentation says to treat it as ephemeral — state
 * written there vanishes on the next plugin update. CLAUDE_PLUGIN_DATA survives.
 *
 * Writes are atomic (temp file + rename) because two hooks can run in parallel:
 * all matching hooks for an event fire concurrently, so a half-written state
 * file is a real possibility and an unreadable one makes Class A fail closed.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const FIX_PHASE = {
  OFF: 'off',
  /** Writing the reproduction test: test files writable, source blocked at strict. */
  REPRO: 'repro',
  /** Failing test committed: test files are read-only until the fix is green. */
  LOCKED: 'locked',
};

function dataDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA;
  if (base) return base;
  // A fallback keeps the plugin usable when the variable is absent, but the
  // caller is told so it can surface a degraded-mode warning.
  return join(process.env.TEMP || process.env.TMPDIR || '.', 'ai-native-sdlc-data');
}

export function hasPluginData() {
  return Boolean(process.env.CLAUDE_PLUGIN_DATA);
}

export function stateDir() {
  const d = join(dataDir(), 'state');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * State is keyed by session AND repository. A session that moves between
 * worktrees of the same repo keeps one fix lock (repo identity comes from
 * `git rev-parse --git-common-dir`, resolved by the caller), while two sessions
 * on the same repo stay independent.
 */
function stateFile(sessionId, repoKey) {
  const safe = String(sessionId || 'no-session').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  const rk = createHash('sha1').update(String(repoKey || '')).digest('hex').slice(0, 8);
  return join(stateDir(), `${safe}.${rk}.json`);
}

export const EMPTY = {
  version: 1,
  fix: { phase: FIX_PHASE.OFF, locked: {}, entered_at: null },
  change_dir: null,
  change_ticket: null,
  last_verified: null,   // { kind, at, fingerprint }
  maintenance: false,
  touched: [],
  stop_blocks: 0,
  plan_files: null,      // seeded by the plan gate before plan.md exists
};

export function read(sessionId, repoKey) {
  const f = stateFile(sessionId, repoKey);
  if (!existsSync(f)) return { ...EMPTY, _file: f };
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    return { ...EMPTY, ...parsed, _file: f };
  } catch {
    // A corrupt state file is not a reason to fail the session, but callers
    // must know: a Class A rule that needs state treats `_corrupt` as an error
    // and therefore fails closed.
    return { ...EMPTY, _file: f, _corrupt: true };
  }
}

export function write(sessionId, repoKey, state) {
  const f = stateFile(sessionId, repoKey);
  const tmp = `${f}.${process.pid}.tmp`;
  const { _file, _corrupt, ...clean } = state;
  writeFileSync(tmp, JSON.stringify(clean), 'utf8');
  renameSync(tmp, f);
  return f;
}

export function update(sessionId, repoKey, mutator) {
  const s = read(sessionId, repoKey);
  const next = mutator({ ...s }) ?? s;
  write(sessionId, repoKey, next);
  return next;
}

/** Remove state files older than `days`, so the data directory does not grow forever. */
export function prune(days = 30) {
  const dir = stateDir();
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
      } catch { /* a file vanishing mid-sweep is fine */ }
    }
  } catch { /* nothing to prune */ }
  return removed;
}

/** Stable content hash of a file, used instead of mtime. */
export function fileHash(path) {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Fingerprint of the working tree's *content*.
 *
 * Deliberately not mtime-based: the plugin's own formatter hook rewrites a file
 * after an edit, which bumps mtime without changing what was verified, and would
 * silently invalidate a green verification record on every turn.
 */
export function treeFingerprint(entries) {
  const h = createHash('sha1');
  for (const { path, hash } of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(path).update('\0').update(hash ?? '-').update('\n');
  }
  return h.digest('hex');
}
