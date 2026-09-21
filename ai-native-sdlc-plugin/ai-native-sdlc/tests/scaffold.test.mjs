/**
 * Scaffold semantics.
 *
 * The interesting behaviour is the upgrade path. Without a manifest, a second
 * plugin release either clobbers whatever the team edited or can never ship a
 * template fix — and in practice the second outcome means template fixes stop
 * shipping at all. These tests pin the three-way distinction that avoids it:
 * untouched files are safe to update, edited files are only ever proposed.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plan, apply, readManifest, detectStacks, detectProtectedPaths, innerLoopRules, mergeProjectSettings, PROFILES } from '../scripts/scaffold.mjs';

let repo;

before(() => { repo = mkdtempSync(join(tmpdir(), 'sdlc-scaffold-')); });
after(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

const file = (p) => join(repo, p);
const read = (p) => readFileSync(file(p), 'utf8');

test('scaffold: creates files and records their hashes', () => {
  const files = [
    { path: 'CLAUDE.md', content: '# Repo\n' },
    { path: 'REVIEW.md', content: '# Review\n' },
  ];
  const planned = plan(repo, files, '0.0.1');
  assert.deepEqual(planned.actions.map((a) => a.status), ['create', 'create']);

  const written = apply(repo, planned);
  assert.equal(written.length, 2);
  assert.equal(read('CLAUDE.md'), '# Repo\n');

  const m = readManifest(repo);
  assert.equal(m.plugin_version, '0.0.1');
  assert.ok(m.files['CLAUDE.md'].sha, 'a hash is recorded so a later version knows what it wrote');
});

test('scaffold: an identical file is left alone', () => {
  const planned = plan(repo, [{ path: 'CLAUDE.md', content: '# Repo\n' }], '0.0.1');
  assert.equal(planned.actions[0].status, 'same');
  assert.equal(apply(repo, planned).length, 0, 'nothing is rewritten');
});

test('scaffold: an untouched file is safe to update in place', () => {
  // The file still hashes to what the scaffold last wrote, so nobody has edited
  // it and a template improvement can land directly.
  const planned = plan(repo, [{ path: 'CLAUDE.md', content: '# Repo v2\n' }], '0.0.2');
  assert.equal(planned.actions[0].status, 'update');
  apply(repo, planned);
  assert.equal(read('CLAUDE.md'), '# Repo v2\n');
});

test('scaffold: a locally edited file is proposed, never overwritten', () => {
  writeFileSync(file('CLAUDE.md'), '# Repo v2\n\n## Our own section\nhand written\n', 'utf8');

  const planned = plan(repo, [{ path: 'CLAUDE.md', content: '# Repo v3\n' }], '0.0.3');
  assert.equal(planned.actions[0].status, 'modified');
  assert.equal(planned.actions[0].proposedPath, 'CLAUDE.md.sdlc-proposed');

  apply(repo, planned);
  assert.match(read('CLAUDE.md'), /hand written/, 'the team\'s edit survives');
  assert.equal(read('CLAUDE.md.sdlc-proposed'), '# Repo v3\n', 'the new version is offered beside it');

  // A proposal is not a managed file, so its hash must not be recorded —
  // otherwise the next run would think the team had accepted it.
  const m = readManifest(repo);
  assert.ok(!m.files['CLAUDE.md.sdlc-proposed'], 'a proposal is not tracked as owned');
});

test('scaffold: project settings are merged, never replaced', () => {
  mkdirSync(file('.claude'), { recursive: true });
  writeFileSync(file('.claude/settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(make deploy:*)'], deny: ['Read(./private/**)'] },
    env: { EXISTING: '1' },
  }), 'utf8');

  const merged = mergeProjectSettings(repo, innerLoopRules({ commands: { test: { cmd: 'npm test' } } }));
  const next = JSON.parse(merged.content);

  assert.ok(next.permissions.allow.includes('Bash(make deploy:*)'), 'existing rules survive');
  assert.ok(next.permissions.allow.some((r) => r.includes('npm test')), 'the verify command is pre-approved');
  assert.ok(next.permissions.deny.includes('Read(./private/**)'), 'existing deny rules survive');
  assert.ok(next.permissions.deny.some((r) => /\.env/.test(r)), 'secret reads are denied');
  assert.equal(next.env.EXISTING, '1', 'unrelated settings are untouched');
});

test('scaffold: the inner loop allowlist is derived from the answers, not hardcoded', () => {
  const rules = innerLoopRules({ commands: { test: { cmd: 'pytest -q' }, build: { cmd: 'make all' } } });
  assert.ok(rules.allow.some((r) => r.includes('pytest -q')));
  assert.ok(rules.allow.some((r) => r.includes('make all')));
  assert.ok(rules.allow.some((r) => r.includes('git status')));
  // Lesson 11: an unpaired deny list becomes prompt fatigue.
  assert.ok(rules.deny.length > 0);
});

test('scaffold: stack detection proposes rather than assumes', () => {
  const r = mkdtempSync(join(tmpdir(), 'sdlc-stack-'));
  writeFileSync(join(r, 'package.json'), '{}');
  writeFileSync(join(r, 'go.mod'), 'module x');
  const stacks = detectStacks(r);
  assert.ok(stacks.includes('node'));
  assert.ok(stacks.includes('go'), 'a polyglot repository reports every stack it finds');
  assert.ok(PROFILES.node.commands.test, 'each profile carries a candidate command');
  assert.equal(detectStacks(mkdtempSync(join(tmpdir(), 'sdlc-empty-'))).length, 0);
  rmSync(r, { recursive: true, force: true });
});

test('scaffold: protected-path detection only reports directories that exist', () => {
  const r = mkdtempSync(join(tmpdir(), 'sdlc-paths-'));
  mkdirSync(join(r, 'migrations'));
  mkdirSync(join(r, 'terraform'));
  const p = detectProtectedPaths(r);
  assert.deepEqual(p.migrations, ['migrations/**']);
  assert.ok(p.infra.includes('terraform/**'));
  assert.deepEqual(p.generated, [], 'nothing is invented; a glob that matches nothing is a false denial waiting to happen');
  rmSync(r, { recursive: true, force: true });
});
