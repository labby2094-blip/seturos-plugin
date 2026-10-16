'use strict';

// seturos-hook-codex.cjs — Codex's sessions, filed the way Claude Code's are. PURE except `listRollouts`.
//
// Codex keeps every conversation as a JSONL "rollout" under ~/.codex/sessions/YYYY/MM/DD/, headed by a session_meta
// entry that says where it ran (cwd, and git when the folder is a repository). Nothing read them, so work done in
// Codex was invisible to every other tool: switching from Codex to Claude Code — or to Cursor — started from nothing,
// while the reverse direction worked. Its one notify slot is already taken (Codex's own computer-use helper), so this
// does not hook Codex at all. It READS the files Codex already writes, from whichever Seturos side runs next: the
// Claude Code hooks at every session start in the same repository, or `capture-codex` from a terminal or a schedule.
//
// What a stretch is, and what is kept, matches the Claude Code reader (seturos-hook-transcript.cjs): the person's and
// the agent's words, the commands the agent ran and the head of what they printed, a `compacted` entry as a stretch
// boundary, the same budgets (finishStretch), and the same sealed-material rule — a command that reads an evaluation's
// answer key ends what is kept of the session, so Codex cannot carry the answers into the next tool either.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finishStretch, edgeLines, MAX_EVIDENCE_CHARS } = require('./seturos-hook-transcript.cjs');
const sealed = require('./seturos-hook-sealed.cjs');

function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

/** PURE: the text of a Codex message's content parts. */
function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && typeof p.text === 'string' && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text'))
    .map((p) => p.text)
    .join('\n');
}

/**
 * PURE: what Codex put in the person's mouth that they did not say — its environment block, the AGENTS.md it loaded,
 * its user-instructions wrapper. A user message that is ONLY that is not a turn at all.
 */
const INJECTED_BLOCKS = ['environment_context', 'user_instructions', 'recommended_plugins', 'apps_instructions', 'skills_instructions', 'collaboration_mode', 'permissions instructions'];

function withoutCodexInjected(text) {
  let out = String(text || '').replace(/# AGENTS\.md instructions for [^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '');
  out = out.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '');
  for (const tag of INJECTED_BLOCKS) {
    const t = tag.replace(/ /g, '\\s');
    out = out.replace(new RegExp(`<${t}>[\\s\\S]*?<\\/${t}>`, 'g'), '');
  }
  return out.trim();
}

/**
 * PURE: is this a conversation the PERSON had? Codex runs its own sub-sessions and writes them as rollouts too — an
 * approval "guardian" that reviews each risky command (thread_source "guardian_review", a subagent source, a parent
 * thread). Filing those would put Codex's reviewer in the person's mouth. A sub-agent's findings reach the parent
 * conversation anyway, so only top-level, person-started threads are kept.
 */
function isPersonsSession(meta) {
  if (!meta) return false;
  if (meta.parent_thread_id) return false;
  if (meta.source && typeof meta.source === 'object' && meta.source.subagent) return false;
  return typeof meta.thread_source !== 'string' || meta.thread_source === 'user';
}

/** PURE: the shell commands inside Codex Desktop's `exec` tool, whose input is a script calling tools.exec_command. */
function commandsIn(script) {
  const out = [];
  for (const m of String(script || '').matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) {
    const quoted = m[1];
    try { out.push(quoted[0] === '"' ? JSON.parse(quoted) : quoted.slice(1, -1)); } catch { out.push(quoted.slice(1, -1)); }
  }
  return out;
}

/** PURE: the command a plain function call ran — the CLI's `shell` / `exec_command` shapes — or null. */
function commandOfCall(payload) {
  let args = payload.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object') return null;
  if (typeof args.cmd === 'string') return args.cmd;
  if (typeof args.command === 'string') return args.command;
  if (Array.isArray(args.command)) return args.command.join(' ');
  return null;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
  if (output && typeof output === 'object' && typeof output.output === 'string') return output.output;
  return '';
}

/**
 * PURE: a rollout → `{ meta, segments: [{ segment, turns }] }`. `meta` is the session_meta payload (id, cwd, git);
 * `turns` are what /api/uml/capture takes, shaped and capped by finishStretch exactly as a Claude Code stretch is.
 */
/** The test's stand-in disk, when it gave one — `exists`, `list`, `readFile` — else the real one. */
const diskOf = (opts) => Object.fromEntries(['exists', 'list', 'readFile'].filter((k) => opts[k]).map((k) => [k, opts[k]]));

function parseRollout(jsonl, opts = {}) {
  const segments = [];
  let turns = [];
  let meta = null;
  let check = opts.check || null;
  let tainted = null;
  const sealedCalls = new Set();
  const watched = new Map(); // call id → the sealed paths it named without reading; its output is checked against them

  const lastAssistant = () => {
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant') return last;
    const fresh = { role: 'assistant', text: '', written: [], output: [] };
    turns.push(fresh);
    return fresh;
  };

  for (const line of String(jsonl).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'session_meta' && entry.payload) {
      meta = entry.payload;
      if (!check) check = sealed.sealedCheck({ cwd: meta.cwd || process.cwd(), ...diskOf(opts) });
      continue;
    }
    // Codex shortened its own context here. Like a Claude Code compaction, it is where one stretch ends — and after
    // sealed material was read, only the boundary is kept, so each stretch filed before is replaced by the stub.
    if (entry.type === 'compacted') {
      segments.push(turns);
      turns = tainted ? [{ role: 'assistant', text: sealed.stubText(tainted), written: [], output: [] }] : [];
      continue;
    }
    if (entry.type !== 'response_item' || !entry.payload || tainted) continue;
    const p = entry.payload;
    if (!check) check = sealed.sealedCheck({ cwd: process.cwd(), ...diskOf(opts) });

    if (p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') continue; // developer / system: Codex's own instructions
      const raw = textParts(p.content);
      const text = (p.role === 'user' ? withoutCodexInjected(raw) : raw).trim();
      if (text === '') continue;
      const last = turns[turns.length - 1];
      if (last && last.role === p.role) last.text = last.text === '' ? text : `${last.text}\n\n${text}`;
      else turns.push({ role: p.role, text, written: [], output: [] });
      continue;
    }

    if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const commands = p.type === 'custom_tool_call' ? commandsIn(p.input) : [commandOfCall(p)].filter((c) => typeof c === 'string');
      const touches = commands.map((c) => check.commandTouch(c));
      const read = (touches.find((t) => t.read) || {}).read;
      const named = touches.flatMap((t) => t.named);
      if (!read && named.length > 0 && p.call_id) watched.set(p.call_id, named);
      if (read) {
        tainted = read;
        if (p.call_id) sealedCalls.add(p.call_id);
        turns.push({ role: 'assistant', text: sealed.stubText(read), written: [], output: [] });
        continue;
      }
      const shown = commands.length > 0
        ? commands.map((c) => `$ ${c}`)
        : [`$ ${p.name || p.type} ${String(p.arguments || p.input || '').slice(0, 300)}`];
      lastAssistant().output.push(...shown);
      continue;
    }

    if (/_output$/.test(p.type || '')) {
      if (p.call_id && sealedCalls.has(p.call_id)) continue;
      const out = outputText(p.output);
      if (out === '') continue;
      // A search that printed lines from inside a sealed file has read it, whatever its command named — and so has a
      // command that only named one, when what it printed carries that file's own lines (seturos-hook-sealed.cjs).
      const hit = out.split('\n').map((l) => check.sealedLine(l)).find((h) => h && h.grepContent);
      const leaked = !hit && p.call_id && watched.has(p.call_id) ? check.showsContentOf(watched.get(p.call_id), out) : null;
      if (hit || leaked) {
        tainted = leaked || check.shown(hit.path);
        turns.push({ role: 'assistant', text: sealed.stubText(tainted), written: [], output: [] });
        continue;
      }
      lastAssistant().output.push(edgeLines(out, MAX_EVIDENCE_CHARS));
    }
  }
  segments.push(turns);
  return {
    meta,
    segments: segments
      .map((raw, segment) => ({ segment, turns: finishStretch(raw) }))
      .filter((s) => s.turns.some((t) => t.role === 'user' && t.text !== '') || sealed.isSealedStub(s.turns)),
  };
}

/** PURE: the repository a rollout ran in, from its own git record, else from the folder (`repoKeyForDir`). */
function repoOfRollout(meta, { repoKeyFrom, repoKeyForDir }) {
  if (!meta) return null;
  const url = meta.git && (meta.git.repository_url || meta.git.remote_url);
  const fromMeta = typeof url === 'string' && url ? repoKeyFrom(url) : null;
  if (fromMeta) return fromMeta;
  return typeof meta.cwd === 'string' && meta.cwd && fs.existsSync(meta.cwd) ? repoKeyForDir(meta.cwd) : null;
}

/** The rollouts changed in the last `days`, newest first — `{ file, mtimeMs, size }`. */
function listRollouts(env = process.env, days = 3, now = Date.now()) {
  const root = path.join(codexHome(env), 'sessions');
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs <= days * 24 * 3600 * 1000) out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished between listing and stat */ }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = { parseRollout, repoOfRollout, listRollouts, isPersonsSession, commandsIn, withoutCodexInjected, textParts, codexHome };
