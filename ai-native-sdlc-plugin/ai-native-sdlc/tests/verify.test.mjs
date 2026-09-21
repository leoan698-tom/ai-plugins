/**
 * Artifact validation and the CI backstop.
 *
 * The sdlc-verify cases build a real git repository and run the real CLI over a
 * real diff range. That matters more than usual here: this command is the
 * PRIMARY control when an organisation has no managed settings, because the
 * local hooks can be switched off by anyone and a missing Node interpreter makes
 * them fail open silently. If it only worked in theory, nothing would.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate, filesThatChange, headings, artifactKind } from '../lib/artifacts.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(HERE, '../bin/sdlc-verify.mjs');

// --- artifact schemas ------------------------------------------------------

test('artifacts: a complete English plan validates', () => {
  const md = `# Plan: x
## Files that change
\`src/api.ts\`, \`src/api.test.ts\`
## Order of work
1. endpoint
## Risks
rate limit
## Proof
tests cover four states
`;
  const r = validate('plan.md', md);
  assert.ok(r.ok, `expected valid, missing: ${r.missing.join(',')}`);
  assert.deepEqual(filesThatChange(md), ['src/api.ts', 'src/api.test.ts']);
});

test('artifacts: a Chinese-language intent validates through the alias table', () => {
  // The whole point of the alias table: this document is well formed, and an
  // English-only schema would reject it for sections that are present.
  const md = `# Intent: 理赔状态自助查询
作者: J. Ortiz
## 问题
客户打电话询问理赔进度。
## 提议的结果
客户在门户上看到状态、下一步和预计日期。
## 受影响的用户和系统
理赔专员、门户团队、claims API。
## 约束
门户会话中不引入新的 PII。
## 开放问题
第三方公估人是否也需要访问？
`;
  const r = validate('intent.md', md);
  assert.ok(r.ok, `Chinese headings must satisfy the schema, missing: ${r.missing.join(',')}`);
});

test('artifacts: a plan missing sections reports exactly which', () => {
  const r = validate('plan.md', '# Plan\n## Files that change\n`a.ts`\n## Order of work\n1. do it\n');
  assert.ok(!r.ok);
  assert.ok(r.missing.includes('risks'));
  assert.ok(r.missing.includes('proof'));
  assert.ok(!r.missing.includes('files'));
});

test('artifacts: a Files-that-change section with no paths does not count as present', () => {
  // A heading with nothing under it satisfies the letter of the rule and none
  // of its purpose — the plan-sync gate has nothing to compare a commit against.
  const r = validate('plan.md', '# P\n## Files that change\nTBD\n## Order of work\n1.\n## Risks\nnone\n## Proof\ntests\n');
  assert.ok(!r.ok);
  assert.ok(r.missing.some((m) => m.startsWith('files')));
});

test('artifacts: strict level additionally requires Alternatives considered', () => {
  const md = '# P\n## Files that change\n`a.ts`\n## Order of work\n1.\n## Risks\nr\n## Proof\np\n';
  assert.ok(validate('plan.md', md, { level: 'standard' }).ok);
  assert.ok(!validate('plan.md', md, { level: 'strict' }).ok);
});

test('artifacts: repo aliases extend rather than replace the built-ins', () => {
  const md = '# Intent\n## Background\nb\n## Goal\ng\n## Stakeholders\ns\n## Constraints\nc\n## Open questions\nq\n';
  const aliases = { 'intent.md': { problem: ['background'], outcome: ['goal'], affected: ['stakeholders'] } };
  assert.ok(!validate('intent.md', md).ok, 'without aliases these headings are unknown');
  assert.ok(validate('intent.md', md, { aliasOverrides: aliases }).ok);
});

test('artifacts: kind detection and heading parsing', () => {
  assert.equal(artifactKind('intent/x/plan.md'), 'plan.md');
  assert.equal(artifactKind('src/readme.md'), null);
  assert.equal(headings('## A\n### B\ntext\n').length, 2);
});

// --- sdlc-verify over a real repository ------------------------------------

let repo;

function git(...a) {
  const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', shell: false });
  if (r.status !== 0 && !a.includes('--quiet')) {
    throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function write(rel, text) {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function verify(...extra) {
  const r = spawnSync(process.execPath, [CLI, '--repo', repo, '--json', ...extra], {
    encoding: 'utf8', timeout: 30000,
  });
  return { status: r.status, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null, raw: r.stdout, err: r.stderr };
}

const ids = (res) => (res.json?.findings ?? []).map((f) => f.id);

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'sdlc-ci-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  write('.claude/sdlc/config.json', JSON.stringify({
    intent_home: 'intent',
    paths: {
      tests: ['tests/**'],
      generated: ['src/gen/**'],
      frozen: [{ glob: 'src/v1/**', successor: 'src/v2/' }],
      lockfiles: ['package-lock.json'],
      verify_exempt: ['**/*.md', 'docs/**'],
    },
    owners: { dependencies: 'the platform team' },
  }));
  write('src/api.ts', 'export const a = 1;\n');
  write('tests/api.test.ts', 'it("works", () => {});\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  git('branch', '-M', 'main');
});

after(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('sdlc-verify: a clean change passes', () => {
  git('checkout', '--quiet', '-b', 'clean-change');
  write('intent/feature/plan.md', '# Plan\n## Files that change\n`src/api.ts`\n## Order of work\n1. edit\n## Risks\nnone\n## Proof\ntests\n');
  write('src/api.ts', 'export const a = 2;\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'clean');

  const res = verify('--base', 'main', '--head', 'HEAD');
  assert.equal(res.status, 0, `expected clean, got: ${res.raw}`);
  assert.equal(res.json.errors, 0);
  git('checkout', '--quiet', 'main');
});

test('sdlc-verify: catches a credential that the local hooks never saw', () => {
  // The scenario this command exists for: hooks disabled, or Node missing, so
  // the commit was made with no local enforcement at all.
  git('checkout', '--quiet', '-b', 'leaky');
  write('src/config.ts', 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
  write('intent/leak/plan.md', '# Plan\n## Files that change\n`src/config.ts`\n## Order of work\n1.\n## Risks\nn\n## Proof\np\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'leak');

  const res = verify('--base', 'main', '--head', 'HEAD');
  assert.equal(res.status, 1, 'a credential must fail the check');
  assert.ok(ids(res).includes('P28'));
  assert.ok(!res.raw.includes('AKIAIOSFODNN7EXAMPLE'), 'the finding must not echo the secret');
  git('checkout', '--quiet', 'main');
});

test('sdlc-verify: catches frozen paths, lockfiles and disabled tests', () => {
  git('checkout', '--quiet', '-b', 'violations');
  write('src/v1/Handler.java', 'class Handler {}\n');
  write('package-lock.json', '{"v":2}\n');
  write('tests/api.test.ts', 'it.skip("works", () => {});\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'violations');

  const res = verify('--base', 'main', '--head', 'HEAD');
  assert.equal(res.status, 1);
  const found = ids(res);
  assert.ok(found.includes('P20'), 'frozen path');
  assert.ok(found.includes('P19'), 'lockfile');
  assert.ok(found.includes('P41'), 'test disabled rather than fixed');
  const frozen = res.json.findings.find((f) => f.id === 'P20');
  assert.match(frozen.route, /src\/v2\//, 'the route names the successor package');
  git('checkout', '--quiet', 'main');
});

test('sdlc-verify: catches implementation that departed from the plan', () => {
  git('checkout', '--quiet', '-b', 'drift');
  write('intent/drift/plan.md', '# Plan\n## Files that change\n`src/api.ts`\n## Order of work\n1.\n## Risks\nn\n## Proof\np\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'plan');
  write('src/api.ts', 'export const a = 3;\n');
  write('src/cache.ts', 'export const c = 1;\n');   // not in the plan
  git('add', '-A'); git('commit', '--quiet', '-m', 'impl');

  const res = verify('--base', 'main', '--head', 'HEAD');
  const drift = (res.json.findings ?? []).find((f) => f.id === 'P15');
  assert.ok(drift, `expected a plan-sync finding, got ${JSON.stringify(ids(res))}`);
  assert.match(drift.detail, /src\/cache\.ts/);
  git('checkout', '--quiet', 'main');
});

test('sdlc-verify: rejects a malformed artifact and accepts a Chinese one', () => {
  git('checkout', '--quiet', '-b', 'artifacts');
  write('intent/a/intent.md', '# Intent\n## Problem\np\n');       // missing four sections
  git('add', '-A'); git('commit', '--quiet', '-m', 'bad artifact');
  let res = verify('--base', 'main', '--head', 'HEAD');
  assert.equal(res.status, 1);
  assert.ok(ids(res).includes('P03'));

  write('intent/a/intent.md', '# Intent\nAuthor: J. Ortiz\n## 问题\np\n## 提议的结果\no\n## 受影响的用户和系统\na\n## 约束\nc\n## 开放问题\nq\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'chinese artifact');
  res = verify('--base', 'main', '--head', 'HEAD');
  assert.ok(!ids(res).includes('P03'), 'Chinese headings must satisfy the same schema');
  git('checkout', '--quiet', 'main');
});

test('sdlc-verify: says so plainly when a repository is not configured', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sdlc-bare-'));
  spawnSync('git', ['init', '--quiet'], { cwd: bare });
  const r = spawnSync(process.execPath, [CLI, '--repo', bare], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  // "No findings" must never be mistaken for "compliant".
  assert.match(r.stdout, /no SDLC policy file/);
  rmSync(bare, { recursive: true, force: true });
});

test('sdlc-verify: exits 2 rather than 0 when it cannot run', () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'sdlc-notrepo-'));
  const r = spawnSync(process.execPath, [CLI, '--repo', notRepo], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'an unusable environment must not look like a pass');
  rmSync(notRepo, { recursive: true, force: true });
});
