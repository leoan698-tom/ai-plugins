/**
 * PreToolUse dispatcher for Edit | Write | MultiEdit | NotebookEdit.
 *
 * ONE Node process evaluates every file gate. The alternative — one registered
 * hook per rule — spawns six to ten processes on the most frequent action in a
 * session, which on Windows is hundreds of milliseconds added to the inner loop.
 * Lesson 6 requires build-phase hooks to be fast and file-scoped, and the
 * course's own warning applies: a slow gate is a gate that gets switched off.
 *
 * Output contract: exactly one JSON object on stdout, then exit 0. Never a
 * `console.log` anywhere else in the process — stdout that does not start with
 * `{` is read as plain text and the decision is silently discarded.
 */

import { readPayload, runRules, emitAllow, emitDeny, emitWarn, CLASS } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';
import { toRepoRelative } from '../lib/paths.mjs';
import { targetPath, incomingContent, outgoingContent } from '../lib/toolinput.mjs';
import { fileRules } from '../lib/rules/file.mjs';
import { scanAll } from '../lib/secrets.mjs';
import * as state from '../lib/state.mjs';
import { repoKey as gitRepoKey, currentBranch } from '../lib/git.mjs';
import { record } from '../lib/log.mjs';
import { block } from '../lib/message.mjs';

const EVENT = 'PreToolUse';

async function main() {
  const started = Date.now();
  const payload = await readPayload();
  if (!payload) return emitAllow();

  const cwd = payload.cwd || process.cwd();
  const { repoRoot, cfg, level, user, configured, errors } = loadConfig(cwd);

  const toolInput = payload.tool_input ?? {};
  const tool = payload.tool_name ?? 'file tool';

  const target = targetPath(toolInput);
  const content = incomingContent(toolInput);

  // An undocumented tool_input shape. `MultiEdit` has no published schema, so
  // this is a live possibility rather than a theoretical one. The configured
  // policy decides; it defaults to deny, so an unknown shape fails closed.
  if (!target.understood && !target.path) {
    const policy = (cfg.unparseable_tool_input ?? 'deny').toLowerCase();
    // Content scanning still works without a path, so a secret is caught even
    // here. Only the path-based rules are blind.
    const secretHit = content.strings.length > 0 && scanAll(content.strings).length > 0;
    if (policy === 'deny' || secretHit) {
      const reason = block({
        title: 'tool input shape not recognised',
        policy: 'a path-based gate that cannot read the path cannot enforce anything, so it stops rather than guesses',
        id: 'P29', lesson: 6,
        attempted: `${tool} (no file path could be extracted)`,
        why: `tool_input carried keys [${Object.keys(toolInput).join(', ') || 'none'}] and neither file_path nor notebook_path`,
        route: 'use Edit, Write or NotebookEdit, whose shapes are published; '
             + 'if this tool is legitimate, set unparseable_tool_input to "warn" in the repo config via PR and report it as a plugin bug',
        gate: 'always-hard (fail-closed)',
      });
      logOne({ payload, repoRoot, level, rule: 'h00-unparseable-input', cls: CLASS.A, decision: 'deny', started, detail: 'unparseable-tool-input' });
      return emitDeny(EVENT, reason);
    }
  }

  const absPath = target.path;
  const relPath = absPath ? toRepoRelative(absPath, repoRoot) : null;

  const repoKey = gitRepoKey(repoRoot);
  const sessionState = state.read(payload.session_id, repoKey);

  // A corrupt state file means the test lock cannot be trusted. That is exactly
  // the case Class A must fail closed on, so surface it as an error the rule
  // runner converts into a deny rather than silently treating fix mode as off.
  if (sessionState._corrupt) {
    logOne({ payload, repoRoot, level, rule: 'h04-test-lock', cls: CLASS.A, decision: 'deny', started, detail: 'state-corrupt' });
    return emitDeny(EVENT, block({
      title: 'session state unreadable',
      policy: 'the fix-mode test lock cannot be verified, and a lock that cannot be verified is not a lock',
      id: 'P39', lesson: 8,
      attempted: `${tool} ${relPath ?? absPath ?? '(unknown)'}`,
      why: 'the plugin state file for this session is present but not valid JSON',
      route: 'run /ai-native-sdlc:sdlc-doctor, which repairs the state file, then retry',
      gate: 'always-hard (fail-closed)',
    }));
  }

  const ctx = {
    event: EVENT,
    tool,
    toolInput,
    level,
    cfg,
    user,
    configured,
    repoRoot,
    repoKey,
    absPath,
    relPath,
    pathField: target.field,
    pathUnderstood: target.understood,
    content,
    outgoing: outgoingContent(toolInput),
    state: sessionState,
    agentType: payload.agent_type ?? null,
    branch: currentBranch(repoRoot),
    configErrors: errors,
  };

  const logs = [];
  const outcome = runRules(fileRules, ctx, (e) => logs.push(e));

  for (const e of logs) {
    record({
      hook: 'pre-file', event: EVENT, tool, level,
      rule: e.rule, cls: e.cls, decision: e.verdict, hard: e.cls === CLASS.A,
      session: payload.session_id, agent: ctx.agentType, repoKey,
      file: relPath, duration_ms: e.duration_ms, detail: e.detail,
    });
  }

  if (outcome.action === 'deny') return emitDeny(EVENT, outcome.message);
  if (outcome.action === 'warn') return emitWarn(EVENT, outcome.message);
  return emitAllow();
}

function logOne({ payload, repoRoot, level, rule, cls, decision, started, detail }) {
  record({
    hook: 'pre-file', event: EVENT, tool: payload.tool_name, level,
    rule, cls, decision, hard: cls === CLASS.A,
    session: payload.session_id, agent: payload.agent_type ?? null,
    repoKey: repoRoot, duration_ms: Date.now() - started, detail,
  });
}

main().catch(() => {
  // The dispatcher itself failed. Every rule it hosts is Class A, and a Class A
  // gate that cannot run must not allow the write: on native Windows there is
  // no sandbox behind it. Deny with an explanation and a route out.
  emitDeny(EVENT, block({
    title: 'file policy gate could not run',
    policy: 'safety-critical gates fail closed, because on some platforms they are the only enforcement layer',
    id: 'R2', lesson: 11,
    attempted: 'file write',
    why: 'the ai-native-sdlc pre-file dispatcher threw before reaching a decision',
    route: 'run /ai-native-sdlc:sdlc-doctor for diagnostics; a human can set hard_hooks_locked=false '
         + 'to unblock temporarily, which is recorded in the decision ledger',
    gate: 'always-hard (fail-closed)',
  }));
});
