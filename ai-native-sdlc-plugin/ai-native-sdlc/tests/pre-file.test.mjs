/**
 * End-to-end tests for the pre-file dispatcher.
 *
 * These drive the real hook process with real stdin, the same way Claude Code
 * does, and assert on the exact JSON it writes. Unit-testing the rules alone
 * would not catch the failures that actually matter here: a decision nested
 * under the wrong key is silently ignored by the runtime, and stdout that does
 * not start with `{` is read as plain text and discarded.
 *
 * Windows-style absolute paths are used throughout on win32 because that is the
 * documented arrival form for file tools.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HOOK = resolve(HERE, '../hooks/pre-file.mjs');

let repo;      // fake repository root
let dataDir;   // stands in for CLAUDE_PLUGIN_DATA

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'sdlc-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'sdlc-data-'));
  mkdirSync(join(repo, '.claude', 'sdlc'), { recursive: true });
  mkdirSync(join(repo, 'src', 'v1'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });

  writeFileSync(join(repo, '.claude', 'sdlc', 'config.json'), JSON.stringify({
    intent_home: 'intent',
    paths: {
      tests: ['tests/**', '**/*.test.*'],
      frozen: [{ glob: 'src/v1/**', successor: 'src/v2/' }],
      generated: ['src/gen/**'],
      lockfiles: ['package-lock.json'],
      migrations: ['db/migrate/**'],
      secret_scan_allow: ['**/fixtures/**'],
    },
    readonly_agent_types: ['verifier'],
    owners: { dependencies: 'the platform team' },
  }));
});

after(() => {
  for (const d of [repo, dataDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Run the hook exactly as the runtime would and parse what it wrote. */
function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...env },
    timeout: 15000,
  });
  const stdout = (r.stdout ?? '').trim();
  return {
    status: r.status,
    stdout,
    json: stdout.startsWith('{') ? JSON.parse(stdout) : null,
    stderr: r.stderr ?? '',
  };
}

const abs = (...parts) => join(repo, ...parts);

function filePayload(tool, toolInput, extra = {}) {
  return {
    session_id: 'test-session',
    cwd: repo,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'toolu_test',
    ...extra,
  };
}

/** A deny must be nested under hookSpecificOutput or the runtime ignores it. */
function assertDenied(res, matcher) {
  assert.equal(res.status, 0, 'hook exits 0 and carries the decision in JSON');
  assert.ok(res.json, `expected a JSON decision, got: ${JSON.stringify(res.stdout).slice(0, 200)}`);
  const hso = res.json.hookSpecificOutput;
  assert.ok(hso, 'decision must be nested under hookSpecificOutput');
  assert.equal(hso.hookEventName, 'PreToolUse');
  assert.equal(hso.permissionDecision, 'deny');
  const reason = hso.permissionDecisionReason;
  assert.ok(reason, 'a deny must carry a reason — it is the only text Claude sees');
  // The six-line contract from Lesson 11: a block explains itself.
  assert.match(reason, /BLOCKED/);
  assert.match(reason, /^Policy: /m);
  assert.match(reason, /^Why: /m);
  assert.match(reason, /^Route: /m);
  assert.match(reason, /^Gate: /m);
  if (matcher) assert.match(reason, matcher);
  return reason;
}

function assertAllowed(res) {
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '', 'an allow writes nothing at all');
}

// --- the gates -------------------------------------------------------------

test('allows an ordinary source edit', () => {
  assertAllowed(runHook(filePayload('Edit', {
    file_path: abs('src', 'api.ts'), old_string: 'a', new_string: 'b',
  })));
});

test('denies a credential in new content, without echoing it', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const reason = assertDenied(runHook(filePayload('Write', {
    file_path: abs('src', 'config.ts'),
    content: `export const key = "${secret}";`,
  })), /aws-access-key-id/);
  assert.ok(!reason.includes(secret), 'the block message must never contain the secret');
  assert.match(reason, /P28/);
});

test('denies a credential inside a notebook cell — notebook_path / new_source', () => {
  // The Phase 0 finding: NotebookEdit uses different field names. A gate reading
  // only file_path/content sees nothing here and allows the write.
  const reason = assertDenied(runHook(filePayload('NotebookEdit', {
    notebook_path: abs('analysis.ipynb'),
    cell_id: 'c1',
    new_source: 'token = "ghp_abcdefghijabcdefghijabcdefghijabcdef"',
    cell_type: 'code',
  })), /github-token/);
  assert.match(reason, /analysis\.ipynb/, 'the notebook path must appear in the message');
});

test('allows a placeholder that merely looks like a credential', () => {
  assertAllowed(runHook(filePayload('Write', {
    file_path: abs('src', 'example.ts'),
    content: 'const apiKey = "<your-api-key-here>";\nconst t = process.env.TOKEN;',
  })));
});

test('allows a real-looking key inside an allow-listed fixture path', () => {
  assertAllowed(runHook(filePayload('Write', {
    file_path: abs('tests', 'fixtures', 'sample.json'),
    content: '{"key":"AKIAIOSFODNN7EXAMPLE"}',
  })));
});

test('denies an edit to a frozen path and names the successor', () => {
  assertDenied(runHook(filePayload('Edit', {
    file_path: abs('src', 'v1', 'Handler.java'), old_string: 'x', new_string: 'y',
  })), /src\/v2\//);
});

test('denies a lockfile edit and routes to the owner', () => {
  assertDenied(runHook(filePayload('Write', {
    file_path: abs('package-lock.json'), content: '{}',
  })), /the platform team/);
});

test('denies a migration without a change ticket, and allows one with', () => {
  const payload = filePayload('Write', {
    file_path: abs('db', 'migrate', '001_add_col.sql'), content: 'ALTER TABLE t ADD c INT;',
  });
  assertDenied(runHook(payload), /P59/);
  assertAllowed(runHook(payload, { SDLC_CHANGE_TICKET: 'ABC-123' }));
});

test('denies any write to the enforcement configuration', () => {
  assertDenied(runHook(filePayload('Write', {
    file_path: abs('.claude', 'sdlc', 'config.json'),
    content: '{"paths":{"tests":[]}}',
  })), /P18\/P65/);
});

test('denies a write from a read-only agent type', () => {
  assertDenied(runHook(filePayload('Edit', {
    file_path: abs('src', 'api.ts'), old_string: 'a', new_string: 'b',
  }, { agent_type: 'verifier' })), /P34/);
});

test('denies adding a skip marker to a test', () => {
  assertDenied(runHook(filePayload('Edit', {
    file_path: abs('tests', 'api.test.ts'),
    old_string: 'it("works", () => {',
    new_string: 'it.skip("works", () => {',
  })), /P41/);
});

test('allows editing a test that already had the marker', () => {
  // Removing or keeping an existing skip is not the agent switching a test off.
  assertAllowed(runHook(filePayload('Edit', {
    file_path: abs('tests', 'api.test.ts'),
    old_string: 'it.skip("works", () => { a(); })',
    new_string: 'it.skip("works", () => { b(); })',
  })));
});

test('denies an artifact written outside the intent home', () => {
  assertDenied(runHook(filePayload('Write', {
    file_path: abs('docs', 'plan.md'), content: '# Plan\n',
  })), /intent\//);
});

test('allows a well-formed artifact inside the intent home', () => {
  assertAllowed(runHook(filePayload('Write', {
    file_path: abs('intent', 'claims-status', 'plan.md'),
    content: '# Plan\n## Files that change\n`src/api.ts`\n## Order of work\n1. endpoint\n## Risks\nnone\n## Proof\ntests pass\n',
  })));
});

test('denies an artifact that is missing the sections the next stage reads', () => {
  assertDenied(runHook(filePayload('Write', {
    file_path: abs('intent', 'claims-status', 'plan.md'), content: '# Plan\nI will fix it.\n',
  })), /missing .*risks|missing .*proof/i);
});

test('accepts a Chinese-language artifact through the heading alias table', () => {
  // An English-only schema would reject this for sections that are present.
  assertAllowed(runHook(filePayload('Write', {
    file_path: abs('intent', 'claims-status', 'intent.md'),
    content: '# Intent\n作者: J. Ortiz\n## 问题\np\n## 提议的结果\no\n## 受影响的用户和系统\na\n## 约束\nc\n## 开放问题\nq\n',
  })));
});

test('an unrecognised tool_input shape fails CLOSED', () => {
  // MultiEdit has no published schema. Guessing would be a silent bypass.
  const reason = assertDenied(runHook(filePayload('MultiEdit', {
    mystery_field: [{ a: 1 }],
  })), /not recognised/);
  assert.match(reason, /fail-closed/);
});

test('the test lock blocks test edits once fix mode is locked', async () => {
  // Drive the real state module so the file name and shape match what the
  // dispatcher reads — a test that invents its own layout proves nothing.
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const state = await import('../lib/state.mjs');
  const { repoKey } = await import('../lib/git.mjs');
  const key = repoKey(repo);

  state.write('locked-session', key, {
    ...state.EMPTY,
    fix: { phase: state.FIX_PHASE.LOCKED, locked: {}, entered_at: '2026-01-01T00:00:00Z' },
  });

  const denied = runHook(filePayload('Edit', {
    file_path: abs('tests', 'api.test.ts'), old_string: 'a', new_string: 'b',
  }, { session_id: 'locked-session' }));
  assertDenied(denied, /P39/);

  // Source edits stay possible: the point is to fix the code, not the test.
  assertAllowed(runHook(filePayload('Edit', {
    file_path: abs('src', 'api.ts'), old_string: 'a', new_string: 'b',
  }, { session_id: 'locked-session' })));

  if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prev;
});

test('a corrupt state file denies rather than silently unlocking the test lock', async () => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const state = await import('../lib/state.mjs');
  const { repoKey } = await import('../lib/git.mjs');

  // Create a valid file through the real writer, then corrupt its contents.
  const file = state.write('corrupt-session', repoKey(repo), { ...state.EMPTY });
  writeFileSync(file, '{ this is not json', 'utf8');

  const reason = assertDenied(runHook(filePayload('Edit', {
    file_path: abs('src', 'api.ts'), old_string: 'a', new_string: 'b',
  }, { session_id: 'corrupt-session' })), /state unreadable/);
  assert.match(reason, /fail-closed/, 'an unverifiable lock must not be treated as absent');

  if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prev;
});
