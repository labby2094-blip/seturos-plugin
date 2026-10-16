#!/usr/bin/env node
'use strict';

// SETUROS × CLAUDE CODE — a session keeps what it settled and what it did, and a new one starts where the last stopped.
//
// Claude Code, like every AI tool, shortens a long conversation: it replaces older turns with a summary. A rule said
// early ("never deploy on Fridays") is exactly what a summary drops, and a new session starts with none of it.
// Claude Code announces both to hooks, so this listens at every seam:
//
//   pre-compact     PreCompact: files the session so far with Seturos (POST /api/uml/capture) — the same /carry
//                   every other tool uses. One handoff per stretch (threadKey), tagged with the repository.
//   session-start   SessionStart. After a compaction: the settled rules and what the session did — led by where its
//                   record stops, when it read sealed material. On a new session:
//                   first files again what this folder's other sessions did since they were last filed, then where
//                   the linked project stands — or, with no link, what this person's own earlier sessions in this
//                   repository did, and how fresh that is. Caches what the hooks below need.
//   prompt          UserPromptSubmit: the passages of earlier work the message just sent is actually about —
//                   nothing when it is not, and nothing when there is no earlier work to search.
//   pre-tool        PreToolUse: a settled rule, when a command or an edit touches what that rule names. Local only.
//   stop            Stop: files the OPEN stretch, detached, after a turn that shipped something or every ~15 minutes
//                   (seturos-hook-filing.cjs) — and checks for a score, commit or push no tool in the session printed.
//                   Tells the person, once, the turn a session reads sealed material and stops being saved.
//   session-end     SessionEnd: files the last stretch, detached, so closing the session never waits on it.
//
// Every detached filing writes one line to ~/.seturos/capture.log — filed, or why not.
//
// And commands a person or an agent runs in the repository:
//   ask "<question>"      what Seturos holds about it — any agent with a shell, no MCP needed
//   link ["<project>"]    link this repository to a project (no argument: say what it is linked to); unlink
//   import [--sessions N] [--session <id>] [--dry-run]   file this repository's earlier Claude Code sessions (default:
//                         the newest 5; --session: that one, every stretch — how a filed session is refiled under a
//                         newer rule), with rule-based briefs — no model is paid for unless --allow-model
//   status                the status line: where this session's work is filed
//   sign-in / sign-out    approve this computer in the browser (one click) / forget its sign-in here
//   capture-codex [--dry-run] [--all] [--days N] [--repo <remote>]   file Codex's sessions (~/.codex) — also run at
//                         every session start for that repository (seturos-hook-codex.cjs)
//
// Installed by scripts/seturos-install-hooks.cjs, or as the Claude Code plugin's hooks (labby2094-blip/seturos-plugin,
// every command passing --plugin). No dependencies; Node 18+ (global fetch).
//
// AS A PLUGIN the hooks run in every project the plugin is on, not in one repository somebody chose. So until this
// computer is approved, nothing is recorded, nothing is checked, and no page opens by itself: a session is told, once
// a week at most, that memory is off and that /seturos:connect turns it on. The Approve page says what it records.
// Who you are: NOTHING TO PASTE. The hooks use this computer's own sign-in (an Approve click — see
// seturos-hook-signin.cjs), else SETUROS_MCP_TOKEN, else the desktop app's sign-in; with none, a session start opens
// the Approve page once, from a detached process. Configuration, from the environment Claude Code runs the hook in:
//   SETUROS_MCP_TOKEN   optional: an extension token (stk_…), the override for a local Hub
//   SETUROS_HUB         default https://app.seturos.com
//   SETUROS_PROJECT     optional: a per-machine project override (exact name or id); otherwise the repository's link
//
// NEVER BLOCKS CLAUDE CODE. Every hook failure exits 0 with at most one line on stderr: a session that cannot reach
// Seturos runs exactly as it would have without this hook. Only the Stop check asks the agent to continue, once,
// and only for a claim its own tools never printed.

/* eslint-disable no-console -- ask, link, unlink and import are commands, and report to the terminal that ran them */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { repoKeyFrom, repoKeyForDir, readState, writeState, sweepState, statusText, writeLive } = require('./seturos-hook-repo.cjs');
const { scrubTurns } = require('./seturos-hook-scrub.cjs');
const codex = require('./seturos-hook-codex.cjs');
const signin = require('./seturos-hook-signin.cjs');
const { textOf, withoutInjected, segmentsFromTranscript, turnsFromTranscript, sealOf, sealedThisTurn, isSealedStub } = require('./seturos-hook-transcript.cjs');
const { STUB } = require('./seturos-hook-sealed.cjs');
const recall = require('./seturos-hook-recall.cjs');
const claims = require('./seturos-hook-claims.cjs');
const filing = require('./seturos-hook-filing.cjs');

const TIMEOUT_MS = 15000;
const PROMPT_TIMEOUT_MS = 6000; // a person is waiting on this one
const IMPORT_TIMEOUT_MS = 60000; // a long stretch is a large upload, and nobody is waiting on it
const CATCH_UP_BUDGET_MS = 7000; // of SessionStart's 30 seconds; what does not fit goes on in a detached child

/** PURE: one stretch of one session → the key its handoff is filed under (≤ 200 chars, the route's bound). */
function threadKeyFor(sessionId, segment) {
  return `claude-code:${String(sessionId).slice(0, 160)}:${segment}`;
}

/** PURE: every stretch of one session — the thread prefix the Hub searches. */
const threadPrefix = (sessionId) => threadKeyFor(sessionId, 0).replace(/\d+$/, '');

/** PURE: the configured project among the ones this person may file into — exact id, or exact name
 *  ignoring case. A partial name binds nothing, as SETUROS_PROJECT does for instruction files. */
function matchProject(projects, ref) {
  const want = String(ref || '').trim();
  if (want === '' || !Array.isArray(projects)) return null;
  return projects.find((p) => p && p.id === want)
    || projects.find((p) => p && typeof p.name === 'string' && p.name.toLowerCase() === want.toLowerCase())
    || null;
}

function config(env) {
  const hubUrl = String(env.SETUROS_HUB || 'https://app.seturos.com').trim().replace(/\/+$/, '');
  const credential = signin.resolveCredential(env, hubUrl);
  return { token: credential.token, tokenSource: credential.source, hub: hubUrl, project: String(env.SETUROS_PROJECT || '').trim(), env };
}

/** What the session is told about signing in, when this run had to ask. '' | 'opened' | 'waiting' | 'cooling'. */
let signInAsked = '';
let HOOK_COMMAND = 'node .claude/hooks/seturos-compact-hook.cjs';
/** False as a plugin: a session never opens the Approve page by itself (see the header). */
let AUTO_SIGN_IN = true;
const HOOK_FILE_NAME = 'seturos-compact-hook.cjs';
const HOOK_MODES = ['pre-compact', 'session-start', 'prompt', 'pre-tool', 'stop', 'session-end', 'status'];

/**
 * The Hub refused this credential. Remembered, so the next one in line is used — and when there is a next one, used
 * NOW: an old SETUROS_MCP_TOKEN beside a working desktop sign-in costs one refused request, not a lost session.
 * Only with nothing left to try is the Approve page asked for.
 */
function afterRefusal(cfg) {
  const env = cfg.env || process.env;
  signin.markRefused(env, cfg.token);
  const next = signin.resolveCredential(env, cfg.hub);
  if (next.token !== '' && next.token !== cfg.token) {
    Object.assign(cfg, { token: next.token, tokenSource: next.source });
    return true;
  }
  cfg.token = '';
  if (signInAsked === '') signInAsked = AUTO_SIGN_IN ? signin.requestSignIn(env, cfg.hub, __filename) : signin.offNoticeDue(env) ? 'off' : 'quiet';
  return false;
}

async function hub(cfg, pathname, init = {}, timeoutMs = TIMEOUT_MS, retried = false) {
  if (cfg.token === '') throw Object.assign(new Error('not signed in on this computer'), { status: 401 });
  const res = await fetch(`${cfg.hub}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  // REFUSED LOOKS LIKE TWO THINGS. A route that fails soft (lib/auth/with-auth) treats an unrecognised bearer as no
  // session and answers `400 no_org` rather than 401 — a signed-in token always carries an org, so that too means no.
  const refused = res.status === 401 || (res.status === 400 && body && body.error === 'no_org');
  if (refused && afterRefusal(cfg) && !retried) return hub(cfg, pathname, init, timeoutMs, true);
  if (!res.ok) throw Object.assign(new Error(`${pathname.split('?')[0]} answered ${res.status}${body && body.error ? ` (${body.error})` : ''}`), { status: res.status, body });
  return body;
}

/**
 * Where this session's work goes: SETUROS_PROJECT when set (a per-machine override), else the repository's link.
 * `{ id, name }` when it files there; `{ id: null, name }` when the repository is linked to a project this person is
 * not on; null when nothing says. A Hub without the link route (older deploy) is simply "no link".
 */
async function projectFor(cfg, cwd, repoKey = null) {
  if (cfg.project !== '') {
    const body = await hub(cfg, '/api/projects/fileable');
    const project = matchProject(body.projects, cfg.project);
    if (!project) process.stderr.write(`seturos: SETUROS_PROJECT "${cfg.project}" is not a project you can file into — keeping this session yours\n`);
    return project ? { id: project.id, name: project.name } : null;
  }
  // A Codex session names its repository itself, and its folder may be gone by the time it is filed.
  const repo = repoKey || repoKeyForDir(cwd || process.cwd());
  if (!repo) return null;
  const link = await hub(cfg, `/api/uml/repo-link?repo=${encodeURIComponent(repo)}`).catch(() => null);
  return link && link.linked ? { id: link.projectId || null, name: link.projectName } : null;
}

/** The project this session resolved at SessionStart, or resolved now when no state exists (a resumed session). */
async function sessionProject(cfg, input) {
  const state = readState('session', input.session_id);
  if ('project' in state) return state.project;
  const project = await projectFor(cfg, input.cwd).catch(() => null);
  writeState('session', input.session_id, { project });
  return project;
}

/** File one stretch. Tagged with the repository (`sourceUrl`), so a later session there can find it, linked or not. */
async function fileStretch(cfg, { sessionId, segment, turns, cwd, project, mechanicalOnly, tool = 'claude-code', repo: repoKey = null }, timeoutMs = TIMEOUT_MS) {
  const repo = repoKey || (cwd ? repoKeyForDir(cwd) : null);
  const folder = cwd ? path.basename(cwd) : '';
  const label = tool === 'codex' ? 'Codex session' : 'Claude Code session';
  return hub(cfg, '/api/uml/capture', {
    method: 'POST',
    body: JSON.stringify({
      sourceTool: tool,
      sourceTitle: `${label}${folder ? ` — ${folder}` : ''}${segment > 0 ? ` (part ${segment + 1})` : ''}`,
      ...(repo ? { sourceUrl: `https://${repo}` } : {}),
      threadKey: sessionId ? (tool === 'claude-code' ? threadKeyFor(sessionId, segment) : `${tool}:${sessionId}:${segment}`) : null,
      // Scrubbed on THIS side, so a pasted key never makes the trip (seturos-hook-scrub.cjs).
      turns: scrubTurns(turns),
      ...(project && project.id ? { projectId: project.id } : {}),
      ...(mechanicalOnly ? { mechanicalOnly: true } : {}),
    }),
  }, timeoutMs);
}

/** How long a Claude Code session start waits on filing Codex's work in the same repository before it says anything. */
const CODEX_START_BUDGET_MS = 4000;

/**
 * FILE CODEX'S SESSIONS (seturos-hook-codex.cjs), so work done there is where the next tool looks. Only conversations
 * the person had, only ones in a repository unless `all`, only ones changed since they were last filed — and one
 * repository's when `onlyRepo` names it, which is what a session start in that repository asks for. Returns how many
 * stretches were filed; `log` hears each one.
 */
async function captureCodex(cfg, { onlyRepo = null, days = 3, dry = false, all = false, deadline = Infinity, log = () => {} } = {}) {
  let filed = 0;
  for (const rollout of codex.listRollouts(cfg.env || process.env, days)) {
    if (Date.now() > deadline) break;
    const seen = readState('codex', rollout.file);
    if (!dry && seen.mtimeMs === rollout.mtimeMs && seen.size === rollout.size) continue; // unchanged since it was filed
    let parsed;
    try { parsed = codex.parseRollout(fs.readFileSync(rollout.file, 'utf8')); } catch { continue; }
    const { meta, segments } = parsed;
    if (!codex.isPersonsSession(meta) || !meta.id) continue;
    const repo = codex.repoOfRollout(meta, { repoKeyFrom, repoKeyForDir });
    if (onlyRepo && repo !== onlyRepo) continue;
    if (!repo && !all) continue;
    const cwd = typeof meta.cwd === 'string' && fs.existsSync(meta.cwd) ? meta.cwd : '';
    const project = repo ? await projectFor(cfg, cwd, repo).catch(() => null) : null;
    for (const { segment, turns } of segments) {
      if (dry) { log(`would file Codex ${String(meta.id).slice(0, 8)} part ${segment + 1}: ${turns.length} turns${repo ? ` in ${repo}` : ''}`); continue; }
      const body = await fileStretch(cfg, { sessionId: meta.id, segment, turns, cwd, project, tool: 'codex', repo });
      filed += 1;
      log(`filed Codex ${String(meta.id).slice(0, 8)} part ${segment + 1}: ${turns.length} turns → ${body.filedToName || 'just you'}${repo ? ` (${repo})` : ''}`);
    }
    if (!dry) writeState('codex', rollout.file, { mtimeMs: rollout.mtimeMs, size: rollout.size });
  }
  return filed;
}

/** File the stretch the session is in. `{ segment, turns, to }` when something was filed, null when there was nothing. */
async function preCompact(cfg, input, { mechanicalOnly = false, timeoutMs = TIMEOUT_MS } = {}) {
  const file = input && input.transcript_path;
  if (!file || !fs.existsSync(file)) return null;
  const { segment, turns } = turnsFromTranscript(fs.readFileSync(file, 'utf8'), input.cwd ? { cwd: input.cwd } : {});
  if (turns.length === 0) return null;
  const project = await sessionProject(cfg, input);
  const body = await fileStretch(cfg, { sessionId: input.session_id, segment, turns, cwd: input.cwd, project, mechanicalOnly }, timeoutMs);
  return { segment, turns: turns.length, to: body.filedToName || 'just you' };
}

/** PURE: the rules query — the project when one is configured, else every stretch of THIS session. Without
 *  either the Hub can only guess at which recent work this session is, and a guess is not a rule. */
function rulesQuery(projectId, sessionId, repo) {
  // With the repository, a project's rules come without its OTHER repositories' sessions (lib/uml/repo-scope.ts).
  if (projectId) return `/api/uml/resume?rules=1&projectId=${encodeURIComponent(projectId)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`;
  return `/api/uml/resume?rules=1${sessionId ? `&thread=${encodeURIComponent(threadPrefix(sessionId))}` : ''}`;
}

/** PURE: how an agent asks — this very file, by absolute path, so it works in any shell and without MCP. */
function askLine(hookFile = __filename) {
  const cli = `node "${String(hookFile).replace(/\\/g, '/')}" ask "<question>"`;
  return `Anything more specific — a commit, a score, a file, why something was left alone — is kept in Seturos. When you are unsure what was decided earlier, ask before acting: run \`${cli}\`, or call resume_work with a \`question\`, in the words the answer would use.`;
}

/**
 * PURE: what SessionStart prints back into a compacted conversation. The settled rules first, then — when the
 * Hub returns this session's own brief — what the session DID, and a line saying the rest can be asked for.
 */
function sessionStartText(body, hookFile) {
  const rules = body && typeof body.rules === 'string' ? body.rules.trim() : '';
  const brief = body && typeof body.brief === 'string' ? body.brief.trim() : '';
  const parts = [];
  if (rules !== '') parts.push(rules);
  if (brief !== '') {
    parts.push(`What this session did before it was compacted:\n\n${brief}`);
    parts.push(askLine(hookFile));
  }
  return parts.join('\n\n');
}

const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// SAID WHEN IT HAPPENS. Reading sealed material ends what Seturos keeps of a session (seturos-hook-sealed.cjs), and it
// used to end it silently: on 2026-09-25 a session stopped being saved at 10:12 and went on for a day — billing, a
// website, a DNS move — while its summaries after each compaction offered a morning's work as "what this session did".

/** PURE: what the person is told the turn a session reads sealed material. */
function sealNotice(shown) {
  return `Seturos stopped saving this session: it read sealed material (${shown}), which is kept out so an evaluation's `
    + 'answers cannot reach its memory. Nothing from here on is filed, so other tools and later sessions will not see this '
    + 'work. Start a new session for work you want kept.';
}

/** PURE: where a sealed session's record stops — `{ path, at }` — as the line a compacted session starts with. */
function sealRecapLine(seal) {
  const when = seal && seal.at && Number.isFinite(Date.parse(seal.at)) ? ` at ${utc(Date.parse(seal.at))}` : '';
  return `Seturos stopped saving this session${when}, when it read sealed material (${seal.path}). What Seturos says below `
    + 'about this session stops there; everything after it is only in the summary this conversation was compacted to. '
    + 'Do not take the last thing it lists as where the work stands.';
}

/** PURE: the same, for the person, when a compaction brings it back. */
function sealStartNotice(seal) {
  const when = seal && seal.at && Number.isFinite(Date.parse(seal.at)) ? ` since ${utc(Date.parse(seal.at))}` : '';
  return `Seturos has not saved this session${when}: it read sealed material (${seal.path}). Work after that is not filed.`;
}

/** PURE: how fresh what follows is — `{ filedUpTo, activity, pending }` from the catch-up, in ms. A summary that does
 *  not say when it stops reads as the whole story: an eval's new session reported a day-old snapshot as where the
 *  work stood, because nothing said the other session had gone on for eighteen hours since. '' when unknown. */
function freshnessLine(fresh) {
  if (!fresh || !fresh.filedUpTo) return '';
  const line = `Filed up to ${utc(fresh.filedUpTo)}${fresh.activity ? `; newest activity in this folder's other sessions ${utc(fresh.activity)}` : ''}.`;
  if (!fresh.activity || fresh.activity <= fresh.filedUpTo + filing.CATCH_UP_SLACK_MS) return line;
  return `${line} Work after ${utc(fresh.filedUpTo)} is not in Seturos yet${fresh.pending ? ' (it is being filed now)' : ''} — ask before assuming it did not happen.`;
}

/** PURE: what a NEW session in a linked repository starts with — where the project stands, from its earlier sessions
 *  and every other tool that carried work to it. '' when the Hub has nothing. */
function projectStartText(body, project, hookFile, fresh) {
  const primer = body && typeof body.primer === 'string' ? body.primer.trim() : '';
  const notice = planNoticeOf(body);
  if (primer === '' && notice !== '') return `Seturos — tell the person: ${notice}`;
  if (primer === '' || !project) return '';
  const when = freshnessLine(fresh);
  return [
    `Seturos — this repository works on "${project.name}", and this session's work is filed there. What that work has carried so far, from earlier sessions and other tools:${when ? ` ${when}` : ''}`,
    primer,
    askLine(hookFile),
    ...(notice !== '' ? [notice] : []),
  ].join('\n\n');
}

/** PURE: the Hub's plan notice (lib/billing/plan-limits.ts) — a limit reached, or older work kept — or ''. A limit is
 *  said to the person rather than swallowed as "no earlier work", which would read as nothing ever having been recorded. */
function planNoticeOf(body) {
  return body && typeof body.planNotice === 'string' ? body.planNotice.trim() : '';
}

/** PURE: `text` in at most `max` characters, cut where a line or a sentence ends — never inside a word, a hash or a
 *  branch name ("→ main, v"). A cut says so. MIRRORS lib/uml/text-cut.ts `cutAtBoundary`; smoke:session-hooks runs
 *  both on the same text. */
function cutAtBoundary(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = s.slice(0, Math.max(0, max - 2));
  const ends = [head.lastIndexOf('\n'), ...['. ', '! ', '? '].map((m) => { const at = head.lastIndexOf(m); return at === -1 ? -1 : at + 1; })];
  let at = Math.max(...ends);
  if (at < max * 0.5) at = head.lastIndexOf(' ');
  if (at < max * 0.5) at = head.length;
  return `${head.slice(0, at).trimEnd()} …`;
}

const SHORT_SESSION_TURNS = 8;
const OUTLINE_MAX_CHARS = 7200; // the Hub sizes each outline (repo-memory OUTLINE_BUDGETS); this only bounds a bad reply

/** PURE: which session and stretch a filed row is, when, and how much of it — so two stretches are never mistaken
 *  for one session's latest step because they share a title. */
function sessionLabel(s) {
  const key = /^claude-code:([^:]+):(\d+)$/.exec(String(s.threadKey || ''));
  const parts = [key ? `session ${key[1].slice(0, 8)}, part ${Number(key[2]) + 1}` : (s.title || 'Earlier session')];
  if (Number.isFinite(s.turnCount)) parts.push(`${s.turnCount} turns`);
  if (typeof s.createdAt === 'string') parts.push(`filed ${s.createdAt.slice(0, 16).replace('T', ' ')} UTC`);
  return parts.join(' · ');
}

/** PURE: what a NEW session in a repository with no project starts with — this person's own earlier sessions there,
 *  newest first, each labelled. The newest SUBSTANTIAL ones come as the Hub's outline (every commit and why, the
 *  person's standing instructions, what is still open), sized by the Hub; the rest as their brief, and a few-turn
 *  session gets a few lines, so a quick check filed last never crowds out the work before it. '' when there are none. */
function repoStartText(body, repo, hookFile, fresh) {
  const text = (s) => (typeof s.outline === 'string' && s.outline.trim() !== '' ? s.outline : s.brief);
  const sessions = body && Array.isArray(body.sessions) ? body.sessions.filter((s) => s && typeof text(s) === 'string' && text(s).trim() !== '') : [];
  const notice = planNoticeOf(body);
  if (sessions.length === 0) return notice !== '' ? `Seturos — tell the person: ${notice}` : '';
  const rules = typeof body.rules === 'string' ? body.rules.trim() : '';
  const short = (s) => Number.isFinite(s.turnCount) && s.turnCount < SHORT_SESSION_TURNS;
  const lead = sessions.findIndex((s) => !short(s));
  const cap = (s, i) => (typeof s.outline === 'string' && s.outline.trim() !== '' ? OUTLINE_MAX_CHARS : i === lead ? 3500 : short(s) ? 900 : 1500);
  const blocks = sessions.map((s, i) => `── ${sessionLabel(s)}\n${cutAtBoundary(text(s).trim(), cap(s, i))}`);
  const when = freshnessLine(fresh);
  return [
    `Seturos — what your earlier sessions in this repository (${repo}) did and where they stopped, newest first, each session's parts together. This session continues that work unless the person says otherwise.${when ? ` ${when}` : ''}`,
    ...(rules !== '' ? [rules] : []),
    ...blocks,
    askLine(hookFile),
    ...(notice !== '' ? [notice] : []),
  ].join('\n\n');
}

async function sessionStart(cfg, input) {
  sweepState();
  const source = input.source || 'startup';
  const session = input.session_id;
  const project = await projectFor(cfg, input.cwd).catch(() => null);
  const repo = input.cwd ? repoKeyForDir(input.cwd) : null;
  writeState('session', session, { project, repo, ...(source === 'compact' ? { compacted: true, reminded: [] } : { startedAt: Date.now() }) });
  if (input.cwd) writeState('dir', path.resolve(input.cwd), { project });
  if (repo) writeLive(session, { tool: 'claude-code', repo, folder: path.basename(input.cwd), project });
  const projectId = project && project.id;
  const fresh = source === 'startup' || source === 'clear';
  // THE OTHER SESSIONS HERE GO FIRST: what this one starts with should include what they did since they were filed.
  const caught = repo && source !== 'compact'
    ? await catchUp(cfg, { cwd: input.cwd, sessionId: session, repo, project, deadline: Date.now() + CATCH_UP_BUDGET_MS }).catch(() => null)
    : null;
  // AND WHAT CODEX DID HERE. Switching from Codex back to Claude Code is the direction that used to start from nothing:
  // Codex's sessions sat in ~/.codex, unread. This repository's are filed before the start text is written, so it
  // includes them (seturos-hook-codex.cjs).
  if (repo && source !== 'compact') await captureCodex(cfg, { onlyRepo: repo, deadline: Date.now() + CODEX_START_BUDGET_MS }).catch(() => 0);

  let text = '';
  let notice = '';
  if (source === 'compact') {
    // This session's own stretches give back what it DID; a project, when there is one, gives the rules — its own
    // decisions and every other session's, which include this one's once it was filed there.
    const own = await hub(cfg, rulesQuery(null, session));
    const rulesBody = projectId ? await hub(cfg, rulesQuery(projectId, session, repo)).catch(() => own) : own;
    writeState('session', session, { rules: recall.rulesFrom(rulesBody.rules) });
    text = sessionStartText({ rules: rulesBody.rules, brief: own.brief });
    // Where the record stops goes FIRST, so what follows is read as stopping there.
    const transcript = input.transcript_path && fs.existsSync(input.transcript_path) ? fs.readFileSync(input.transcript_path, 'utf8') : '';
    const seal = transcript ? sealOf(transcript, input.cwd ? { cwd: input.cwd } : {}) : null;
    if (seal) {
      writeState('session', session, { sealed: { path: seal.path, at: seal.at }, sealNoticed: true });
      text = [sealRecapLine(seal), text].filter((t) => t !== '').join('\n\n');
      notice = sealStartNotice(seal);
    }
  } else if (projectId) {
    const rulesBody = await hub(cfg, rulesQuery(projectId, session, repo)).catch(() => ({}));
    writeState('session', session, { rules: recall.rulesFrom(rulesBody.rules), history: true });
    if (fresh) text = projectStartText(await hub(cfg, `/api/uml/resume?projectId=${encodeURIComponent(projectId)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`), project, undefined, caught);
  } else if (repo) {
    // NO PROJECT, STILL NOT A BLANK SLATE: the person's own sessions in this repository.
    const memory = await hub(cfg, `/api/uml/repo-memory?repo=${encodeURIComponent(repo)}&exclude=${encodeURIComponent(threadPrefix(session))}`).catch(() => null);
    const history = Boolean(memory && Array.isArray(memory.sessions) && memory.sessions.length > 0);
    writeState('session', session, { history, rules: recall.rulesFrom(memory && memory.rules) });
    if (fresh) text = repoStartText(memory, repo, undefined, caught);
  }
  // THE OFFER, WHERE THE INTENT ALREADY IS. Following a project says where this work belongs; an unlinked repository
  // keeps every session personal. Said once, at a start, and never acted on by itself — a link decides where a TEAM's
  // work is filed, so the person says yes first (the agent then calls link_repository, or runs `link` below).
  if (fresh && repo && !projectId) {
    const armed = await hub(cfg, '/api/uml/follow').then((b) => b && b.armed).catch(() => null);
    if (armed && armed.projectId && armed.projectName) {
      // Following is running now; a destination is where their work goes until they say otherwise. Both are an intent.
      const intent = armed.armed === true ? `You are following ${armed.projectName}` : `Your work is set to go to ${armed.projectName}`;
      text = `${text ? `${text}\n\n` : ''}${intent}, and this repository is not linked to it, so what is recorded here `
        + `stays yours alone. Ask whether to link it — saying that from then on the sessions recorded here go to `
        + `${armed.projectName} for everyone on it, that earlier sessions here stay theirs, and that it can be undone — `
        + `and only on a yes call link_repository, or run\n`
        + `  node .claude/hooks/seturos-compact-hook.cjs link "${armed.projectName}"`;
    }
  }
  return { text, notice };
}

const emit = (event, text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));

async function onPrompt(cfg, input) {
  const query = recall.promptQuery(input.prompt);
  if (query === '') return;
  const state = readState('session', input.session_id);
  // Which stretch this is: one more than the compactions so far. Its passages are still in context, so it is excluded.
  const transcript = input.transcript_path && fs.existsSync(input.transcript_path) ? fs.readFileSync(input.transcript_path, 'utf8') : '';
  const segment = transcript.split('"isCompactSummary":true').length - 1;
  let compacted = state.compacted === true || segment > 0;
  if (compacted && state.compacted !== true) writeState('session', input.session_id, { compacted });
  const project = 'project' in state ? state.project : await sessionProject(cfg, input);
  const repo = 'repo' in state ? state.repo : (input.cwd ? repoKeyForDir(input.cwd) : null);
  if (repo) writeLive(input.session_id, { tool: 'claude-code', repo, folder: path.basename(input.cwd || ''), project }); // still live, for the dock
  // Nothing outside the conversation to search: no compaction, no project, and no earlier session in this repository.
  // A session that started before this hook knew about repositories has no `history` — it asks rather than guesses.
  if (!compacted && !(project && project.id) && state.history === false) return;
  if (!compacted && !(project && project.id) && !repo) return;
  const params = new URLSearchParams({ auto: '1', q: query });
  if (project && project.id) params.set('projectId', project.id);
  if (repo) params.set('repo', repo);
  if (compacted) params.set('thread', threadPrefix(input.session_id));
  if (input.session_id) params.set('exclude', threadKeyFor(input.session_id, segment));
  const body = await hub(cfg, `/api/uml/resume?${params}`, {}, PROMPT_TIMEOUT_MS);
  const text = recall.recallText(body.evidence);
  // Passages from a sealed session all come from before the seal: said, so they are not taken as the latest.
  const sealed = state.sealed && state.sealed.path
    ? `\n\n(Seturos stopped saving this session${state.sealed.at ? ` at ${utc(Date.parse(state.sealed.at))}` : ''}, when it read sealed material, so these passages are all from before then.)`
    : '';
  if (text !== '') emit('UserPromptSubmit', `${text}${sealed}`);
}

function onPreTool(input) {
  const state = readState('session', input.session_id);
  const hits = recall.ruleHits(state.rules, input.tool_name, input.tool_input, state.reminded);
  if (hits.length === 0) return;
  writeState('session', input.session_id, { reminded: [...(state.reminded || []), ...hits.map((h) => h.rule)] });
  emit('PreToolUse', recall.preToolText(hits, input.tool_name));
}

/** Stop: the notice for a turn that read sealed material, once per session — '' otherwise, or when nothing is saved. */
function sealNoticeFor(cfg, input, transcript) {
  if (cfg.token === '' || !input.session_id) return '';
  const state = readState('session', input.session_id);
  if (state.sealNoticed === true) return '';
  const read = sealedThisTurn(transcript, input.cwd ? { cwd: input.cwd } : {});
  if (!read) return '';
  writeState('session', input.session_id, { sealed: { path: read, at: new Date().toISOString() }, sealNoticed: true });
  return sealNotice(read);
}

function onStop(cfg, input) {
  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) return;
  const transcript = fs.readFileSync(input.transcript_path, 'utf8');
  let notice = '';
  try { notice = sealNoticeFor(cfg, input, transcript); } catch { notice = ''; }
  fileOpenStretch(cfg, input, transcript);
  const say = (reason) => {
    const out = { ...(reason ? { decision: 'block', reason } : {}), ...(notice ? { systemMessage: notice } : {}) };
    if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
  };
  if (input.stop_hook_active) return say('');
  let message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (message === '') {
    const last = transcript.trim().split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e && e.type === 'assistant' && !e.isSidechain && textOf(e.message && e.message.content).trim() !== '');
    message = last ? textOf(last.message.content) : '';
  }
  const found = claims.claimsOf(message);
  say(found.length === 0 ? '' : claims.stopReason(claims.unbacked(found, claims.sessionRecord(transcript))));
}

const spawnHook = (args) => spawn(process.execPath, [__filename, ...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

/** Upload in a detached child that outlives the hook — and Claude Code — reading its job from a temporary file. */
function spawnCapture(input, job) {
  const file = path.join(os.tmpdir(), `seturos-capture-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...job, input: { session_id: input.session_id, transcript_path: input.transcript_path, cwd: input.cwd } }));
  spawnHook(['capture-file', file]);
}

/** Stop: file the stretch this session is still in, when a turn shipped something or it is due. Rule-based brief — a
 *  model is paid for once, when the stretch ends (PreCompact, SessionEnd), not every quarter of an hour. */
function fileOpenStretch(cfg, input, transcript) {
  if (cfg.token === '' || !input.session_id) return;
  const state = readState('session', input.session_id);
  const now = Date.now();
  const decision = filing.fileDecision(state, now, filing.shippedThisTurn(transcript));
  if (!decision.file) {
    if (decision.pending && state.filePending !== true) writeState('session', input.session_id, { filePending: true });
    return;
  }
  writeState('session', input.session_id, { fileSpawnedAt: now, filePending: false });
  spawnCapture(input, { mechanicalOnly: true, reason: decision.reason });
}

/** SessionEnd gives a hook about a second and a half. Filing a long session takes longer, so it runs detached. */
function sessionEnd(input) {
  writeLive(input.session_id, null);
  if (input.transcript_path) spawnCapture(input, { reason: 'session end' });
}

async function captureFile(cfg, file) {
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);
  const input = job.input || job; // a job the previous version of this hook wrote is the bare hook input
  const label = `session ${String(input.session_id || '').slice(0, 8)} (${job.reason || 'session end'})`;
  try {
    const filed = await preCompact(cfg, input, { mechanicalOnly: job.mechanicalOnly === true, timeoutMs: IMPORT_TIMEOUT_MS });
    filing.logCapture(filed ? `filed ${label}, part ${filed.segment + 1}, ${filed.turns} turns → ${filed.to}` : `nothing to file for ${label}`);
    writeState('session', input.session_id, { captureFailedAt: null });
  } catch (error) {
    // Written down, and remembered: the next session's catch-up files this one again even if nothing of it is filed yet.
    filing.logCapture(`FAILED ${label}: ${error && error.message ? error.message : 'unknown error'}`);
    writeState('session', input.session_id, { captureFailedAt: Date.now() });
  }
}

/**
 * At a new session's start, file again what this folder's other sessions did since they were last filed — rule-based
 * briefs, no model — until `deadline`; the rest goes on in a detached child. Returns when this repository's work was
 * last filed and when another session here last moved, for the summary to say how fresh it is; null when the Hub
 * cannot list what it holds (a Hub older than this hook).
 */
async function catchUp(cfg, { cwd, sessionId, repo, project, deadline = Infinity }) {
  const dir = transcriptDirFor(cwd);
  const remaining = () => Math.max(1000, Math.min(IMPORT_TIMEOUT_MS, deadline - Date.now()));
  const listed = await hub(cfg, `/api/uml/repo-memory?repo=${encodeURIComponent(repo)}&stretches=1`, {}, Math.min(5000, remaining())).catch(() => null);
  if (!dir || !listed || !Array.isArray(listed.stretches)) return null;
  // An archived stretch counts as filed and never as stale: filing it again would un-archive what its owner put away.
  const filed = new Map(listed.stretches.filter((s) => s && typeof s.threadKey === 'string').map((s) => [s.threadKey, s.archived ? Infinity : Date.parse(s.filedAt)]));
  const fresh = { filedUpTo: Math.max(0, ...[...filed.values()].filter(Number.isFinite)), activity: 0, pending: false };
  for (const t of filing.recentTranscripts(dir, sessionId)) {
    if (!transcriptIsFor(filing.readHead(t.file), cwd)) continue;
    fresh.activity = Math.max(fresh.activity, t.at);
    const failed = Boolean(readState('session', t.sessionId).captureFailedAt);
    if (!failed && !filing.mayBeStale(threadPrefix(t.sessionId), filed, t.at)) continue;
    const stale = filing.staleStretches({
      keyOf: (segment) => threadKeyFor(t.sessionId, segment), segments: segmentsFromTranscript(fs.readFileSync(t.file, 'utf8'), { cwd }),
      filed, lastActivityMs: t.at, wanted: failed,
    });
    for (const { segment, turns } of stale) {
      if (Date.now() >= deadline) { spawnHook(['catch-up', cwd, sessionId]); return { ...fresh, pending: true }; }
      const label = `session ${t.sessionId.slice(0, 8)} (catch-up), part ${segment + 1}, ${turns.length} turns`;
      writeState('session', t.sessionId, { fileSpawnedAt: Date.now() }); // its own Stop hook must not upload the same stretch at once
      try {
        const body = await fileStretch(cfg, { sessionId: t.sessionId, segment, turns, cwd, project, mechanicalOnly: true }, remaining());
        filing.logCapture(`filed ${label} → ${body.filedToName || 'just you'}`);
        writeState('session', t.sessionId, { captureFailedAt: null });
        fresh.filedUpTo = Date.now();
      } catch (error) {
        filing.logCapture(`FAILED ${label}: ${error && error.message ? error.message : 'unknown error'}`);
      }
    }
  }
  return fresh;
}

/** Where Claude Code keeps this folder's transcripts: ~/.claude/projects/<the path, every other character a dash>. */
function transcriptDirFor(cwd) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const match = fs.existsSync(root) ? fs.readdirSync(root).find((name) => name.toLowerCase() === slug) : null;
  return match ? path.join(root, match) : null;
}

/** PURE: does this transcript belong to this folder? Every entry records its cwd; a slug alone can collide. */
function transcriptIsFor(jsonl, cwd) {
  const want = path.resolve(cwd).toLowerCase();
  const first = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(jsonl);
  return Boolean(first) && path.resolve(JSON.parse(`"${first[1]}"`)).toLowerCase() === want;
}

/** `import`: file this repository's earlier sessions, oldest first so the newest is newest in Seturos too. Every
 *  stretch is refreshed under its own key, so running it twice re-files rather than duplicates. Stops the moment the
 *  Hub says it is distilling with a model — an import must not spend on briefs nobody asked a model to write. */
async function importSessions(cfg, args) {
  const flag = (name, fallback) => { const at = args.indexOf(name); return at !== -1 && args[at + 1] ? args[at + 1] : fallback; };
  const dry = args.includes('--dry-run');
  const cwd = process.cwd();
  const dir = flag('--transcripts', null) || transcriptDirFor(cwd);
  if (!dir || !fs.existsSync(dir)) throw new Error('no Claude Code transcripts for this folder');
  const only = flag('--session', null);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (!only || f.startsWith(only)))
    .map((f) => ({ file: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, only ? 1 : Math.max(1, Number(flag('--sessions', '5')) || 5)).reverse();
  if (only && files.length === 0) throw new Error(`no transcript for a session starting ${only} in ${dir}`);
  const project = dry ? null : await projectFor(cfg, cwd).catch(() => null);
  let filed = 0;
  for (const { file, at } of files) {
    const jsonl = fs.readFileSync(file, 'utf8');
    if (!flag('--transcripts', null) && !transcriptIsFor(jsonl, cwd)) continue;
    const sessionId = path.basename(file, '.jsonl');
    for (const { segment, turns } of segmentsFromTranscript(jsonl, { cwd })) {
      const stub = isSealedStub(turns);
      if (!stub && (turns.length < 2 || !turns.some((t) => t.role === 'user' && t.text !== ''))) continue;
      const label = `${new Date(at).toISOString().slice(0, 10)} ${sessionId.slice(0, 8)} part ${segment + 1}: ${stub ? 'sealed — the stub only' : `${turns.length} turns`}${!stub && turns.some((t) => t.text.startsWith(STUB)) ? ', ends where it read sealed material' : ''}`;
      if (dry) { console.log(`would file ${label}`); continue; }
      const body = await fileStretch(cfg, { sessionId, segment, turns, cwd, project, mechanicalOnly: !args.includes('--allow-model') }, IMPORT_TIMEOUT_MS);
      filed += 1;
      console.log(`filed ${label} → ${body.filedToName || 'just you'}${body.refreshed ? ' (refreshed)' : ''}`);
      if (body.distilling && !args.includes('--allow-model')) return console.log('stopped: the Hub is writing these briefs with a model. Re-run with --allow-model to accept that cost.');
    }
  }
  return console.log(dry ? 'dry run — nothing filed' : `${filed} stretch${filed === 1 ? '' : 'es'} filed`);
}

async function cli(cfg, mode, args) {
  if (mode === 'import') return importSessions(cfg, args);
  const repo = repoKeyForDir(process.cwd());
  if (mode === 'ask') {
    const question = args.join(' ').trim();
    if (question === '') return console.log('usage: seturos-compact-hook.cjs ask "<question, in the words the answer would use>"');
    const project = await projectFor(cfg, process.cwd()).catch(() => null);
    const params = new URLSearchParams({ q: question });
    if (project && project.id) params.set('projectId', project.id);
    if (repo) params.set('repo', repo);
    const body = await hub(cfg, `/api/uml/resume?${params}`);
    return console.log(body.evidence || 'Nothing in Seturos matches that. Try the words the answer itself would use — a file, a command, a name.');
  }
  if (!repo) throw new Error('this folder is not a git repository with a remote, so there is nothing to link');
  if (mode === 'link' && args.length === 0) {
    const link = await hub(cfg, `/api/uml/repo-link?repo=${encodeURIComponent(repo)}`);
    return console.log(link.linked ? `${repo} → ${link.projectName}${link.mayWork ? '' : ' (you are not on it, so your sessions stay yours)'}` : `${repo} is not linked; sessions here stay yours. Link it: link "<project>"`);
  }
  if (mode === 'link') {
    const body = await hub(cfg, '/api/uml/repo-link', { method: 'PUT', body: JSON.stringify({ repo, project: args.join(' ') }) });
    return console.log(`linked ${body.repo} → ${body.projectName}. Every session here files there from its next start.`);
  }
  await hub(cfg, `/api/uml/repo-link?repo=${encodeURIComponent(repo)}`, { method: 'DELETE' });
  return console.log(`unlinked ${repo}; sessions here stay yours.`);
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

async function main() {
  const [mode, ...given] = process.argv.slice(2);
  const args = given.filter((a) => a !== '--plugin'); // a mode flag, never part of a question or a project name
  if (given.includes('--plugin')) {
    // A repository with its own copy of these hooks (scripts/seturos-install-hooks.cjs) runs that one; the plugin's
    // copy steps aside, so a session is never filed twice or told everything twice.
    const own = process.env.CLAUDE_PROJECT_DIR && path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'hooks', HOOK_FILE_NAME);
    if (HOOK_MODES.includes(mode) && own && path.resolve(own) !== path.resolve(__filename) && fs.existsSync(own)) return undefined;
    AUTO_SIGN_IN = false;
    HOOK_COMMAND = `node "${__filename.split(path.sep).join('/')}"`;
  }
  const cfg = config(process.env);
  if (mode === 'status') {
    const input = await readStdin();
    const dir = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
    const state = readState('session', input.session_id);
    return process.stdout.write(cfg.token === '' ? '' : statusText('project' in state ? state.project : readState('dir', path.resolve(dir)).project));
  }
  if (mode === 'sign-in') {
    const result = await signin.signIn(cfg.hub, { env: process.env });
    if (!args.includes('--background')) console.log(result.ok ? `signed in: ${result.label}. Sessions here are recorded from the next message.` : `not signed in — ${result.reason}`);
    return undefined;
  }
  if (mode === 'capture-codex') {
    // node seturos-compact-hook.cjs capture-codex [--dry-run] [--all] [--days N] [--repo <remote or key>]
    if (cfg.token === '' && !args.includes('--dry-run')) throw Object.assign(new Error(`not signed in on this computer — run: ${HOOK_COMMAND} sign-in`), { cli: true });
    const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
    const only = flag('--repo', null);
    const filed = await captureCodex(cfg, {
      onlyRepo: only ? repoKeyFrom(only) : null, days: Number(flag('--days', '3')) || 3,
      dry: args.includes('--dry-run'), all: args.includes('--all'), log: (l) => console.log(l),
    });
    return console.log(args.includes('--dry-run') ? 'dry run — nothing filed' : `${filed} Codex stretch${filed === 1 ? '' : 'es'} filed`);
  }
  if (mode === 'sign-out') {
    signin.signOut(process.env);
    return console.log('signed out on this computer. Its token stays listed in Seturos until you revoke it there.');
  }
  if (['ask', 'link', 'unlink', 'import'].includes(mode)) {
    if (cfg.token === '') throw Object.assign(new Error(`not signed in on this computer — run: ${HOOK_COMMAND} sign-in`), { cli: true });
    return cli(cfg, mode, args).catch((e) => { throw Object.assign(e, { cli: true }); });
  }
  if (mode === 'capture-file') return cfg.token === '' ? undefined : captureFile(cfg, args[0]);
  if (mode === 'catch-up') {
    // The rest of a SessionStart catch-up, detached: args are the folder and the session that started.
    const repo = args[0] ? repoKeyForDir(args[0]) : null;
    if (cfg.token === '' || !repo) return undefined;
    return catchUp(cfg, { cwd: args[0], sessionId: args[1], repo, project: await projectFor(cfg, args[0]).catch(() => null) });
  }
  const input = await readStdin();
  // Before approval, a plugin leaves a session exactly as it found it: no rule reminders, no claim check.
  if (!AUTO_SIGN_IN && cfg.token === '' && (mode === 'pre-tool' || mode === 'stop')) return undefined;
  if (mode === 'pre-tool') return onPreTool(input);
  if (mode === 'stop') return onStop(cfg, input);
  if (cfg.token === '') {
    // NOT SILENT ANY MORE. "The token is not set" went to stderr, which nobody sees, and a session ran unrecorded while
    // looking recorded. A start asks for the sign-in (once — see seturos-hook-signin.cjs) and says so where it shows.
    if (mode === 'session-start') signInAsked = AUTO_SIGN_IN ? signin.requestSignIn(process.env, cfg.hub, __filename) : signin.offNoticeDue(process.env) ? 'off' : '';
    const notice = signin.signInNotice(signInAsked, HOOK_COMMAND);
    if (notice !== '') process.stdout.write(JSON.stringify({ systemMessage: notice }));
    return;
  }
  if (mode === 'pre-compact') await preCompact(cfg, input);
  else if (mode === 'session-start') {
    let started = { text: '', notice: '' };
    try { started = await sessionStart(cfg, input); } catch (error) { if (signInAsked === '') throw error; }
    const { text } = started;
    const notice = [signin.signInNotice(signInAsked, HOOK_COMMAND), started.notice].filter((n) => n).join('\n');
    if (notice !== '') process.stdout.write(JSON.stringify({ systemMessage: notice, ...(text !== '' ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {}) }));
    else if (text !== '') process.stdout.write(`${text}\n`);
  }
  else if (mode === 'prompt') await onPrompt(cfg, input);
  else if (mode === 'session-end') sessionEnd(input);
  else process.stderr.write('seturos: usage — pre-compact | session-start | prompt | pre-tool | stop | session-end | ask | link | unlink | import | status | sign-in | sign-out | capture-codex\n');
}

if (require.main === module) {
  main().then(() => { process.exitCode = 0; }).catch((error) => {
    process.stderr.write(`seturos: ${error && error.message ? error.message : 'the hook failed'}\n`);
    process.exitCode = error && error.cli ? 1 : 0;
  });
}

module.exports = {
  turnsFromTranscript, segmentsFromTranscript, threadKeyFor, rulesQuery, matchProject, config, withoutInjected,
  sessionStartText, projectStartText, repoStartText, askLine, transcriptIsFor, freshnessLine, cutAtBoundary, sessionLabel,
  sealNotice, sealRecapLine, sealStartNotice, sealNoticeFor,
};
