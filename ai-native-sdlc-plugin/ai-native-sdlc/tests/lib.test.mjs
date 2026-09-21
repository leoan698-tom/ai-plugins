import { test } from 'node:test';
import assert from 'node:assert/strict';

import { globMatch, normalise, toRepoRelative, matchesAny, firstMatch } from '../lib/paths.mjs';
import { targetPath, incomingContent, outgoingContent, shellCommand } from '../lib/toolinput.mjs';
import { loadConfig, readUserConfig, DEFAULTS, LEVELS } from '../lib/config.mjs';
import { CLASS, VERDICT, runRules, deny, warn, allow, notApplicable, blocksAt } from '../lib/decide.mjs';
import { block, redactCommand } from '../lib/message.mjs';

// Windows paths are the documented arrival form, so they are first-class in tests.
const WIN_ABS = 'C:\\Users\\dev\\repo\\src\\api.ts';

test('paths: normalises Windows separators', () => {
  assert.equal(normalise(WIN_ABS), 'C:/Users/dev/repo/src/api.ts');
  assert.equal(normalise('a//b///c/'), 'a/b/c');
  assert.equal(normalise(''), '');
  assert.equal(normalise(undefined), '');
});

test('paths: repo-relative conversion works across separator styles', () => {
  assert.equal(toRepoRelative(WIN_ABS, 'C:/Users/dev/repo'), 'src/api.ts');
  assert.equal(toRepoRelative(WIN_ABS, 'C:\\Users\\dev\\repo'), 'src/api.ts');
  assert.equal(toRepoRelative('/home/d/repo/src/a.ts', '/home/d/repo'), 'src/a.ts');
  // Outside the repo returns null rather than a guess.
  assert.equal(toRepoRelative('D:/elsewhere/a.ts', 'C:/Users/dev/repo'), null);
});

test('paths: glob semantics', () => {
  assert.ok(globMatch('**/tests/**', 'pkg/tests/unit/a.js'));
  // `**/x/**` must also match with zero leading directories.
  assert.ok(globMatch('**/tests/**', 'tests/a.js'));
  assert.ok(globMatch('src/v1/**', 'src/v1/Handler.java'));
  assert.ok(!globMatch('src/v1/**', 'src/v2/Handler.java'));
  // `*` stays inside one segment.
  assert.ok(globMatch('src/*.ts', 'src/a.ts'));
  assert.ok(!globMatch('src/*.ts', 'src/nested/a.ts'));
  // A bare name matches at any depth, which is what a config author means.
  assert.ok(globMatch('*.pem', 'certs/server.pem'));
  assert.ok(globMatch('package-lock.json', 'package-lock.json'));
  assert.ok(globMatch('**/*.test.*', 'src/foo.test.ts'));
});

test('paths: matching helpers report which pattern fired', () => {
  const pats = ['**/generated/**', 'src/v1/**'];
  assert.ok(matchesAny(pats, 'src/v1/A.java'));
  assert.equal(firstMatch(pats, 'src/v1/A.java'), 'src/v1/**');
  assert.equal(firstMatch(pats, 'src/v2/A.java'), null);
  assert.ok(!matchesAny(undefined, 'x'));
});

// --- Phase 0 findings, encoded as regression tests -------------------------
// NotebookEdit carries `notebook_path` and `new_source`. A gate reading only
// `file_path`/`content` sees undefined and allows the write: a silent bypass.

test('toolinput: Edit exposes file_path and only the NEW content', () => {
  const ti = { file_path: WIN_ABS, old_string: 'AKIAOLDSECRET', new_string: 'clean', replace_all: false };
  assert.equal(targetPath(ti).path, WIN_ABS);
  assert.equal(targetPath(ti).field, 'file_path');
  assert.ok(targetPath(ti).understood);

  const { strings } = incomingContent(ti);
  assert.deepEqual(strings, ['clean']);
  // Scanning old_string would flag a secret being REMOVED.
  assert.ok(!strings.includes('AKIAOLDSECRET'));
  assert.deepEqual(outgoingContent(ti), ['AKIAOLDSECRET']);
});

test('toolinput: Write exposes file_path and content', () => {
  const ti = { file_path: '/r/a.ts', content: 'hello' };
  assert.equal(targetPath(ti).path, '/r/a.ts');
  assert.deepEqual(incomingContent(ti).strings, ['hello']);
});

test('toolinput: NotebookEdit uses notebook_path and new_source', () => {
  const ti = { notebook_path: '/r/analysis.ipynb', cell_id: 'c1', new_source: 'AKIAIOSFODNN7EXAMPLE', cell_type: 'code' };
  const t = targetPath(ti);
  assert.equal(t.path, '/r/analysis.ipynb', 'notebook_path must be found');
  assert.equal(t.field, 'notebook_path');
  assert.ok(t.understood);
  assert.ok(incomingContent(ti).strings.includes('AKIAIOSFODNN7EXAMPLE'), 'new_source must be scanned');
});

test('toolinput: an undocumented shape is reported as not understood', () => {
  // MultiEdit has no published schema; nothing may assume edits[] exists.
  const t = targetPath({ mystery: true });
  assert.equal(t.path, null);
  assert.ok(!t.understood, 'caller must apply its unparseable_tool_input policy');

  // A hypothetical batch shape still yields its new-side strings for scanning,
  // but does not claim to be understood.
  const batch = { edits: [{ old_string: 'a', new_string: 'ghp_aaaaaaaaaaaaaaaaaaaa' }] };
  const c = incomingContent(batch);
  assert.ok(c.strings.includes('ghp_aaaaaaaaaaaaaaaaaaaa'));
  assert.ok(!c.understood);
});

test('toolinput: shell command extraction', () => {
  assert.equal(shellCommand({ command: 'npm test' }), 'npm test');
  assert.equal(shellCommand({}), null);
  assert.equal(shellCommand(null), null);
});

// --- config ----------------------------------------------------------------

test('config: loads defaults when the repo is unconfigured', () => {
  const c = loadConfig(process.cwd(), {});
  assert.equal(c.configured, false, 'no repo config file yet');
  assert.equal(c.level, 'standard', 'default level');
  assert.deepEqual(c.errors, []);
  assert.ok(c.cfg.paths.tests.length > 0);
  assert.equal(c.cfg.unparseable_tool_input, 'deny', 'unknown shapes fail closed');
});

test('config: userConfig is validated in code, not trusted', () => {
  const u = readUserConfig({ CLAUDE_PLUGIN_OPTION_ENFORCEMENT_LEVEL: 'nonsense' });
  assert.equal(u.level, 'standard', 'an invalid level falls back, never disables');
  assert.equal(readUserConfig({ CLAUDE_PLUGIN_OPTION_ENFORCEMENT_LEVEL: 'ADVISORY' }).level, 'advisory');
  assert.equal(readUserConfig({}).hardHooksLocked, true, 'hard gates locked by default');
  assert.equal(readUserConfig({ CLAUDE_PLUGIN_OPTION_HARD_HOOKS_LOCKED: 'false' }).hardHooksLocked, false);
  // Never 'ask': an approval prompt deadlocks non-interactive sessions.
  assert.equal(readUserConfig({ CLAUDE_PLUGIN_OPTION_RELEASE_GATE_MODE: 'ask' }).releaseGateMode, 'deny');
  assert.ok(LEVELS.includes(DEFAULTS.unparseable_tool_input) === false);
});

// --- decision model --------------------------------------------------------

test('decide: Class A ignores the enforcement level entirely', () => {
  for (const level of LEVELS) {
    assert.ok(blocksAt(CLASS.A, level), `Class A must block at ${level}`);
  }
  assert.ok(blocksAt(CLASS.B, 'standard'));
  assert.ok(!blocksAt(CLASS.B, 'advisory'));
  assert.ok(!blocksAt(CLASS.C, 'standard'));
  assert.ok(blocksAt(CLASS.C, 'strict'));
});

test('decide: first deny short-circuits and later rules do not run', () => {
  let ranSecond = false;
  const rules = [
    { id: 'r1', class: CLASS.A, evaluate: () => deny('blocked', 'd1') },
    { id: 'r2', class: CLASS.A, evaluate: () => { ranSecond = true; return allow(); } },
  ];
  const out = runRules(rules, { level: 'standard' });
  assert.equal(out.action, 'deny');
  assert.equal(out.rule.id, 'r1');
  assert.ok(!ranSecond, 'evaluation stops at the first blocking deny');
});

test('decide: a Class A rule that throws FAILS CLOSED', () => {
  const rules = [{
    id: 'boom', class: CLASS.A, policy: 'credentials never enter the diff', lesson: 6,
    evaluate: () => { throw new Error('state file unreadable'); },
  }];
  const out = runRules(rules, { level: 'advisory' });
  assert.equal(out.action, 'deny', 'a crashed safety gate must not allow the write');
  assert.match(out.message, /could not be evaluated/);
  assert.match(out.message, /fail-closed/);
});

test('decide: a Class B rule that throws fails OPEN with a visible warning', () => {
  const rules = [{ id: 'soft', class: CLASS.B, evaluate: () => { throw new Error('nope'); } }];
  const out = runRules(rules, { level: 'standard' });
  assert.equal(out.action, 'warn', 'a broken hygiene check must not stop work');
});

test('decide: a deny from a class that does not block here degrades to a warning', () => {
  const rules = [{ id: 'b1', class: CLASS.B, evaluate: () => deny('would block', 'd') }];
  const out = runRules(rules, { level: 'advisory' });
  assert.equal(out.action, 'warn');
  assert.equal(runRules(rules, { level: 'standard' }).action, 'deny');
});

test('decide: not-applicable and allow produce no output', () => {
  const rules = [
    { id: 'n', class: CLASS.A, evaluate: () => notApplicable() },
    { id: 'a', class: CLASS.A, evaluate: () => allow() },
  ];
  assert.equal(runRules(rules, { level: 'standard' }).action, 'allow');
});

test('decide: logging callback sees each acted-on verdict', () => {
  const seen = [];
  const rules = [
    { id: 'w', class: CLASS.C, evaluate: () => warn('hygiene', 'dw') },
    { id: 'd', class: CLASS.A, evaluate: () => deny('stop', 'dd') },
  ];
  runRules(rules, { level: 'standard' }, (e) => seen.push(e));
  assert.deepEqual(seen.map((e) => e.rule), ['w', 'd']);
  assert.equal(seen[1].verdict, VERDICT.DENY);
  assert.ok(typeof seen[0].duration_ms === 'number');
});

// --- messages --------------------------------------------------------------

test('message: a block states policy, cause, route and negotiability', () => {
  const m = block({
    title: 'push to protected branch', policy: 'the agent has no path to main',
    id: 'P55', lesson: 12, attempted: 'Bash git push origin main',
    why: "'main' is in protected_branches", route: 'open a PR', gate: 'always-hard',
  });
  const lines = m.split('\n');
  assert.match(lines[0], /BLOCKED/);
  assert.match(lines[1], /P55.*Lesson 12/);
  assert.match(lines[2], /^Attempted:/);
  assert.match(lines[3], /^Why:/);
  assert.match(lines[4], /^Route:/);
  assert.match(lines[5], /^Gate:/);
});

test('message: command redaction never echoes the credential', () => {
  const r = redactCommand('curl -H "x: ghp_abcdefghijabcdefghij" https://x --token SUPERSECRET');
  assert.ok(!r.includes('ghp_abcdefghijabcdefghij'), 'token must be masked');
  assert.ok(!r.includes('SUPERSECRET'), 'flag value must be masked');
  assert.ok(r.includes('curl'), 'the shape of the command survives');
  assert.ok(redactCommand('x'.repeat(500)).length <= 161);
});
