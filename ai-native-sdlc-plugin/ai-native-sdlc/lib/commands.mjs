/**
 * Shell command parsing for the Bash/PowerShell gates.
 *
 * Why this exists rather than a regex over the whole command string: a gate that
 * matches `git push` anywhere in the text is fooled by `echo "git push"`, and a
 * gate that only looks at the first word misses `npm run build && git push
 * origin main`. Splitting into subcommands first makes both cases behave.
 *
 * Both shells are handled in one place because on Windows without Git Bash the
 * Bash tool is not registered at all and shell calls arrive as `PowerShell`, so
 * every shell gate matches `Bash|PowerShell` and meets either syntax here.
 *
 * This is deliberately a *recogniser*, not a shell. It cannot see through
 * base64, `eval`, or a script file — the block messages say so, and the
 * enforcement matrix records it as defence in depth rather than a boundary.
 */

/** PowerShell verbs/aliases mapped to the POSIX behaviour a rule cares about. */
const PS_ALIASES = new Map([
  ['remove-item', 'rm'], ['ri', 'rm'], ['del', 'rm'], ['erase', 'rm'], ['rd', 'rm'],
  ['get-content', 'cat'], ['gc', 'cat'], ['type', 'cat'],
  ['set-content', 'write-file'], ['sc', 'write-file'], ['out-file', 'write-file'], ['add-content', 'write-file'], ['ac', 'write-file'],
  ['copy-item', 'cp'], ['ci', 'cp'], ['copy', 'cp'],
  ['move-item', 'mv'], ['mi', 'mv'], ['move', 'mv'],
  ['invoke-webrequest', 'curl'], ['iwr', 'curl'], ['wget', 'curl'],
  ['invoke-restmethod', 'curl'], ['irm', 'curl'],
  ['select-string', 'grep'], ['sls', 'grep'],
  ['get-childitem', 'ls'], ['gci', 'ls'], ['dir', 'ls'],
  ['invoke-expression', 'eval'], ['iex', 'eval'],
]);

/**
 * Split a command line into subcommands on `;`, `&&`, `||`, `|` and newlines,
 * respecting single/double quotes so a separator inside a string is not a split.
 */
export function splitSubcommands(command) {
  if (typeof command !== 'string') return [];
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];

    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }

    if (c === '&' && next === '&') { parts.push(cur); cur = ''; i++; continue; }
    if (c === '|' && next === '|') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { parts.push(cur); cur = ''; continue; }

    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Tokenise one subcommand, honouring quotes and stripping them from the token. */
export function tokenise(sub) {
  if (typeof sub !== 'string') return [];
  const tokens = [];
  let cur = '';
  let quote = null;
  let had = false;
  for (let i = 0; i < sub.length; i++) {
    const c = sub[i];
    if (quote) {
      if (c === quote && sub[i - 1] !== '\\') { quote = null; continue; }
      cur += c; had = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; had = true; continue; }
    if (/\s/.test(c)) {
      if (cur || had) { tokens.push(cur); cur = ''; had = false; }
      continue;
    }
    cur += c;
  }
  if (cur || had) tokens.push(cur);
  return tokens;
}

/**
 * Parse one subcommand into the shape rules ask questions of.
 * Leading `VAR=value` assignments are stripped, matching how the documented
 * `if` filter treats them, so `FOO=1 git push` is still a `git push`.
 */
export function parseSubcommand(sub) {
  const rawTokens = tokenise(sub);
  let i = 0;
  const env = [];
  while (i < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[i])) {
    env.push(rawTokens[i]); i++;
  }
  // `sudo`/`command`/`env` prefixes should not hide the real verb.
  while (i < rawTokens.length && ['sudo', 'command', 'env', 'nohup', 'time'].includes(rawTokens[i].toLowerCase())) {
    i++;
    while (i < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[i])) i++;
  }

  const tokens = rawTokens.slice(i);
  const rawVerb = (tokens[0] ?? '').toLowerCase();
  // Strip a path prefix so /usr/bin/git and git are the same verb.
  const bare = rawVerb.replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const verb = PS_ALIASES.get(bare) ?? bare;

  const args = tokens.slice(1);
  const flags = args.filter((a) => a.startsWith('-'));
  const operands = args.filter((a) => !a.startsWith('-'));

  return {
    raw: sub,
    env,
    verb,
    rawVerb: bare,
    // `git push` / `gh pr merge`: the words that qualify the verb.
    sub1: (operands[0] ?? '').toLowerCase(),
    sub2: (operands[1] ?? '').toLowerCase(),
    tokens,
    args,
    flags,
    operands,
    /** True when any flag matches, comparing case-insensitively. */
    hasFlag(...names) {
      const set = new Set(names.map((n) => n.toLowerCase()));
      return this.flags.some((f) => set.has(f.toLowerCase()) || set.has(f.split('=')[0].toLowerCase()));
    },
    /** True when the text of the whole subcommand matches a pattern. */
    matches(re) { return re.test(this.raw); },
  };
}

/** Parse a full command line into its subcommands. */
export function parseCommand(command) {
  return splitSubcommands(command).map(parseSubcommand);
}

/** Shell constructs that write to a file without naming a write verb. */
const REDIRECT = /(^|[^0-9>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&]+)/;

/**
 * Paths a subcommand appears to write to, from redirection or a write verb.
 * Used by the shell-shadow gate so the file guards cannot be stepped around by
 * `sed -i` or `echo … > file` — the coverage hole the course warns about.
 */
export function writeTargets(parsed) {
  const out = [];

  const m = REDIRECT.exec(parsed.raw);
  if (m) out.push(m[2].replace(/^["']|["']$/g, ''));

  const verb = parsed.verb;
  if (verb === 'write-file' || verb === 'tee') {
    out.push(...parsed.operands);
  } else if (verb === 'sed' && parsed.hasFlag('-i') || (verb === 'sed' && parsed.flags.some((f) => f.startsWith('-i')))) {
    out.push(...parsed.operands.slice(1));
  } else if (verb === 'perl' && parsed.flags.some((f) => /^-.*i/.test(f) && /p/.test(f))) {
    out.push(...parsed.operands);
  } else if (verb === 'rm' || verb === 'mv' || verb === 'cp') {
    out.push(...parsed.operands);
  } else if (verb === 'truncate') {
    out.push(...parsed.operands);
  } else if (verb === 'git' && parsed.sub1 === 'checkout' && parsed.args.includes('--')) {
    out.push(...parsed.args.slice(parsed.args.indexOf('--') + 1));
  } else if (verb === 'git' && (parsed.sub1 === 'restore' || parsed.sub1 === 'rm')) {
    out.push(...parsed.operands.slice(1));
  }

  return [...new Set(out.filter((p) => p && !p.startsWith('-')))];
}

/** Read verbs whose operands are file paths, for the shell secret-read gate. */
const READ_VERBS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'source', '.', 'od', 'xxd', 'strings', 'base64']);

export function readTargets(parsed) {
  if (!READ_VERBS.has(parsed.verb)) return [];
  return parsed.operands.filter((p) => p && !p.startsWith('-'));
}

/** URLs/hosts a subcommand would reach, for the egress gate. */
export function egressTargets(parsed) {
  if (parsed.verb !== 'curl') {
    // Still catch a bare URL passed to another network tool.
    const m = parsed.raw.match(/https?:\/\/[^\s"'`;|&)]+/g);
    return m ?? [];
  }
  const urls = parsed.raw.match(/https?:\/\/[^\s"'`;|&)]+/g) ?? [];
  return urls;
}

/** Hostname from a URL, or null. */
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export const powershellAliases = PS_ALIASES;
