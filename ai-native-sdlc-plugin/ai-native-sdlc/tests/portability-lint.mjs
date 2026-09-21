#!/usr/bin/env node
/**
 * Portability lint — fails the build on the mistakes that make a plugin work on
 * one machine and silently stop working on another.
 *
 * Portability is regression-prone in a specific way: a contributor adds a bash
 * one-liner "just for this check", a matcher loses its `|PowerShell`, a path
 * picks up a backslash and the component then loads only on Windows. None of
 * that fails visibly — the gate simply never fires, which is the worst failure
 * mode a policy layer has.
 *
 * Run: node tests/portability-lint.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const problems = [];
const fail = (file, msg) => problems.push({ file, msg });

/** Values from the course's worked examples that must never reach the plugin. */
const ORG_TOKENS = [
  'make build', 'make itest', 'Payments service', 'example-corp',
  'git.internal.example.com', 'claims-core', 'StatusPanel', 'src/itest',
  'Spring Boot', 'Lombok',
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'fixtures'].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// --- hooks.json: the contract that decides whether a gate runs at all -------
{
  const p = join(ROOT, 'hooks', 'hooks.json');
  const raw = readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw);

  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    for (const group of groups) {
      // A shell-command gate that matches only Bash never fires on a Windows
      // machine without Git Bash, where the Bash tool is not registered at all.
      if (group.matcher && /\bBash\b/.test(group.matcher) && !/PowerShell/.test(group.matcher)) {
        fail('hooks/hooks.json', `${event} matcher "${group.matcher}" covers Bash but not PowerShell`);
      }
      for (const h of group.hooks ?? []) {
        if (h.type !== 'command') continue;
        // Exec form only: with `args` present there is no shell on any platform,
        // which removes quoting, profile-echo and .cmd-shim hazards at a stroke.
        if (!Array.isArray(h.args)) {
          fail('hooks/hooks.json', `${event} hook "${h.command}" is shell form; use exec form with args`);
        }
        if (h.command !== 'node') {
          fail('hooks/hooks.json', `${event} hook runs "${h.command}"; every enforcement hook must run node`);
        }
        for (const a of h.args ?? []) {
          if (!String(a).includes('${CLAUDE_PLUGIN_ROOT}') && String(a).includes('/')) {
            fail('hooks/hooks.json', `${event} arg "${a}" is a path without \${CLAUDE_PLUGIN_ROOT}`);
          }
          if (String(a).includes('\\')) {
            fail('hooks/hooks.json', `${event} arg "${a}" contains a backslash; component paths must use forward slashes`);
          }
          if (/\$\{user_config\./.test(String(a))) {
            fail('hooks/hooks.json', `${event} arg "${a}" uses \${user_config.*}, which is rejected in shell-run fields; read CLAUDE_PLUGIN_OPTION_* instead`);
          }
        }
        if (typeof h.timeout === 'number' && h.timeout > 600) {
          fail('hooks/hooks.json', `${event} timeout ${h.timeout}s exceeds the documented command default of 600s`);
        }
      }
    }
  }

  // SessionStart must include `fork`, or a forked session initialises no state
  // and the test lock silently reads as off inside the fork.
  const ss = (cfg.hooks?.SessionStart ?? [])[0];
  if (ss && ss.matcher && !/\bfork\b/.test(ss.matcher)) {
    fail('hooks/hooks.json', 'SessionStart matcher omits "fork"; a forked session would start with default state');
  }
}

// --- source files -----------------------------------------------------------
for (const p of files) {
  const r = rel(p);
  if (!/\.(mjs|json|md|sh|ps1)$/.test(p)) continue;
  const raw = readFileSync(p);
  const text = raw.toString('utf8');

  if (raw.includes(Buffer.from('\r\n'))) {
    fail(r, 'contains CRLF line endings; .gitattributes pins LF so a Windows checkout cannot corrupt a script');
  }

  if (/\.mjs$/.test(p)) {
    // An absolute path baked into a script cannot survive being installed
    // anywhere else — which is the whole point of a distributable plugin.
    // Tests are exempt: they construct absolute paths deliberately, because
    // that is the documented arrival form for file tools.
    if (!/^tests\//.test(r)) {
      const abs = text.match(/["'`](?:[A-Za-z]:[\\/]|\/(?:home|Users|opt|usr)\/)[^"'`\n]{4,}["'`]/g);
      if (abs) fail(r, `hardcoded absolute path: ${abs[0].slice(0, 60)}`);
    }

    // State written next to the code is lost on the next plugin update: the
    // install directory is version-scoped and documented as ephemeral.
    if (/CLAUDE_PLUGIN_ROOT/.test(text) && /(writeFileSync|appendFileSync|mkdirSync)/.test(text)) {
      const suspicious = /(?:writeFileSync|appendFileSync|mkdirSync)\([^)]*CLAUDE_PLUGIN_ROOT/.test(text);
      if (suspicious) fail(r, 'writes under CLAUDE_PLUGIN_ROOT; persistent state belongs in CLAUDE_PLUGIN_DATA');
    }

    // Anything on stdout other than the single decision object is read as plain
    // text, and the decision is then silently discarded.
    if (/\bconsole\.log\(/.test(text) && !/^(scripts|tests|bin)\//.test(r)) {
      fail(r, 'console.log in a hook path; stdout must contain only the decision JSON');
    }
  }

  if (/^(lib|hooks|bin)\//.test(r)) {
    for (const token of ORG_TOKENS) {
      if (text.includes(token)) {
        fail(r, `contains the course example value "${token}"; repo-specific values come from config, not code`);
      }
    }
  }
}

// --- manifests --------------------------------------------------------------
{
  const pj = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const [key, opt] of Object.entries(pj.userConfig ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      fail('.claude-plugin/plugin.json', `userConfig key "${key}" is not snake_case; the documented env transform is uppercase only, so other spellings are unspecified`);
    }
    if (opt.multiple) {
      fail('.claude-plugin/plugin.json', `userConfig key "${key}" uses multiple:true; array serialisation into CLAUDE_PLUGIN_OPTION_* is undocumented — use a comma-separated string`);
    }
  }
}

// --- report -----------------------------------------------------------------
if (problems.length === 0) {
  process.stdout.write('portability-lint: clean\n');
  process.exit(0);
}
for (const { file, msg } of problems) process.stdout.write(`PORTABILITY ${file}\n  ${msg}\n`);
process.stdout.write(`\nportability-lint: ${problems.length} problem(s)\n`);
process.exit(1);
