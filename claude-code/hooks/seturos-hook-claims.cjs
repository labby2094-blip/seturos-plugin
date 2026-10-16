'use strict';

// SETUROS × CLAUDE CODE — when the agent says it is done, do the things it reports appear in what its tools printed?
//
// Three kinds of claim, chosen because each can be checked against tool output WITHOUT a model and each is a thing a
// person acts on: a check score ("64/64 passing"), a commit named as made or shipped, and a push. A claim the session's
// own tool output does not contain is not proof of a false claim — it may have come from the person, or from a tool
// that ran elsewhere — so the hook asks once, and never twice in a row (`stop_hook_active`). PURE.

// Words that make "N/M" a check result rather than a ratio in prose ("20/20 on substance" is a judgment, not a run).
const CHECK_WORD = /\b(?:pass(?:ing|ed|es)?|green|tests?|checks?|smokes?|kept|succeeded|failing|failed)\b/i;
const SHIP_WORD = /\b(?:commit(?:s|ted)?|pushed|deployed|shipped|live)\b/i;
// A sentence that says a thing did NOT happen, or has yet to, or might, claims nothing.
const HEDGE = /\b(?:not|never|nothing|no|before|until|if|once|when|whether|owed|pending|will|would|could|should|can|need|needs|asked?|go-ahead)\b|n't\b/i;
const PUSH_RECORD = /\b[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\s+\S+\s+->\s+\S+|\[new branch\]|Everything up-to-date/;

const around = (text, index, length, reach = 40) => text.slice(Math.max(0, index - reach), index + length + reach);
const sentenceAt = (text, index) => {
  const start = Math.max(text.lastIndexOf('. ', index), text.lastIndexOf('\n', index)) + 1;
  const ends = [text.indexOf('. ', index), text.indexOf('\n', index)].filter((i) => i !== -1);
  return text.slice(start, ends.length > 0 ? Math.min(...ends) : text.length);
};

/** PURE: the checkable claims a reply makes. */
function claimsOf(message) {
  const text = String(message || '');
  const claims = [];
  // Not after a digit or a decimal point: "0.5 / 20" was read as a claim of "5 / 20", which no tool printed.
  for (const m of text.matchAll(/(?<![\d.])\b(\d{1,5})\s*\/\s*(\d{1,5})\b/g)) {
    const [n, d] = [Number(m[1]), Number(m[2])];
    if (d < 2 || n > d || !CHECK_WORD.test(around(text, m.index, m[0].length))) continue;
    if (HEDGE.test(sentenceAt(text, m.index))) continue;
    claims.push({ kind: 'score', needle: `${n}/${d}`, shown: m[0] });
  }
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (!/\d/.test(m[0]) || !/[a-f]/.test(m[0]) || /\.\./.test(around(text, m.index, m[0].length, 2))) continue;
    if (!SHIP_WORD.test(around(text, m.index, m[0].length)) || HEDGE.test(sentenceAt(text, m.index))) continue;
    claims.push({ kind: 'commit', needle: m[0].slice(0, 7), shown: m[0] });
  }
  for (const m of text.matchAll(/\bpushed\b/gi)) {
    if (HEDGE.test(sentenceAt(text, m.index))) continue;
    claims.push({ kind: 'push', needle: null, shown: sentenceAt(text, m.index).trim().slice(0, 120) });
    break;
  }
  const seen = new Set();
  return claims.filter((c) => { const k = `${c.kind}:${c.needle}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** PURE: a transcript (JSONL) → what its tools printed, and what the person typed. A claim either one contains is not
 *  the agent's own invention. Only lines that can hold a tool result or a person's words are parsed. */
function sessionRecord(transcriptText) {
  const tools = [];
  const person = [];
  for (const line of String(transcriptText || '').split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry && entry.message && entry.message.content;
    if (typeof content === 'string') { person.push(content); continue; }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') person.push(part.text);
      if (!part || part.type !== 'tool_result') continue;
      if (typeof part.content === 'string') tools.push(part.content);
      else if (Array.isArray(part.content)) for (const c of part.content) if (c && c.type === 'text') tools.push(c.text);
    }
    // NOT `toolUseResult`: for a Write or an Edit it holds the text the agent itself wrote, so a score the agent put
    // in a file would "back" the same score in its reply. Caught on a real session, where it let 99/99 through.
  }
  return { tools: tools.join('\n'), person: person.join('\n') };
}

/** PURE: the claims nothing in the session backs. */
function unbacked(claims, record) {
  return claims.filter((c) => {
    if (c.kind === 'push') return !PUSH_RECORD.test(record.tools);
    return !record.tools.includes(c.needle) && !record.person.includes(c.needle);
  });
}

/** PURE: the Stop hook's reason — what it could not find, and what to do about it. */
function stopReason(missing) {
  if (missing.length === 0) return '';
  const list = missing.map((c) => (c.kind === 'push' ? `a push ("${c.shown}")` : c.kind === 'commit' ? `commit ${c.shown}` : `the result ${c.shown}`)).join('; ');
  return `Seturos compared this reply with what the tools printed in this session and could not find ${list}. If it came from somewhere else, say where; if it was not run, run it and quote the output — do not report it as verified.`;
}

module.exports = { claimsOf, sessionRecord, unbacked, stopReason };
