/**
 * Block and warning message construction.
 *
 * Lesson 11, step 4: "A block should explain itself, so when a hook stops an
 * action, the reason and the route to approval appear in Claude's output."
 *
 * That makes the message part of the control, not decoration. Every block says
 * the same six things in the same order so an engineer can read it at a glance
 * and Claude can act on it without guessing:
 *
 *   1 what was blocked
 *   2 which policy, with its playbook id and lesson so it can be looked up
 *   3 what exactly was attempted (never the secret itself)
 *   4 the deterministic fact that triggered it
 *   5 the concrete route forward — who, and what to do
 *   6 whether this gate is negotiable
 *
 * Messages are English by design: they are read by Claude, they land in
 * transcripts and audit exports, and the surrounding documentation carries the
 * localised explanation.
 */

const PREFIX = '[ai-native-sdlc]';

/**
 * @param {object} o
 * @param {string} o.title      short rule title, e.g. "production deploy without release authorization"
 * @param {string} o.policy     one sentence, in the course's own terms
 * @param {string} o.id         playbook policy id, e.g. "P58"
 * @param {number|string} o.lesson  lesson number
 * @param {string} o.attempted  tool + redacted target
 * @param {string} o.why        the deterministic fact
 * @param {string} o.route      how to proceed
 * @param {string} o.gate       "always-hard" | "level=standard" | ...
 * @param {string} [o.note]     optional extra line (e.g. the weak-approval caveat)
 * @param {string} [o.policyUrl] optional organization policy link
 */
export function block({ title, policy, id, lesson, attempted, why, route, gate, note, policyUrl }) {
  const lines = [
    `${PREFIX} BLOCKED — ${title}`,
    `Policy: ${policy} (Playbook ${id}, Lesson ${lesson})`,
    `Attempted: ${attempted}`,
    `Why: ${why}`,
    `Route: ${route}`,
    `Gate: ${gate}`,
  ];
  if (note) lines.push(`Note: ${note}`);
  if (policyUrl) lines.push(`Policy source: ${policyUrl}`);
  return lines.join('\n');
}

/**
 * The same content as a non-blocking warning.
 *
 * Phrased as a statement of fact rather than an instruction: text injected as
 * additionalContext is wrapped in a system reminder, and imperative phrasing
 * there can trip Claude's prompt-injection defences.
 */
export function advise({ title, policy, id, lesson, attempted, why, route, wouldBlockAt }) {
  const lines = [
    `${PREFIX} ADVISORY — ${title}`,
    `Policy: ${policy} (Playbook ${id}, Lesson ${lesson})`,
    `Observed: ${attempted}`,
    `Why: ${why}`,
    `Suggested: ${route}`,
  ];
  if (wouldBlockAt) {
    lines.push(`This is a warning at the current enforcement level; it blocks at ${wouldBlockAt}.`);
  }
  return lines.join('\n');
}

/**
 * Redact a shell command for display: keep the shape, drop anything that looks
 * like a credential. A block message that echoes the secret it just stopped
 * from entering the diff would defeat its own purpose.
 */
export function redactCommand(cmd, max = 160) {
  if (typeof cmd !== 'string') return '(no command)';
  let s = cmd
    .replace(/(--?(?:password|token|secret|key|auth)[= ])\S+/gi, '$1***')
    .replace(/\b(A?K[A-Z0-9]{8,})\b/g, '***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,})\b/g, '***')
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,})\b/g, '***');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A file reference for the "Attempted:" line: repo-relative where possible. */
export function describeTarget(tool, relPath, absPath) {
  const p = relPath || absPath || '(unknown path)';
  return `${tool} ${p}`;
}
