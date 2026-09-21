/**
 * SubagentStart / SubagentStop — containment for read-only agents.
 *
 * The shipped verifier has no write tools, which is a hard capability
 * restriction. But it is a property of one file: the moment someone copies
 * verifier.md into .claude/agents/ and adds Edit — which the documentation
 * actively suggests for agents that need hooks or permissionMode, since plugin
 * agents ignore those fields — separation of duties silently evaporates.
 *
 * Plugin hooks DO run inside subagents and the payload carries `agent_type`, so
 * this pair survives the copy:
 *
 *   SubagentStart — record a fingerprint of the tree the subagent inherits
 *   SubagentStop  — compare, and block if a read-only agent changed anything
 *
 * Taking the baseline is the half the design this was built from forgot: its
 * stop check compared against a snapshot no registered hook ever wrote.
 *
 * Invoked with an argument naming which half to run, so one script serves both
 * events and there is one file to keep correct.
 */

import { readPayload, emitAllow, emitContext, emitStopBlock } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';
import { treeFingerprint, configuredCommands } from '../lib/verify.mjs';
import * as state from '../lib/state.mjs';
import { repoKey as gitRepoKey } from '../lib/git.mjs';
import { record } from '../lib/log.mjs';

const half = process.argv[2] === 'stop' ? 'stop' : 'start';
const EVENT = half === 'stop' ? 'SubagentStop' : 'SubagentStart';

async function main() {
  const payload = await readPayload();
  if (!payload) return emitAllow();

  const cwd = payload.cwd || process.cwd();
  const { repoRoot, cfg, level } = loadConfig(cwd);
  const repoKey = gitRepoKey(repoRoot);
  const agentType = payload.agent_type ?? null;
  const agentId = payload.agent_id ?? 'unknown';

  const readonly = (cfg.readonly_agent_types ?? []).map((t) => String(t).toLowerCase());
  const isReadonly = agentType && readonly.includes(String(agentType).toLowerCase());

  if (half === 'start') {
    if (isReadonly) {
      const { fingerprint } = treeFingerprint(repoRoot, cfg);
      state.update(payload.session_id, repoKey, (s) => {
        s.subagents = { ...(s.subagents ?? {}), [agentId]: { agentType, fingerprint, at: new Date().toISOString() } };
        return s;
      });
    }

    // Give every subagent the facts it needs so it does not attempt something
    // the gates will refuse.
    const s = state.read(payload.session_id, repoKey);
    const runCmd = cfg.commands?.run?.cmd;
    const parts = [];
    if (runCmd) parts.push(`Run command for this repository: \`${runCmd}\`.`);
    if (s.change_dir) parts.push(`Active change: ${s.change_dir} (plan at ${s.change_dir}/plan.md).`);
    if (s.fix?.phase === state.FIX_PHASE.LOCKED) parts.push('Fix mode is locked: test files are read-only.');
    if (isReadonly) {
      parts.push(
        `This agent type is configured read-only, so writes are denied and the working tree is compared `
        + 'against a baseline when it finishes.',
      );
    }
    return parts.length ? emitContext(EVENT, parts.join(' ')) : emitAllow();
  }

  // --- stop half ---------------------------------------------------------
  if (!isReadonly) return emitAllow();

  const s = state.read(payload.session_id, repoKey);
  const baseline = s.subagents?.[agentId];
  if (!baseline) return emitAllow();          // never saw the start; nothing to compare

  const { fingerprint } = treeFingerprint(repoRoot, cfg);

  state.update(payload.session_id, repoKey, (st) => {
    if (st.subagents) delete st.subagents[agentId];
    return st;
  });

  if (fingerprint === baseline.fingerprint) return emitAllow();

  record({
    hook: 'subagent', event: EVENT, level, rule: 'h27-subagent-stop-diff', cls: 'A',
    decision: 'block', hard: true, session: payload.session_id, agent: agentType, repoKey,
    detail: 'readonly-agent-modified-tree',
  });

  return emitStopBlock(
    `[ai-native-sdlc] BLOCKED — read-only agent '${agentType}' changed the working tree\n`
    + `Policy: the verifier exercises the change and reports; it does not fix anything (Playbook P34, Lesson 7)\n`
    + `Why: the tree fingerprint differs from the one taken when this subagent started\n`
    + `Route: report the finding to the main session and let it make the change. `
    + `Inspect what moved with \`git status\`, and revert anything this agent wrote.\n`
    + `Gate: always-hard`,
  );
}

main().catch(() => emitAllow());
