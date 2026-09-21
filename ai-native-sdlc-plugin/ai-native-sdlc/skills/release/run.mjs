/**
 * Shim so a skill can invoke the plugin CLI from `allowed-tools`.
 *
 * `allowed-tools` substitutes ${CLAUDE_SKILL_DIR} and ${CLAUDE_PROJECT_DIR};
 * ${CLAUDE_PLUGIN_ROOT} there is NOT documented. Rather than depend on an
 * unverified substitution — which would fail as a permission prompt on every
 * call — each skill declares the shim beside itself and the shim resolves the
 * plugin root relative to its own location, which always works.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../scripts/sdlc.mjs');
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
