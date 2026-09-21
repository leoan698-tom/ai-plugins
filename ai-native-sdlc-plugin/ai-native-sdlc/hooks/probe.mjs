/**
 * Phase 0 probe hook — records the REAL shape of every hook invocation.
 *
 * Purpose: the plan lists six assumptions the official docs do not confirm.
 * This script answers A, B, C and E empirically by recording, for every event
 * it is registered on:
 *   - the complete stdin JSON (so tool_input / tool_response shapes are captured
 *     verbatim for MultiEdit, NotebookEdit, PowerShell and ExitPlanMode)
 *   - which CLAUDE_PLUGIN_OPTION_* variables actually reach the hook process,
 *     including whether a `sensitive: true` userConfig value is among them
 *   - the plugin path placeholders as the runtime substituted them
 *
 * It NEVER blocks: it always exits 0 and prints nothing on stdout, so it is
 * safe to leave registered while probing. Recording failures are swallowed.
 *
 * Output: ${CLAUDE_PLUGIN_DATA}/probe/probe.jsonl (one JSON object per call)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const label = process.argv[2] ?? 'unlabelled';

/** Read all of stdin. Returns '' when stdin is closed or empty. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Record which plugin option variables are present and whether each has a
 * value. Values themselves are NOT recorded: one of them is deliberately
 * declared `sensitive: true`, and writing it to a log file would defeat the
 * point of the probe. Presence plus length is what assumption B needs.
 */
function optionEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) {
      out[k] = { present: true, empty: v === '', length: v == null ? null : v.length };
    }
  }
  return out;
}

try {
  const raw = await readStdin();
  let parsed = null;
  let parseError = null;
  try {
    parsed = raw.trim() === '' ? null : JSON.parse(raw);
  } catch (err) {
    parseError = String(err && err.message);
  }

  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  // Fall back to the OS temp dir so the probe still records something when
  // CLAUDE_PLUGIN_DATA is not exported — itself a finding worth having.
  const baseDir = dataDir || join(process.env.TEMP || process.env.TMPDIR || '.', 'ai-native-sdlc-probe');
  const dir = join(baseDir, 'probe');
  mkdirSync(dir, { recursive: true });

  const record = {
    ts: new Date().toISOString(),
    label,
    // Assumption A/C/E: the verbatim payload.
    stdin_raw_length: raw.length,
    stdin_parse_error: parseError,
    stdin: parsed,
    // Convenience projections so the findings are greppable without jq.
    event: parsed?.hook_event_name ?? null,
    tool: parsed?.tool_name ?? null,
    tool_input_keys: parsed?.tool_input ? Object.keys(parsed.tool_input) : null,
    tool_response_keys:
      parsed?.tool_response && typeof parsed.tool_response === 'object'
        ? Object.keys(parsed.tool_response)
        : parsed?.tool_response === undefined
          ? null
          : typeof parsed.tool_response,
    // Assumption B: does a sensitive userConfig value reach the hook process?
    plugin_options: optionEnv(),
    // Placeholder substitution as the runtime performed it.
    env_paths: {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
    },
    argv_after_script: process.argv.slice(2),
    platform: process.platform,
    node: process.version,
  };

  appendFileSync(join(dir, 'probe.jsonl'), JSON.stringify(record) + '\n', 'utf8');
} catch {
  // A probe must never break the session it is observing.
}

// Always allow. No stdout: anything printed here would be parsed as a decision.
process.exit(0);
