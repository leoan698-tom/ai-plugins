/**
 * PreToolUse dispatcher for Bash | PowerShell.
 *
 * The matcher covers both because on Windows without Git Bash the Bash tool is
 * not registered at all and every shell call arrives as `PowerShell`. A gate
 * matching only `Bash` would never fire on those machines — and it would fail
 * open silently, which is the worst way for a gate to be absent.
 *
 * One process, all shell rules, first deny wins.
 */

import { readPayload, runRules, emitAllow, emitDeny, emitWarn, CLASS } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';
import { shellCommand } from '../lib/toolinput.mjs';
import { parseCommand } from '../lib/commands.mjs';
import { shellRules } from '../lib/rules/shell.mjs';
import * as state from '../lib/state.mjs';
import { repoKey as gitRepoKey, currentBranch, defaultBranch } from '../lib/git.mjs';
import { record } from '../lib/log.mjs';
import { block, redactCommand } from '../lib/message.mjs';

const EVENT = 'PreToolUse';

async function main() {
  const payload = await readPayload();
  if (!payload) return emitAllow();

  const command = shellCommand(payload.tool_input ?? {});
  if (!command) return emitAllow();

  const cwd = payload.cwd || process.cwd();
  const { repoRoot, cfg, level, user, errors } = loadConfig(cwd);

  const repoKey = gitRepoKey(repoRoot);
  const sessionState = state.read(payload.session_id, repoKey);

  if (sessionState._corrupt) {
    return emitDeny(EVENT, block({
      title: 'session state unreadable',
      policy: 'the fix-mode test lock cannot be verified, and a lock that cannot be verified is not a lock',
      id: 'P39', lesson: 8,
      attempted: `${payload.tool_name} ${redactCommand(command)}`,
      why: 'the plugin state file for this session is present but not valid JSON',
      route: 'run /ai-native-sdlc:sdlc-doctor, which repairs the state file, then retry',
      gate: 'always-hard (fail-closed)',
    }));
  }

  const ctx = {
    event: EVENT,
    tool: payload.tool_name ?? 'Bash',
    command,
    subcommands: parseCommand(command),
    level, cfg, user,
    repoRoot, repoKey,
    state: sessionState,
    agentType: payload.agent_type ?? null,
    branch: currentBranch(repoRoot),
    defaultBranch: defaultBranch(repoRoot),
    configErrors: errors,
  };

  const logs = [];
  const outcome = runRules(shellRules, ctx, (e) => logs.push(e));

  for (const e of logs) {
    record({
      hook: 'pre-bash', event: EVENT, tool: ctx.tool, level,
      rule: e.rule, cls: e.cls, decision: e.verdict, hard: e.cls === CLASS.A,
      session: payload.session_id, agent: ctx.agentType, repoKey,
      command, duration_ms: e.duration_ms, detail: e.detail,
    });
  }

  if (outcome.action === 'deny') return emitDeny(EVENT, outcome.message);
  if (outcome.action === 'warn') return emitWarn(EVENT, outcome.message);
  return emitAllow();
}

main().catch(() => {
  // Same inversion as the file dispatcher: this process hosts the production
  // gate and the push guard, so a crash must not become an allow.
  emitDeny(EVENT, block({
    title: 'shell policy gate could not run',
    policy: 'safety-critical gates fail closed, because on some platforms they are the only enforcement layer',
    id: 'R2', lesson: 11,
    attempted: 'shell command',
    why: 'the ai-native-sdlc pre-bash dispatcher threw before reaching a decision',
    route: 'run /ai-native-sdlc:sdlc-doctor for diagnostics; a human can set hard_hooks_locked=false '
         + 'to unblock temporarily, which is recorded in the decision ledger',
    gate: 'always-hard (fail-closed)',
  }));
});
