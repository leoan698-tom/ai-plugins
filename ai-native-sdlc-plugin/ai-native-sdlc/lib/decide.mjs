/**
 * Decision protocol and the dispatcher runner.
 *
 * Two facts from the documentation shape everything here:
 *
 * 1. **Only exit 2 blocks.** Exit 1, exit 127 (interpreter missing) and an
 *    unhandled exception are all *non-blocking* errors: the tool call proceeds.
 *    So a crash is not a safe default — it is a silent bypass. Every rule runs
 *    inside a try/catch and its CLASS decides what a crash means.
 *
 * 2. **stdout must contain exactly one JSON object and nothing else.** If the
 *    combined stdout does not start with `{`, the runtime treats it as plain
 *    text and silently ignores the decision. Nothing in this plugin may
 *    `console.log` outside `emit()`.
 *
 * Class model (the plan's central idea): the enforcement level is an adoption
 * dial over hygiene, never over safety.
 *
 *   A — always hard. Ignores enforcement_level. FAILS CLOSED on internal error,
 *       because on native Windows there is no sandbox underneath these hooks:
 *       they are the only layer, so a crashed credential scanner that allows the
 *       write has no second line behind it.
 *   B — level-dependent. Blocks at standard/strict, warns at advisory.
 *       Fails open with a visible warning.
 *   C — hygiene. Warns at standard, blocks only at strict. Fails open.
 */

export const CLASS = { A: 'A', B: 'B', C: 'C' };

export const VERDICT = {
  ALLOW: 'allow',
  DENY: 'deny',
  WARN: 'warn',
  NOT_APPLICABLE: 'n/a',
};

/** A rule result. `msg` is the already-built six-line message. */
export const allow = () => ({ verdict: VERDICT.ALLOW });
export const notApplicable = () => ({ verdict: VERDICT.NOT_APPLICABLE });
export const deny = (msg, detail) => ({ verdict: VERDICT.DENY, msg, detail });
export const warn = (msg, detail) => ({ verdict: VERDICT.WARN, msg, detail });

const MAX_INJECTED = 9500; // documented cap is 10,000; leave headroom.

function clip(s) {
  if (typeof s !== 'string') return '';
  return s.length <= MAX_INJECTED ? s : s.slice(0, MAX_INJECTED - 20) + '\n… (truncated)';
}

/**
 * Write the single JSON object the runtime will read, then exit 0.
 *
 * Exit 0 with JSON is used rather than exit 2 with stderr because the JSON form
 * carries a structured reason field, and for PreToolUse the reason is the only
 * variant Claude actually sees.
 */
export function emit(payload) {
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch {
    // If serialising fails there is nothing safe left to say; stay silent
    // rather than emitting half an object that would be read as plain text.
  }
  process.exit(0);
}

/** Allow without saying anything. The overwhelmingly common path. */
export function emitAllow() {
  process.exit(0);
}

/** Deny a tool call. `reason` reaches Claude; `event` must match the hook event. */
export function emitDeny(event, reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: clip(reason),
    },
  });
}

/**
 * Warn without blocking. `systemMessage` is shown to the user; the same text goes
 * to Claude as additionalContext, phrased as a statement rather than an order so
 * it does not read as an injected instruction.
 */
export function emitWarn(event, message) {
  emit({
    systemMessage: clip(message),
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: clip(message),
    },
  });
}

/** Stop and SubagentStop use a top-level decision, not hookSpecificOutput. */
export function emitStopBlock(reason) {
  emit({ decision: 'block', reason: clip(reason) });
}

/** Non-error feedback at Stop: the turn continues and the text is not an error. */
export function emitStopContext(event, message) {
  emit({
    hookSpecificOutput: { hookEventName: event, additionalContext: clip(message) },
  });
}

/** Context injection for SessionStart / SubagentStart. */
export function emitContext(event, message) {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: clip(message) } });
}

/**
 * Should this class block at this level?
 * Class A ignores the level entirely — that is what makes it Class A.
 */
export function blocksAt(ruleClass, level) {
  if (ruleClass === CLASS.A) return true;
  if (ruleClass === CLASS.B) return level === 'standard' || level === 'strict';
  if (ruleClass === CLASS.C) return level === 'strict';
  return false;
}

/**
 * Run rules in order and return the first decision that should be acted on.
 * First deny short-circuits: the remaining rules are not evaluated, which keeps
 * the inner loop inside its latency budget.
 *
 * @param rules  [{ id, policy, lesson, class, evaluate(ctx) }]
 * @param ctx    the shared evaluation context
 * @param onLog  (entry) => void, called once per rule that produced a verdict
 */
export function runRules(rules, ctx, onLog) {
  const warnings = [];

  for (const rule of rules) {
    const started = Date.now();
    let result;
    try {
      result = rule.evaluate(ctx) ?? notApplicable();
    } catch (err) {
      result = onRuleError(rule, err);
    }

    const duration = Date.now() - started;

    if (result.verdict === VERDICT.NOT_APPLICABLE || result.verdict === VERDICT.ALLOW) {
      continue;
    }

    onLog?.({
      rule: rule.id,
      cls: rule.class,
      verdict: result.verdict,
      detail: result.detail ?? null,
      duration_ms: duration,
    });

    const willBlock = blocksAt(rule.class, ctx.level);

    if (result.verdict === VERDICT.DENY && willBlock) {
      return { action: 'deny', rule, message: result.msg };
    }
    // A deny from a class that does not block at this level degrades to a
    // warning, and the message says which level would have blocked it.
    warnings.push(result.msg);
  }

  if (warnings.length) return { action: 'warn', message: warnings.join('\n\n') };
  return { action: 'allow' };
}

/**
 * A rule threw. What that means depends on its class — this is the deliberate
 * inversion of the usual blanket fail-open.
 */
function onRuleError(rule, err) {
  const why = String(err?.message ?? err).slice(0, 300);
  if (rule.class === CLASS.A) {
    return deny(
      [
        `[ai-native-sdlc] BLOCKED — ${rule.id} could not be evaluated`,
        `Policy: ${rule.policy ?? 'safety-critical gate'} (Playbook ${rule.lesson ?? '—'})`,
        `Why: the check itself failed: ${why}`,
        'This gate is always-hard, so an evaluation failure denies rather than allows:',
        'on native Windows there is no sandbox beneath these hooks, so allowing on error',
        'would leave no second line of defence.',
        'Route: report this as a plugin bug with the message above; the human can set',
        'hard_hooks_locked=false temporarily to unblock, which is recorded in the ledger.',
        'Gate: always-hard (fail-closed).',
      ].join('\n'),
      `rule-error:${why}`,
    );
  }
  // Class B/C: a broken hygiene check must not stop work.
  return warn(
    `[ai-native-sdlc] ${rule.id} could not be evaluated and was skipped: ${why}`,
    `rule-error:${why}`,
  );
}

/** Read all of stdin as text. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse the hook payload. A malformed payload is a hard fact, not a guess. */
export async function readPayload() {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}
