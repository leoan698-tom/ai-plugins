/**
 * Path normalisation and glob matching.
 *
 * Claude Code expands `~` and relative paths before a hook runs, so every path
 * arrives absolute and with NATIVE separators — backslashes on Windows, even
 * under Git Bash. Comparing those against forward-slash globs silently matches
 * nothing, which for a deny rule means the gate waves the edit through. Every
 * path entering a rule goes through `normalise()` first.
 */

import { sep } from 'node:path';

const WIN = process.platform === 'win32';

/** Forward slashes, no trailing slash, no duplicate separators. */
export function normalise(p) {
  if (typeof p !== 'string' || p === '') return '';
  let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Case-folded form used for comparison only. Windows paths are case-insensitive. */
export function comparable(p) {
  const n = normalise(p);
  return WIN ? n.toLowerCase() : n;
}

/**
 * Convert an absolute path to a repo-relative one ("src/api/status.ts").
 * Returns null when the path is outside the repo — callers treat that as
 * "not covered by repo-relative globs" rather than guessing.
 */
export function toRepoRelative(absPath, repoRoot) {
  const a = comparable(absPath);
  const r = comparable(repoRoot);
  if (!a || !r) return null;
  if (a === r) return '';
  if (!a.startsWith(r.endsWith('/') ? r : r + '/')) return null;
  // Slice from the ORIGINAL normalised path so the returned value keeps its case.
  const n = normalise(absPath);
  return n.slice(normalise(repoRoot).length + 1);
}

/**
 * Minimal glob matcher supporting `**`, `*` and `?`.
 *
 *   **  crosses directory separators
 *   *   matches within one segment
 *   ?   matches one character within a segment
 *
 * A pattern with no slash (e.g. "*.pem") also matches on basename at any depth,
 * which is what people mean when they write it in a config file.
 */
export function globMatch(pattern, path) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  const pat = comparable(pattern);
  const val = comparable(path);
  if (!pat) return false;

  if (globToRegExp(pat).test(val)) return true;

  // Bare-name convenience: "*.pem" should catch "certs/server.pem".
  if (!pat.includes('/')) {
    const base = val.slice(val.lastIndexOf('/') + 1);
    return globToRegExp(pat).test(base);
  }
  return false;
}

const cache = new Map();
function globToRegExp(pat) {
  const hit = cache.get(pat);
  if (hit) return hit;

  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        // `**/` should also match zero directories: "**/tests/**" hits "tests/a".
        if (pat[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp('^' + re + '$');
  cache.set(pat, compiled);
  return compiled;
}

/** True when `path` matches any pattern in `patterns`. Tolerates a non-array. */
export function matchesAny(patterns, path) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => globMatch(p, path));
}

/** The first matching pattern, or null. Used so a block message can cite the rule that fired. */
export function firstMatch(patterns, path) {
  if (!Array.isArray(patterns)) return null;
  return patterns.find((p) => globMatch(p, path)) ?? null;
}

export const isWindows = WIN;
export const nativeSep = sep;
