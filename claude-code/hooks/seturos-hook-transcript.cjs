'use strict';

// SETUROS × CLAUDE CODE — a transcript (JSONL) → the conversation as turns, per stretch between compactions. PURE.
// Loaded by seturos-compact-hook.cjs; copied beside it by the installer.

const sealed = require('./seturos-hook-sealed.cjs');

const MAX_TURNS = 300; // the capture route accepts 400
const MAX_TURN_CHARS = 12000;
const MAX_EVIDENCE_CHARS = 1200; // per tool result — its head, not the whole wall, plus its result lines (edgeLines)
// A line that states an OUTCOME: a commit (`[main abc1234] …`), a push range, a check's score, what a health check
// reported as live, a failed check, an exit code.
const RESULT_LINE = /^\[[^\]\s]+ [0-9a-f]{7,12}\] |^\s*\+?\s*[0-9a-f]{7,12}\.\.\.?[0-9a-f]{7,12}\s+\S+\s+->\s+\S+|\b\d+\/\d+ (?:passing|passed|kept|failed)\b|"commit"\s*:\s*"[0-9a-f]{7,40}"|^\s*✗ |\bexit(?:ed with)? code \d+/i;
const MAX_RESULT_LINES = 8;
const MAX_TURN_OUTPUT_CHARS = 24000; // per turn, command OUTPUT only — what the agent wrote is never cut
// THE WHOLE PAYLOAD, bounded — but only by trimming OUTPUT. What the agent wrote (a handover, a memory note, a
// commit message) is the session stating its own conclusions, and it is never shortened. When the total
// is over, command output gives up the same SHARE in every turn, rather than the oldest turns giving up
// everything: the early part of a session is where its constraints were set.
const MAX_TOTAL_EVIDENCE_CHARS = 600000;
// ONE TURN'S EVIDENCE, whatever it holds. The Hub stores 200,000 characters of it (handoff-brief EVIDENCE_CHAR_CAP)
// and refuses a turn over 250,000 — so a session whose agent wrote a 360 KB file in one turn was refused whole, and
// the hook, never blocking, filed nothing. Past this nothing would have been kept anyway.
const MAX_TURN_EVIDENCE_CHARS = 200000;

/** A transcript entry's text parts only — what was SAID. Not thinking, tool calls or tool results. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
}

/** PURE: the head of command output in at most `max` characters, ending where a line ends. Cut mid-line, a push
 *  printed `f53e23c..7824567  main -> v` — a branch called "v" — and a summary quoted it as that. */
function headLines(s, max) {
  if (s.length <= max) return s;
  const at = s.lastIndexOf('\n', max);
  return s.slice(0, at >= max * 0.5 ? at : max);
}

/**
 * PURE: the head AND the tail of one tool result, in at most `max` characters, each cut where a line ends.
 *
 * The head alone lost what a result is FOR. A commit's hash is on the last line after the pre-commit hook's forty
 * lines of progress; a test run's "59/59 passing" is its final line; a push prints its range at the end. Measured in
 * a cross-tool retention test: every commit reached the next tool without its hash, and only one of five scores
 * survived — the rest had been cut off with the tail.
 */
function edgeLines(s, headMax) {
  // The WHOLE head the capture always kept, plus only the RESULT lines from what was cut — never a smaller head, and
  // never the tail wholesale. Both were measured on the evidence-delivery bench: splitting one budget between head and
  // tail lost a fact 700 characters in; keeping 400 characters of tail as well lost three, because the extra text
  // crowded the passages a lookup ranks. A result line is a few dozen characters and is what the tail was FOR.
  if (s.length <= headMax) return s;
  const head = headLines(s, headMax);
  const results = s.slice(head.length).split('\n').filter((l) => RESULT_LINE.test(l)).slice(-MAX_RESULT_LINES).map((l) => l.trim().slice(0, 200));
  return results.length > 0 ? `${head}\n…\n${results.join('\n')}` : head;
}

const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** PURE: how one tool call touches sealed material — `{ read }`, `{ write }` or `{ list }` naming the path, `{ watch }`
 *  with the sealed paths a command named without reading them (its output is checked against them), or null. */
function sealedTouch(name, input, check) {
  const file = input.file_path || input.notebook_path;
  if (WRITES.has(name)) return file && check.isSealed(file) ? { write: check.shown(file) } : null;
  if (typeof input.command === 'string') {
    const { read, named } = check.commandTouch(input.command);
    return read ? { read } : named.length > 0 ? { watch: named } : null;
  }
  if (name === 'Grep' || name === 'Glob') {
    const where = input.path || '.';
    if (!check.isSealed(where) && !(input.glob && check.isSealed(input.glob))) return null;
    // A search that prints matching LINES has read them; one that lists file names has not.
    return name === 'Grep' && input.output_mode === 'content' ? { read: check.shown(where) } : { list: check.shown(where) };
  }
  return file && check.isSealed(file) ? { read: check.shown(file) } : null;
}

/**
 * What the TOOLS did in this entry: which ones ran, and the head of what they returned.
 *
 * Speech alone is 2.6% of an agentic session — measured on a real Claude Code stretch, 53k characters of text
 * against 921k of tool results. Every number such a session establishes is printed by a command and then referred
 * to obliquely in prose, so a capture that kept only prose could describe the work and never state a fact about it.
 * Thinking stays dropped: a conclusion that mattered was either said or acted on.
 *
 * `ctx.check` says what is sealed (seturos-hook-sealed.cjs). WRITING or listing sealed material is recorded as touched
 * and its contents are not kept; READING it sets `taint` — the path read — and nothing after it in the entry is kept.
 * A command that only NAMED sealed material is kept like any other, and its output decides: carrying that material's
 * own lines is reading it.
 */
function evidenceOf(content, ctx) {
  const out = { written: [], output: [], taint: null };
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (!p || !p.type) continue;
    if (p.type === 'tool_use') {
      const input = p.input || {};
      // WHAT THE AGENT WROTE, whole. Measured, the answers a compacted session could not recover were inside these
      // bodies — a commit message, a handover edit — past any head a cap would keep.
      const written = input.content || input.new_string;
      const target = input.file_path || input.command || input.pattern || input.path;
      const touch = sealedTouch(p.name, input, ctx.check);
      if (touch && touch.read) {
        out.taint = touch.read;
        return out;
      }
      // Named, not read: kept like any command, and the id remembered so its RESULT is checked when it arrives.
      if (touch && touch.watch && p.id) ctx.watched.set(p.id, touch.watch);
      if (touch && !touch.watch) {
        // The call's id is remembered so its RESULT, which arrives in a later entry, is dropped too.
        if (p.id) ctx.sealedCalls.add(p.id);
        out.output.push(`${touch.write ? '✎' : '$'} ${p.name} ${touch.write || touch.list} (sealed — contents not captured)`);
      } else if (typeof written === 'string' && written.trim() !== '') {
        out.written.push(`✎ ${p.name} ${String(target || '').slice(0, 200)}\n${written}`);
      } else if (typeof input.command === 'string' && input.command.length > 300) {
        out.written.push(`$ ${p.name} ${input.command}`); // a commit message in a heredoc is the commonest case
      } else {
        out.output.push(`$ ${p.name}${target ? ` ${String(target).slice(0, 300)}` : ''}`);
      }
    } else if (p.type === 'tool_result') {
      if (p.tool_use_id && ctx.sealedCalls.has(p.tool_use_id)) continue;
      const raw = typeof p.content === 'string'
        ? p.content
        : Array.isArray(p.content) ? p.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
      const named = p.tool_use_id ? ctx.watched.get(p.tool_use_id) : null;
      const leaked = named ? ctx.check.showsContentOf(named, raw) : null;
      if (leaked) { out.taint = leaked; return out; }
      // A search over a wider folder names nothing sealed in its call, and still prints lines from inside a sealed file,
      // each prefixed by its path: that is reading it. A line that only NAMES one (`?? docs/eval/`) is dropped.
      const lines = [];
      for (const line of raw.split('\n')) {
        const hit = ctx.check.sealedLine(line);
        if (hit && hit.grepContent) { out.taint = ctx.check.shown(hit.path); return out; }
        if (!hit) lines.push(line);
      }
      const body = lines.join('\n');
      // The HEAD of the output: a command that matters says so early; the tail is usually a trace or a wall of rows.
      if (body.trim() !== '') out.output.push(edgeLines(body, MAX_EVIDENCE_CHARS));
    }
  }
  return out;
}

/** Text Claude Code injects into user turns that the person did not type. */
function withoutInjected(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/<(ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '') // the editor's own notes ("The user opened the file …")
    // A background task finishing arrives as a user message; the person said none of it.
    .replace(/<(task-notification)>[\s\S]*?<\/\1>/g, '')
    .replace(/^\s*\[Request interrupted by user[^\]]*\]\s*/, '')
    .trim();
}

/** PURE: one stretch's raw turns → the turns a capture sends, with output trimmed to the payload budget. */
function finishStretch(turns) {
  // NUL goes too: a tool that read a binary file prints one, Postgres refuses it, and an older Hub answered 500 for
  // the whole session.
  const noNul = (s) => s.replace(/\x00/g, '');
  const kept = turns.slice(-MAX_TURNS).map((t) => ({
    role: t.role,
    text: noNul(t.text).slice(0, MAX_TURN_CHARS),
    written: noNul(t.written.join('\n')),
    output: headLines(noNul(t.output.join('\n')), MAX_TURN_OUTPUT_CHARS),
  }));
  const writtenTotal = kept.reduce((n, t) => n + t.written.length, 0);
  const outputTotal = kept.reduce((n, t) => n + t.output.length, 0);
  const room = Math.max(0, MAX_TOTAL_EVIDENCE_CHARS - writtenTotal);
  const share = outputTotal > room ? room / outputTotal : 1;
  return kept.map((t) => {
    const output = share < 1 ? headLines(t.output, Math.floor(t.output.length * share)) : t.output;
    // Written first: the distiller reads the head, and a cap takes the tail.
    const evidence = [t.written, output].filter((x) => x !== '').join('\n').slice(0, MAX_TURN_EVIDENCE_CHARS);
    return { role: t.role, text: t.text, ...(evidence ? { evidence } : {}) };
  });
}

/**
 * PURE: a Claude Code transcript → EVERY stretch of the session, oldest first, as `{ segment, turns }` (segment 0 before
 * any compaction, 1 after the first, …).
 *
 * ONE HANDOFF PER STRETCH, NOT PER SESSION: filed under one key refreshed on every compaction, a long session's later
 * brief would replace the first stretch's, and what that stretch settled would go with it. Side chains, meta entries
 * and the compaction summary itself are left out — a summary is model-written, and filing it under the person's
 * words would put a model's sentences where only theirs belong. Consecutive entries from the same side are one turn.
 */
function segmentsFromTranscript(jsonl, opts = {}) {
  return readTranscript(jsonl, opts).segments;
}

/** PURE: where this transcript read sealed material — `{ path, at, segment }` (`at` the entry's ISO time, or null) —
 *  or null when it never did. What a notice and a compacted session's summary say about where the record stops. */
function sealOf(jsonl, opts = {}) {
  return readTranscript(jsonl, opts).seal;
}

/** PURE: the sealed material the LATEST TURN read — from the person's last message on — or null. What the Stop hook
 *  tells the person about the moment it happens, without reading the whole session again. */
function sealedThisTurn(jsonl, opts = {}) {
  const lines = String(jsonl).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!entry || entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    if (withoutInjected(textOf(entry.message && entry.message.content)).trim() === '') continue;
    const seal = readTranscript(lines.slice(i).join('\n'), opts).seal;
    return seal ? seal.path : null;
  }
  return null;
}

function readTranscript(jsonl, opts = {}) {
  const segments = [];
  const ctx = { sealedCalls: new Set(), watched: new Map(), check: null };
  let turns = [];
  let tainted = null;
  let seal = null;
  for (const line of String(jsonl).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    // AFTER SEALED MATERIAL WAS READ, only the stretches' boundaries are kept, so each stretch filed before is replaced.
    if (entry.isCompactSummary) { segments.push(turns); turns = tainted ? [{ role: 'assistant', text: sealed.stubText(tainted), written: [], output: [] }] : []; continue; }
    if (tainted || entry.isSidechain || entry.isMeta) continue;
    const role = entry.message && entry.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (!ctx.check) {
      const disk = Object.fromEntries(['exists', 'list', 'readFile'].filter((k) => opts[k]).map((k) => [k, opts[k]]));
      ctx.check = opts.check || sealed.sealedCheck({ cwd: opts.cwd || entry.cwd || process.cwd(), ...disk });
    }
    const raw = textOf(entry.message.content);
    const text = (role === 'user' ? withoutInjected(raw) : raw).trim();
    // A message that attaches a sealed file with `@` has put its contents in the conversation; the message itself goes too.
    const mentioned = role === 'user' ? ctx.check.mentionReads(text) : null;
    const { written, output, taint } = mentioned ? { written: [], output: [], taint: mentioned } : evidenceOf(entry.message.content, ctx);
    if (taint) {
      tainted = taint;
      seal = { path: taint, at: typeof entry.timestamp === 'string' ? entry.timestamp : null, segment: segments.length };
      const last = turns[turns.length - 1];
      // What the agent said and did in this entry BEFORE the read is kept; the read and everything after it is not.
      if (role === 'assistant' && (text !== '' || written.length > 0 || output.length > 0)) {
        if (last && last.role === 'assistant') {
          if (text !== '') last.text = last.text === '' ? text : `${last.text}\n\n${text}`;
          last.written.push(...written);
          last.output.push(...output);
        } else turns.push({ role, text, written: [...written], output: [...output] });
      }
      turns.push({ role: 'assistant', text: sealed.stubText(taint), written: [], output: [] });
      continue;
    }
    if (text === '' && written.length === 0 && output.length === 0) continue;
    const last = turns[turns.length - 1];
    // A tool RESULT is written as a `user` entry, but the person did not speak: it answers the assistant's own tool
    // call and belongs to the turn that ran it — not in the person's mouth, and not splitting that turn in hundreds.
    if (role === 'user' && text === '' && last && last.role === 'assistant') {
      last.written.push(...written);
      last.output.push(...output);
      continue;
    }
    if (last && last.role === role) {
      if (text !== '') last.text = last.text === '' ? text : `${last.text}\n\n${text}`;
      last.written.push(...written);
      last.output.push(...output);
    } else turns.push({ role, text, written: [...written], output: [...output] });
  }
  segments.push(turns);
  return { segments: segments.map((raw, segment) => ({ segment, turns: finishStretch(raw) })), seal };
}

/** PURE: the conversation SINCE THE LAST COMPACTION — the stretch a PreCompact or SessionEnd files. */
function turnsFromTranscript(jsonl, opts = {}) {
  const all = segmentsFromTranscript(jsonl, opts);
  return all[all.length - 1];
}

// finishStretch is shared with seturos-hook-codex.cjs, so a Codex session is capped exactly as a Claude Code one is.
module.exports = {
  textOf, withoutInjected, segmentsFromTranscript, turnsFromTranscript, sealOf, sealedThisTurn, finishStretch, edgeLines,
  MAX_EVIDENCE_CHARS, isSealedStub: sealed.isSealedStub,
};
