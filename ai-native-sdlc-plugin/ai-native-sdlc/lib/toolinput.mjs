/**
 * Extracting the path and the incoming content from `tool_input`.
 *
 * This module exists because of a Phase 0 finding that is a silent-bypass bug
 * if you get it wrong (see docs/phase-0-findings.md):
 *
 *   FileEditInput      { file_path, old_string, new_string, replace_all? }
 *   FileWriteInput     { file_path, content }
 *   NotebookEditInput  { notebook_path, cell_id?, new_source, cell_type?, edit_mode? }
 *
 * `NotebookEdit` carries **notebook_path**, not `file_path`, and its content is
 * **new_source**, not `content`/`new_string`. A gate that reads only
 * `tool_input.file_path` sees `undefined` for every notebook edit and allows it.
 *
 * `MultiEdit` has no published schema at all (the name exists in the CLI binary
 * but not in the SDK types), so nothing here assumes an `edits[]` array. When a
 * shape cannot be understood, callers are told so explicitly and the configured
 * `unparseable_tool_input` policy decides — it defaults to deny, so an
 * undocumented future shape fails closed.
 */

/** Tool names whose input describes a file write of some kind. */
export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Tool names that run a shell command. `PowerShell` shares Bash's input shape. */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * The absolute path a file tool is about to touch.
 * @returns {{path: string|null, field: string|null, understood: boolean}}
 */
export function targetPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return { path: null, field: null, understood: false };
  }
  if (typeof toolInput.file_path === 'string' && toolInput.file_path) {
    return { path: toolInput.file_path, field: 'file_path', understood: true };
  }
  // NotebookEdit. Missing this branch is the silent bypass described above.
  if (typeof toolInput.notebook_path === 'string' && toolInput.notebook_path) {
    return { path: toolInput.notebook_path, field: 'notebook_path', understood: true };
  }
  // Last resort for an undocumented shape: a single unambiguous path-looking
  // string. Reported as NOT understood so the caller applies its fail policy.
  const found = deepFindPaths(toolInput);
  if (found.length === 1) return { path: found[0], field: 'inferred', understood: false };
  return { path: null, field: null, understood: false };
}

/**
 * Every string the tool is about to introduce into a file, for content scanning
 * (credentials, skip annotations). Returns the NEW content only — `old_string`
 * is what is being removed and scanning it would flag secrets being deleted.
 * @returns {{strings: string[], understood: boolean}}
 */
export function incomingContent(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return { strings: [], understood: false };

  const out = [];
  let understood = false;

  if (typeof toolInput.content === 'string') { out.push(toolInput.content); understood = true; }
  if (typeof toolInput.new_string === 'string') { out.push(toolInput.new_string); understood = true; }
  // NotebookEdit cell body.
  if (typeof toolInput.new_source === 'string') { out.push(toolInput.new_source); understood = true; }

  // Defensive: an undocumented batch shape. Collect its new-side strings rather
  // than assuming the array is absent, but do not claim to have understood it.
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e && typeof e === 'object') {
        for (const k of ['new_string', 'new_source', 'content']) {
          if (typeof e[k] === 'string') out.push(e[k]);
        }
      }
    }
  }

  if (out.length === 0) {
    // Nothing recognised: walk the object so a scanner still sees the payload.
    const walked = deepStrings(toolInput, ['old_string', 'file_path', 'notebook_path', 'description']);
    return { strings: walked, understood: false };
  }
  return { strings: out, understood };
}

/** The content being replaced, used to tell "added a skip marker" from "it was already there". */
export function outgoingContent(toolInput) {
  const out = [];
  if (toolInput && typeof toolInput.old_string === 'string') out.push(toolInput.old_string);
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) {
      if (e && typeof e.old_string === 'string') out.push(e.old_string);
    }
  }
  return out;
}

/** The shell command a Bash/PowerShell call is about to run. */
export function shellCommand(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

/** Collect strings that look like absolute filesystem paths. */
function deepFindPaths(obj, depth = 0) {
  const out = [];
  if (depth > 4 || !obj || typeof obj !== 'object') return out;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') {
      if (/^([A-Za-z]:[\\/]|\/)/.test(v) && v.length < 4096) out.push(v);
    } else if (typeof v === 'object') {
      out.push(...deepFindPaths(v, depth + 1));
    }
  }
  return [...new Set(out)];
}

/** Collect every string value except the named keys. Bounded to stay fast. */
function deepStrings(obj, skipKeys = [], depth = 0) {
  const out = [];
  if (depth > 4 || !obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (skipKeys.includes(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'object') out.push(...deepStrings(v, skipKeys, depth + 1));
  }
  return out;
}
