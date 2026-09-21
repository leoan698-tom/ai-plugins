/**
 * Credential detection for content about to enter the diff (Lesson 6: "keep
 * credentials out of the diff").
 *
 * Two rules govern this module:
 *
 * 1. **Never return the matched value.** A block message that echoes the secret
 *    it just stopped would put it in the transcript, the ledger and any audit
 *    export — the exact places the gate exists to keep it out of. Findings carry
 *    the pattern name and a line number only.
 * 2. **Placeholders are not secrets.** `API_KEY = "<your-key>"` is what correct
 *    code looks like. Flagging it trains people to disable the gate, and the
 *    course is explicit that prompt fatigue is how a control gets switched off.
 */

const PATTERNS = [
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    // Generic assignment: a credential-ish name bound to a long opaque literal.
    name: 'credential-assignment',
    re: /\b(?:api[_-]?key|secret|password|passwd|pwd|token|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'`]([^"'`\n]{16,})["'`]/gi,
    captureGroup: 1,
  },
];

/** Values that look like secrets but are the correct thing to write. */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|change[_-]?me|your[_-].*|my[_-].*|example.*|sample.*|dummy|placeholder|redacted|todo|tbd|null|none|test|fake.*|insert[_-].*)$/i;

/** A long literal with no entropy is not a secret (e.g. "aaaaaaaaaaaaaaaa"). */
function looksRandom(s) {
  if (s.length < 16) return false;
  const distinct = new Set(s).size;
  if (distinct < 6) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  return classes >= 2;
}

function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (PLACEHOLDER.test(v)) return true;
  if (/^(?:process\.env|os\.environ|ENV\[|System\.getenv)/.test(v)) return true;
  return false;
}

/**
 * Scan text for credentials.
 * @returns {{pattern: string, line: number}[]} findings — never the value itself
 */
export function scan(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];

  for (const { name, re, captureGroup } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = captureGroup ? m[captureGroup] : m[0];
      if (isPlaceholder(value)) continue;
      // The generic pattern needs an entropy check; the specific ones are
      // already shaped tightly enough that any match is a real key format.
      if (captureGroup && !looksRandom(value)) continue;

      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ pattern: name, line });
      if (findings.length >= 10) return findings; // enough to report
      if (m[0].length === 0) re.lastIndex++;      // guard against zero-width loops
    }
  }
  return findings;
}

/** Scan several strings, keeping only the distinct pattern/line pairs. */
export function scanAll(strings) {
  const out = [];
  const seen = new Set();
  for (const s of strings ?? []) {
    for (const f of scan(s)) {
      const key = `${f.pattern}:${f.line}`;
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
  }
  return out;
}

/** Human-readable finding summary. Contains no secret material by construction. */
export function describe(findings) {
  return findings.map((f) => `${f.pattern} at line ${f.line}`).join(', ');
}

export const patternNames = PATTERNS.map((p) => p.name);
