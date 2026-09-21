/**
 * Scaffold — write the repository's own playbook artifacts, and be able to
 * update them later without clobbering what the team changed.
 *
 * Two rules shape this:
 *
 * 1. **Stack profiles are seed data for the interview only.** They are never
 *    read at hook runtime. If a profile were consulted while a gate evaluates,
 *    there would be two sources of truth for the same fact and they would drift.
 *    The interview proposes; the committed config decides.
 *
 * 2. **Every written file is recorded with its hash** in
 *    `.claude/.sdlc-scaffold.json`. That is what lets a later plugin version
 *    update the files nobody touched while proposing a diff for the ones the
 *    team edited. Without it, the second release either clobbers local edits or
 *    can never ship a template fix — and in practice that means template fixes
 *    stop shipping.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MANIFEST = '.claude/.sdlc-scaffold.json';

/**
 * Candidate commands per ecosystem. Proposals, not decisions — the interview
 * confirms or replaces each one, because a repository's real test command is
 * frequently not the ecosystem default.
 */
export const PROFILES = {
  node: {
    detect: 'package.json',
    commands: { build: 'npm run build', test: 'npm test', lint: 'npm run lint', format: 'npx prettier --write {file}', run: 'npm start' },
    tests: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '__tests__/**'],
    manifests: ['package.json'],
    healthy: 'Tests:\\s+\\d+ passed|\\d+ passing',
  },
  python: {
    detect: 'pyproject.toml',
    commands: { build: '', test: 'pytest', lint: 'ruff check .', format: 'ruff format {file}', run: '' },
    tests: ['tests/**', 'test_*.py', '**/test_*.py', '**/*_test.py'],
    manifests: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    healthy: '\\d+ passed',
  },
  go: {
    detect: 'go.mod',
    commands: { build: 'go build ./...', test: 'go test ./...', lint: 'golangci-lint run', format: 'gofmt -w {file}', run: '' },
    tests: ['**/*_test.go'],
    manifests: ['go.mod'],
    healthy: '^ok\\s|PASS',
  },
  java_maven: {
    detect: 'pom.xml',
    commands: { build: 'mvn -q package', test: 'mvn -q test', lint: '', format: '', run: '' },
    tests: ['src/test/**', '**/*Test.java'],
    manifests: ['pom.xml'],
    healthy: 'BUILD SUCCESS|Tests run: \\d+, Failures: 0',
  },
  java_gradle: {
    detect: 'build.gradle',
    commands: { build: './gradlew build', test: './gradlew test', lint: '', format: '', run: '' },
    tests: ['src/test/**', '**/*Test.java'],
    manifests: ['build.gradle', 'build.gradle.kts'],
    healthy: 'BUILD SUCCESSFUL',
  },
  rust: {
    detect: 'Cargo.toml',
    commands: { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy', format: 'cargo fmt', run: 'cargo run' },
    tests: ['tests/**', '**/*_test.rs'],
    manifests: ['Cargo.toml'],
    healthy: 'test result: ok',
  },
  dotnet: {
    detect: '*.csproj',
    commands: { build: 'dotnet build', test: 'dotnet test', lint: '', format: 'dotnet format', run: 'dotnet run' },
    tests: ['**/*Tests.cs', '**/*Test.cs'],
    manifests: ['*.csproj', 'Directory.Packages.props'],
    healthy: 'Passed!\\s|Passed:\\s+\\d+',
  },
  make: {
    detect: 'Makefile',
    commands: { build: 'make build', test: 'make test', lint: 'make lint', format: '', run: 'make run' },
    tests: ['test/**', 'tests/**'],
    manifests: [],
    healthy: '',
  },
};

/** Which ecosystems this repository looks like. Several can match at once. */
export function detectStacks(repoRoot) {
  const found = [];
  let entries = [];
  try { entries = readdirSync(repoRoot); } catch { /* unreadable */ }
  for (const [name, p] of Object.entries(PROFILES)) {
    const hit = p.detect.includes('*')
      ? entries.some((e) => e.endsWith(p.detect.replace('*', '')))
      : existsSync(join(repoRoot, p.detect));
    if (hit) found.push(name);
  }
  return found;
}

/** Common protected-path candidates, proposed rather than assumed. */
export function detectProtectedPaths(repoRoot) {
  const candidates = {
    generated: ['src/gen', 'gen', 'generated', 'src/generated', '__generated__', 'target/generated-sources'],
    migrations: ['migrations', 'db/migrate', 'alembic/versions', 'prisma/migrations'],
    infra: ['infra', 'terraform', 'helm', 'k8s', 'deploy', '.github/workflows'],
  };
  const out = { generated: [], migrations: [], infra: [] };
  for (const [kind, dirs] of Object.entries(candidates)) {
    for (const d of dirs) if (existsSync(join(repoRoot, d))) out[kind].push(`${d}/**`);
  }
  return out;
}

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function renderTemplate(text, tokens) {
  return String(text).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) =>
    (Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : m));
}

export function readManifest(repoRoot) {
  const p = join(repoRoot, MANIFEST);
  if (!existsSync(p)) return { version: 1, plugin_version: null, files: {} };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { version: 1, plugin_version: null, files: {} }; }
}

/**
 * Plan what writing `files` would do, without touching anything.
 *
 * Statuses:
 *   create   — nothing there yet
 *   update   — present, and identical to what the scaffold last wrote, so it is
 *              safe to replace
 *   modified — present and locally edited; the new version is offered as
 *              `<name>.sdlc-proposed` instead of overwriting the team's work
 *   same     — already exactly what would be written
 */
export function plan(repoRoot, files, pluginVersion) {
  const manifest = readManifest(repoRoot);
  const actions = [];

  for (const { path, content } of files) {
    const abs = join(repoRoot, path);
    const next = sha(content);
    if (!existsSync(abs)) {
      actions.push({ path, status: 'create', content });
      continue;
    }
    const current = readFileSync(abs, 'utf8');
    if (sha(current) === next) { actions.push({ path, status: 'same', content }); continue; }

    const recorded = manifest.files?.[path]?.sha;
    if (recorded && recorded === sha(current)) {
      actions.push({ path, status: 'update', content });
    } else {
      actions.push({ path, status: 'modified', content, proposedPath: `${path}.sdlc-proposed` });
    }
  }

  return { manifest, actions, pluginVersion };
}

/** Apply a plan. Returns what was written so a skill can report it precisely. */
export function apply(repoRoot, planned) {
  const written = [];
  const manifest = { ...planned.manifest, plugin_version: planned.pluginVersion, files: { ...planned.manifest.files } };

  for (const a of planned.actions) {
    if (a.status === 'same') continue;
    const target = a.status === 'modified' ? a.proposedPath : a.path;
    const abs = join(repoRoot, target);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, a.content, 'utf8');
    written.push({ path: target, status: a.status });
    // Only record a hash for files the scaffold actually owns. A `.sdlc-proposed`
    // is a suggestion, not a managed file.
    if (a.status !== 'modified') manifest.files[a.path] = { sha: sha(a.content) };
  }

  const mAbs = join(repoRoot, MANIFEST);
  mkdirSync(dirname(mAbs), { recursive: true });
  writeFileSync(mAbs, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return written;
}

/** Load a bundled template and fill it in. */
export function template(name, tokens) {
  const p = join(ROOT, 'skills', 'sdlc-init', 'templates', name);
  return renderTemplate(readFileSync(p, 'utf8'), tokens);
}

/**
 * Merge the safe inner loop into the repository's own settings.
 *
 * A plugin cannot ship permission rules — its settings.json honours only
 * `agent` and `subagentStatusLine` — so the anti-fatigue allowlist has to be
 * written into the repo. It is merged, never replaced: the team's existing
 * rules are theirs.
 */
export function mergeProjectSettings(repoRoot, { allow = [], deny = [] }) {
  const p = join(repoRoot, '.claude', 'settings.json');
  let current = {};
  if (existsSync(p)) {
    try { current = JSON.parse(readFileSync(p, 'utf8')); } catch { current = {}; }
  }
  const next = { ...current, permissions: { ...(current.permissions ?? {}) } };
  next.permissions.allow = [...new Set([...(current.permissions?.allow ?? []), ...allow])];
  next.permissions.deny = [...new Set([...(current.permissions?.deny ?? []), ...deny])];
  return { path: '.claude/settings.json', content: JSON.stringify(next, null, 2) + '\n', before: current };
}

/** The permission rules a repository needs, derived from its own answers. */
export function innerLoopRules(cfg) {
  const allow = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git checkout -b:*)'];
  for (const kind of ['build', 'test', 'lint', 'format', 'run']) {
    const cmd = cfg.commands?.[kind]?.cmd;
    if (cmd) allow.push(`Bash(${String(cmd).replace(/\s*\{file\}\s*/, ' ').trim()}:*)`);
  }
  const deny = [
    'Read(.env)', 'Read(.env.*)', 'Read(./secrets/**)',
    'Read(~/.ssh/**)', 'Read(~/.aws/**)',
  ];
  return { allow: [...new Set(allow)], deny };
}

export const manifestPath = MANIFEST;
