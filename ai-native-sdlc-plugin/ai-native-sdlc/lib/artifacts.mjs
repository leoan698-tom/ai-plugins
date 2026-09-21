/**
 * Artifact structure validation for intent.md, spec.md and plan.md.
 *
 * The playbook's whole shape rests on these three files carrying specific
 * sections — "plan.md names which files change, the order of work, the risks and
 * the tests that prove it" is only enforceable because the sections are named.
 *
 * **Headings are matched through a bilingual alias table.** The course material
 * is Chinese and its templates are English, so a schema that matches English
 * level-2 headings literally would reject a perfectly well-formed
 * Chinese-language intent.md for "missing Problem / Constraints / Open
 * questions". A false denial on the most frequently used gate, on day one, is
 * how a team decides the plugin is broken and switches it off.
 *
 * The table is extensible from repo config, so an organisation whose templates
 * already use different words maps them once instead of forking the plugin.
 */

/**
 * Required sections per artifact. Each entry is a canonical key plus the
 * headings that satisfy it. Matching is case-insensitive and ignores
 * punctuation, numbering and surrounding whitespace.
 */
export const SCHEMAS = {
  'intent.md': {
    lesson: 2,
    policy: 'intent.md records the problem, the proposed outcome, who and what it touches, the constraints and the open questions',
    id: 'P03',
    sections: {
      problem: ['problem', 'the problem', '问题', '背景'],
      outcome: ['proposed outcome', 'outcome', 'proposal', '提议的结果', '预期结果', '目标'],
      affected: ['affected users and systems', 'affected', 'users and systems', 'impact', '受影响的用户和系统', '受影响方', '影响范围'],
      constraints: ['constraints', 'constraint', '约束', '限制'],
      open_questions: ['open questions', 'questions', 'unknowns', '开放问题', '待定问题', '未决问题'],
    },
  },
  'spec.md': {
    lesson: 3,
    policy: 'spec.md states clearly any areas of concern, especially where contradicting policies cannot all be satisfied',
    id: 'P07',
    sections: {
      concerns: ['concerns', 'areas of concern', 'open concerns', 'risks and concerns', '关注点', '风险与关注点', '待解决的冲突'],
    },
  },
  'plan.md': {
    lesson: 4,
    policy: 'plan.md names which files change, the order of work, the risks, and the tests that prove it',
    id: 'P12',
    sections: {
      files: ['files that change', 'files changed', 'files', 'changed files', '涉及的文件', '会改动的文件', '变更文件'],
      order: ['order of work', 'order', 'steps', 'work order', 'implementation order', '工作顺序', '实施顺序', '步骤'],
      risks: ['risks', 'risk', '风险'],
      proof: ['proof', 'verification', 'tests', 'how it is proven', '证明', '验证'],
    },
    // Required only at the strictest level: it is the output of the Lesson 4
    // interrogation step, which is a practice rather than a structural fact.
    strictSections: {
      alternatives: ['alternatives considered', 'alternatives', 'rejected options', '备选方案', '考虑过的替代方案'],
    },
  },
};

/** Normalise a heading for comparison: drop markers, numbering, punctuation, case. */
function normaliseHeading(text) {
  return String(text)
    .replace(/^#+\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/[:：.。!！?？*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** All level-2 (and deeper) headings present in a markdown document. */
export function headings(markdown) {
  const out = [];
  for (const line of String(markdown ?? '').split('\n')) {
    const m = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, raw: m[2], key: normaliseHeading(m[2]) });
  }
  return out;
}

/** Merge the built-in aliases with any the repository added. */
function aliasesFor(schema, overrides, artifact) {
  const extra = overrides?.[artifact] ?? {};
  const merged = {};
  for (const [key, list] of Object.entries(schema)) {
    merged[key] = [...list, ...(extra[key] ?? [])].map(normaliseHeading);
  }
  return merged;
}

/**
 * Validate one artifact.
 * @returns {{ok: boolean, artifact: string, missing: string[], present: string[], detail: string}}
 */
export function validate(artifactName, markdown, { level = 'standard', aliasOverrides = null } = {}) {
  const name = String(artifactName).toLowerCase();
  const schema = SCHEMAS[name];
  if (!schema) return { ok: true, artifact: name, missing: [], present: [], detail: 'no schema' };

  const found = headings(markdown).map((h) => h.key);
  const required = aliasesFor(schema.sections, aliasOverrides, name);
  if (level === 'strict' && schema.strictSections) {
    Object.assign(required, aliasesFor(schema.strictSections, aliasOverrides, name));
  }

  const missing = [];
  const present = [];
  for (const [key, aliases] of Object.entries(required)) {
    const hit = found.some((f) => aliases.some((a) => f === a || f.startsWith(a + ' ') || f.includes(a)));
    (hit ? present : missing).push(key);
  }

  // plan.md's "Files that change" must actually list something: a heading with
  // no paths under it satisfies the letter of the rule and none of its purpose.
  let detail = '';
  if (name === 'plan.md' && present.includes('files')) {
    const listed = filesThatChange(markdown, aliasOverrides);
    if (listed.length === 0) {
      missing.push('files (section present but lists no paths)');
      detail = 'files-section-empty';
    }
  }

  return {
    ok: missing.length === 0,
    artifact: name,
    missing,
    present,
    detail: detail || (missing.length ? `missing:${missing.join('+')}` : 'ok'),
    schema,
  };
}

/**
 * Paths named under plan.md's "Files that change".
 * This list is what the plan/implementation synchronisation gate compares a
 * commit against, and what Lesson 7 uses to decide which tasks can run in
 * parallel, so it is parsed rather than merely checked for existence.
 */
export function filesThatChange(markdown, aliasOverrides = null) {
  const lines = String(markdown ?? '').split('\n');
  const aliases = aliasesFor({ files: SCHEMAS['plan.md'].sections.files }, aliasOverrides, 'plan.md').files;

  let inSection = false;
  const out = [];
  for (const line of lines) {
    const h = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const key = normaliseHeading(h[2]);
      inSection = aliases.some((a) => key === a || key.includes(a));
      continue;
    }
    if (!inSection) continue;
    if (!line.trim()) continue;

    // Accept bullets, inline code, comma-separated prose — all forms the
    // course's own example uses.
    const cleaned = line.replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '');
    for (const m of cleaned.matchAll(/`([^`]+)`/g)) out.push(m[1]);
    if (!cleaned.includes('`')) {
      for (const token of cleaned.split(/[,;]|\s{2,}/)) {
        const t = token.trim().replace(/\s*\(new\)\s*$/i, '');
        if (/^[\w./@-]+\/[\w./@-]+$/.test(t) || /^[\w.@-]+\.[a-z0-9]{1,8}$/i.test(t)) out.push(t);
      }
    }
  }
  return [...new Set(out.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')))];
}

/** Which artifact, if any, a path represents. */
export function artifactKind(relPath) {
  const base = String(relPath ?? '').split('/').pop()?.toLowerCase();
  return base && SCHEMAS[base] ? base : null;
}
