'use strict';

// SETUROS × CLAUDE CODE — when an OPEN session is filed, which stretches a new session catches up, and where a filing
// is written down. Loaded by seturos-compact-hook.cjs; copied beside it by the installer. No dependencies; Node 18+.
//
// A session used to be filed only when it was compacted or closed. Measured on a real one, its last stretch ran on for
// eighteen hours after it was last filed, and a new session started from a snapshot that held none of them: an open
// session's work was invisible to every other session until it ended. So an open session is filed as it goes — after
// a turn that shipped something, otherwise at most every INTERVAL — always under the same key, which refreshes one row.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSealedStub } = require('./seturos-hook-sealed.cjs');

const INTERVAL_MS = 15 * 60 * 1000;
// Two uploads of one stretch never overlap: the Hub checks for a thread's row and then writes one, so a NEW stretch
// filed twice at once could become two rows.
const MIN_GAP_MS = 2 * 60 * 1000;
// A transcript is still written to for a moment after the hook that filed it ran, and two clocks are compared.
const CATCH_UP_SLACK_MS = 2 * 60 * 1000;
const CATCH_UP_DAYS = 7;
const CATCH_UP_SESSIONS = 5;

// A commit, a push or a deploy — what a later session most needs to know happened. Read from the commands run.
const SHIP = /\bgit\b[^\n]*?\s(?:commit|push)\b|\bprisma\s+migrate\s+deploy\b|\brailway\s+up\b|\bvercel\s+(?:deploy|--prod)\b|\bfly\s+deploy\b|\bnpm\s+run\s+(?:-s\s+)?(?:deploy|release|[a-z-]+:publish)\b/;

/** PURE: did the turn that just ended ship something? Its entries run from the end of the transcript back to the
 *  person's last message; a tool RESULT is written as a user entry too, and is not that message. */
function shippedThisTurn(jsonl) {
  const lines = String(jsonl).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!entry || entry.isSidechain) continue;
    const content = entry.message && entry.message.content;
    if (entry.type === 'user' && !entry.isMeta) {
      const spoke = typeof content === 'string' || (Array.isArray(content) && content.some((p) => p && p.type === 'text'));
      if (entry.isCompactSummary || spoke) return false;
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      if (content.some((p) => p && p.type === 'tool_use' && p.input && typeof p.input.command === 'string' && SHIP.test(p.input.command))) return true;
    }
  }
  return false;
}

/**
 * PURE: file the open stretch now? `state` is this session's hook state: `startedAt`, `fileSpawnedAt` (the last upload
 * started), `filePending` (something shipped inside the gap). A session with neither time started before this hook
 * could file mid-session — it is filed on its first stop, then on the interval.
 */
function fileDecision(state, now, shipped) {
  const s = state || {};
  const due = shipped || s.filePending === true;
  if (now - (s.fileSpawnedAt || 0) < MIN_GAP_MS) return { file: false, pending: due };
  if (due) return { file: true, reason: 'shipped', pending: false };
  const last = Math.max(s.fileSpawnedAt || 0, s.startedAt || 0);
  if (last === 0 || now - last >= INTERVAL_MS) return { file: true, reason: 'interval', pending: false };
  return { file: false, pending: false };
}

/**
 * PURE: which stretches of another session to file again at a new session's start.
 *
 * `filed` maps each of the person's filed thread keys in this repository to when it was filed (ms). Only a session the
 * Hub already holds some of is caught up: one it holds none of was either never filed — the `import` command's job —
 * or deleted by its owner, and a catch-up must not bring deleted work back. Within it, a stretch with no row is filed,
 * and the LAST stretch is filed again when the transcript moved on after it was filed; an earlier stretch ended at a
 * compaction and was filed then. `wanted` overrides the first rule for a session whose own filing failed.
 */
function staleStretches({ keyOf, segments, filed, lastActivityMs, slackMs = CATCH_UP_SLACK_MS, wanted = false }) {
  const prefix = keyOf(0).replace(/\d+$/, '');
  if (!wanted && ![...filed.keys()].some((k) => k.startsWith(prefix))) return [];
  // A stretch that is only the sealed stub replaces what was filed for it before the session read sealed material.
  const eligible = segments.filter((s) => (s.turns.length >= 2 && s.turns.some((t) => t.role === 'user' && t.text !== '')) || isSealedStub(s.turns));
  const lastSegment = segments.length > 0 ? segments[segments.length - 1].segment : -1;
  return eligible.filter((s) => {
    const at = filed.get(keyOf(s.segment));
    if (at === undefined) return true;
    return s.segment === lastSegment && at + slackMs < lastActivityMs;
  });
}

/** PURE: is a session worth reading at all? Its transcript moved on after the newest stretch filed for it. */
function mayBeStale(prefix, filed, lastActivityMs, slackMs = CATCH_UP_SLACK_MS) {
  let newest = -1;
  for (const [k, at] of filed) if (k.startsWith(prefix)) newest = Math.max(newest, at);
  return newest !== -1 && newest + slackMs < lastActivityMs;
}

/** This folder's other transcripts, newest first: the recent ones a catch-up may read. */
function recentTranscripts(dir, excludeSessionId, now = Date.now()) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && path.basename(f, '.jsonl') !== excludeSessionId)
      .map((f) => ({ file: path.join(dir, f), sessionId: path.basename(f, '.jsonl'), at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((t) => now - t.at <= CATCH_UP_DAYS * 24 * 3600 * 1000)
      .sort((a, b) => b.at - a.at)
      .slice(0, CATCH_UP_SESSIONS);
  } catch { return []; }
}

/** The first bytes of a file — enough to read which folder a transcript was recorded in, without reading all of it. */
function readHead(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ── the capture log ────────────────────────────────────────────────────────────────────────────────
// A filing runs in a detached child nobody watches, so a failure used to vanish. Each one is a line here instead:
// when, which session and stretch, and what the Hub said. Never the conversation, never the token. Bounded.

const LOG_FILE = path.join(os.homedir(), '.seturos', 'capture.log');
const LOG_MAX_BYTES = 256 * 1024;

function logCapture(line, file = LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.slice(text.indexOf('\n', Math.floor(text.length / 2)) + 1));
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(line).replace(/\s+/g, ' ').slice(0, 500)}\n`);
  } catch { /* the log is for a person looking into it; filing never depends on it */ }
}

module.exports = {
  INTERVAL_MS, MIN_GAP_MS, CATCH_UP_SLACK_MS, LOG_FILE,
  shippedThisTurn, fileDecision, staleStretches, mayBeStale, recentTranscripts, readHead, logCapture,
};
