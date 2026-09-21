/**
 * Git helpers.
 *
 * Every call uses spawnSync with an argv array and `shell: false`: passing a
 * path through a shell is where quoting bugs and injection live, and on Windows
 * the plugin cache path routinely contains spaces.
 *
 * All helpers degrade to a null/empty result instead of throwing. A repository
 * without git is a supported state — the rules that need git report themselves
 * inert and `/sdlc-doctor` says so, rather than a Class A rule failing closed
 * and blocking every edit.
 */

import { spawnSync } from 'node:child_process';

const TIMEOUT = 5000;

function git(args, cwd) {
  try {
    const r = spawnSync('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      timeout: TIMEOUT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) return { ok: false, stdout: '', stderr: r.stderr ?? '' };
    return { ok: true, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

export function isRepo(cwd) {
  return git(['rev-parse', '--is-inside-work-tree'], cwd).stdout.trim() === 'true';
}

/**
 * Repository identity that is stable across worktrees.
 *
 * `--git-common-dir` resolves to the same directory for every worktree of one
 * repository, so a fix-mode lock survives the engineer switching worktrees —
 * which is exactly the parallel-session topology the playbook encourages.
 */
export function repoKey(cwd) {
  const r = git(['rev-parse', '--git-common-dir'], cwd);
  const raw = r.ok ? r.stdout.trim() : '';
  // Always canonicalise. The same directory reaches this function spelled with
  // either separator depending on the caller, and the key is hashed into a
  // state file name — two spellings would mean two state files for one session,
  // silently losing the fix-mode lock. (This was a real bug, caught by a test.)
  return canonical(raw || cwd);
}

/** Forward slashes, no trailing slash, case-folded on Windows. */
function canonical(p) {
  let s = String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function currentBranch(cwd) {
  const r = git(['symbolic-ref', '--short', 'HEAD'], cwd);
  if (r.ok) return r.stdout.trim();
  const d = git(['rev-parse', '--short', 'HEAD'], cwd);
  return d.ok ? `detached@${d.stdout.trim()}` : null;
}

/** The remote default branch, e.g. "main". Null when there is no remote HEAD. */
export function defaultBranch(cwd) {
  const r = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (!r.ok) return null;
  const v = r.stdout.trim();
  return v.includes('/') ? v.split('/').slice(1).join('/') : v || null;
}

/**
 * Changed paths in the working tree, repo-relative with forward slashes.
 * `--porcelain` is used rather than a full diff: it is cheap enough to run at
 * every turn end, which is what the per-turn compliance scan needs.
 */
export function statusPaths(cwd) {
  const r = git(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    // Rename entries read "old -> new"; the new path is what exists now.
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = p.replace(/^"(.*)"$/, '$1');
    out.push(p.replace(/\\/g, '/'));
  }
  return [...new Set(out)];
}

/** Paths staged for the next commit. */
export function stagedPaths(cwd) {
  const r = git(['diff', '--cached', '--name-only'], cwd);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
}

/** Tracked paths modified but not staged. `git commit -a` would include these. */
export function unstagedPaths(cwd) {
  const r = git(['diff', '--name-only'], cwd);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
}

/** Content hash git would record for a path, without writing anything. */
export function hashObject(cwd, relPath) {
  const r = git(['hash-object', '--', relPath], cwd);
  return r.ok ? r.stdout.trim() : null;
}

/** Configured remote names and URLs, for spotting a push to an unknown host. */
export function remotes(cwd) {
  const r = git(['remote', '-v'], cwd);
  if (!r.ok) return [];
  const out = new Map();
  for (const line of r.stdout.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (name && url) out.set(name, url);
  }
  return [...out.entries()].map(([name, url]) => ({ name, url }));
}

export const _git = git;
