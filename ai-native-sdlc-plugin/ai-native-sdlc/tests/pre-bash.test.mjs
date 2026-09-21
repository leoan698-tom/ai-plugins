/**
 * End-to-end tests for the shell dispatcher.
 *
 * Every case runs the real hook process. The PowerShell cases matter as much as
 * the Bash ones: on a Windows machine without Git Bash the Bash tool is never
 * registered, so a gate that only understands POSIX syntax is a gate that does
 * not exist there.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HOOK = resolve(HERE, '../hooks/pre-bash.mjs');

let repo, dataDir;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'sdlc-shrepo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'sdlc-shdata-'));
  mkdirSync(join(repo, '.claude', 'sdlc'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'sdlc', 'config.json'), JSON.stringify({
    default_branch: 'main',
    protected_branches: ['main', 'release/*'],
    paths: {
      tests: ['tests/**'],
      generated: ['src/gen/**'],
      lockfiles: ['package-lock.json'],
      secrets_read_deny: ['.env', '.env.*', '**/secrets/**'],
      secrets_read_allow: ['.env.example'],
    },
    allowed_domains: ['registry.npmjs.org'],
  }));
});

after(() => {
  for (const d of [repo, dataDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function run(command, { tool = 'Bash', env = {}, session = 'sh-session' } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      session_id: session, cwd: repo, hook_event_name: 'PreToolUse',
      tool_name: tool, tool_input: { command }, tool_use_id: 't1',
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...env },
    timeout: 15000,
  });
  const stdout = (r.stdout ?? '').trim();
  return { status: r.status, stdout, json: stdout.startsWith('{') ? JSON.parse(stdout) : null };
}

function reasonOf(res) {
  assert.ok(res.json, `expected a decision, got: ${JSON.stringify(res.stdout).slice(0, 200)}`);
  const hso = res.json.hookSpecificOutput;
  assert.equal(hso?.permissionDecision, 'deny');
  return hso.permissionDecisionReason;
}
const denied = (res, re) => { const r = reasonOf(res); if (re) assert.match(r, re); return r; };
const allowed = (res) => assert.equal(res.stdout, '', 'an allow writes nothing');

// --- production gate -------------------------------------------------------

test('denies a production deploy with no authorization, and says the gate is weak', () => {
  const r = denied(run('helm upgrade api ./chart --namespace production'), /P58/);
  assert.match(r, /SDLC_RELEASE_APPROVAL/);
  assert.match(r, /not.*genuine|attributable/i, 'the message must not overclaim authentication');
});

test('allows the same deploy once an authorization is present', () => {
  allowed(run('helm upgrade api ./chart --namespace production',
    { env: { SDLC_RELEASE_APPROVAL: 'REL-42 approved by release manager' } }));
});

test('allows a non-production deploy — autonomy is graded by environment', () => {
  allowed(run('helm upgrade api ./chart --namespace staging'));
});

// --- branch protection and separation of duties ----------------------------

test('denies a push to the default branch', () => {
  denied(run('git push origin main'), /protected branch 'main'/);
});

test('denies a push to a protected pattern', () => {
  denied(run('git push origin release/2.0'), /protected branch/);
});

test('allows a push to a feature branch', () => {
  allowed(run('git push -u origin feature/add-cache'));
});

test('catches a protected push hidden behind a chained command', () => {
  // The whole point of splitting subcommands rather than matching the first word.
  denied(run('npm run build && git push origin main'), /protected branch/);
});

test('does not fire on a mention of the command inside a string', () => {
  allowed(run('echo "remember: never git push origin main"'));
});

test('denies self-merge and self-approval of a pull request', () => {
  denied(run('gh pr merge 42 --squash'), /P54/);
  denied(run('gh pr review 42 --approve'), /P54/);
  allowed(run('gh pr review 42 --comment --body "looks good"'));
});

test('denies --no-verify and git config tampering', () => {
  denied(run('git commit --no-verify -m "wip"'), /--no-verify/);
  denied(run('git config core.hooksPath /dev/null'), /P65/);
});

// --- shell shadow of the file gates ----------------------------------------

test('denies writing a protected path through a redirect', () => {
  denied(run('echo "x" > src/gen/model.ts'), /protected path/i);
});

test('denies rewriting the enforcement config through sed', () => {
  denied(run('sed -i "s/deny/warn/" .claude/sdlc/config.json'), /protected path/i);
});

test('allows an ordinary redirect to an ordinary file', () => {
  allowed(run('echo "hello" > notes.txt'));
});

// --- secret reads ----------------------------------------------------------

test('denies reading a secret file through the shell', () => {
  denied(run('cat .env'), /P62/);
});

test('allows the example file that exists to be read', () => {
  allowed(run('cat .env.example'));
});

test('denies dumping the whole environment', () => {
  denied(run('printenv'), /environment dump/);
  allowed(run('printenv PATH'));
});

// --- egress ----------------------------------------------------------------

test('denies egress to an unlisted host and allows localhost', () => {
  denied(run('curl https://evil.example.com/x'), /P63/);
  allowed(run('curl http://localhost:3000/health'));
  allowed(run('curl https://registry.npmjs.org/package'));
});

// --- PowerShell parity -----------------------------------------------------

test('PowerShell aliases are understood, not just POSIX syntax', () => {
  denied(run('Get-Content .env', { tool: 'PowerShell' }), /P62/);
  denied(run('Invoke-WebRequest https://evil.example.com', { tool: 'PowerShell' }), /P63/);
  denied(run('Set-Content -Path src/gen/model.ts -Value "x"', { tool: 'PowerShell' }), /protected path/i);
});

test('an empty or malformed payload allows rather than crashing', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '', encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, timeout: 15000,
  });
  assert.equal(r.status, 0);
  assert.equal((r.stdout ?? '').trim(), '');
});
