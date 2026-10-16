'use strict';

// SETUROS × CLAUDE CODE — which repository this is, which project it works on, and the session's own small state.
// Loaded by seturos-compact-hook.cjs; copied beside it by the installer. No dependencies; Node 18+.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * PURE: a git remote → the key a repository is known by, or null. MIRRORS lib/uml/repo-link.ts `repoKeyFrom` —
 * the hook cannot import TypeScript, and the two must agree or a link made from one clone is invisible to another.
 * smoke:repo-link runs the same remotes through both.
 */
function repoKeyFrom(remote) {
  let s = String(remote == null ? '' : remote).trim();
  if (s === '' || /^(?:file:|[a-z]:[\\/]|[\\/.~])/i.test(s)) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '');
  s = s.replace(/^([^/:]+):\d+\//, '$1/').replace(/\.git\/?$/i, '').replace(/\/+$/, '').toLowerCase();
  const [host, ...rest] = s.split('/');
  if (!host || !host.includes('.') || rest.length === 0 || rest.some((p) => p === '' || p === '..')) return null;
  return s.length <= 200 && /^[a-z0-9._~/-]+$/.test(s) ? s : null;
}

/** PURE: the text of a .git/config → the `origin` remote's url, else the first remote's, else ''. */
function originUrl(configText) {
  const remotes = {};
  let current = null;
  for (const line of String(configText || '').split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/.exec(line);
    if (section) { current = section[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const url = current ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url && !remotes[current]) remotes[current] = url[1];
  }
  return remotes.origin || Object.values(remotes)[0] || '';
}

/** The repository key for a working directory — the nearest .git upward, including a worktree's `.git` file. Reads
 *  the config directly rather than running git: a hook must not depend on git being on PATH. */
function repoKeyForDir(dir) {
  let at = path.resolve(dir || '.');
  for (let depth = 0; depth < 40; depth++) {
    const dotGit = path.join(at, '.git');
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const pointer = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer) return null;
        gitDir = path.resolve(at, pointer[1].trim());
        const common = path.join(gitDir, 'commondir'); // a worktree keeps its remotes in the main repository
        if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
      }
      const config = path.join(gitDir, 'config');
      return fs.existsSync(config) ? repoKeyFrom(originUrl(fs.readFileSync(config, 'utf8'))) : null;
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

// ── state ──────────────────────────────────────────────────────────────────────────────────────────────
// What one hook call learns and a later one needs: the project resolved at SessionStart (so a prompt, a tool call or
// the status line never pays a network round trip for it), the settled rules, which rules were already raised.
// Per session, in the OS temp directory — never in the repository.

const STATE_DIR = path.join(os.tmpdir(), 'seturos-hook');
const safeName = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

function statePath(kind, id) {
  return path.join(STATE_DIR, `${kind}-${safeName(id)}.json`);
}

function readState(kind, id) {
  if (!id) return {};
  try { return JSON.parse(fs.readFileSync(statePath(kind, id), 'utf8')); } catch { return {}; }
}

function writeState(kind, id, patch) {
  if (!id) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(kind, id), JSON.stringify({ ...readState(kind, id), ...patch, at: Date.now() }));
  } catch { /* state is an optimisation; a hook without it still works */ }
}

/** Old sessions' state goes after a week. Opportunistic, at session start, and never an error. */
function sweepState(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name);
      if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
    }
  } catch { /* nothing to sweep */ }
}

// ── the live sessions the desktop dock shows ───────────────────────────────────────────────────────
// The desktop app reads only the NAME of the app in front — never window titles — so it cannot know which repository
// a coding app is in. The hooks already know exactly, so they say: one small local file, repository and where its
// work is filed, nothing from the conversation. A session gone quiet for twelve hours is dropped.

const LIVE_FILE = path.join(os.homedir(), '.seturos', 'live-sessions.json');
const LIVE_MAX_AGE_MS = 12 * 3600 * 1000;

function readLive(file = LIVE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/** Record this session as live (`entry`), or gone (`null`). Never an error: the dock is a view, not a dependency. */
function writeLive(sessionId, entry, file = LIVE_FILE) {
  if (!sessionId) return;
  try {
    const all = readLive(file);
    const now = Date.now();
    for (const [id, s] of Object.entries(all)) if (!s || now - (s.at || 0) > LIVE_MAX_AGE_MS) delete all[id];
    if (entry === null) delete all[sessionId];
    else all[sessionId] = { ...entry, at: now };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all));
  } catch { /* the session runs the same without it */ }
}

/** PURE: the status line. Says where this session's work goes — the thing a person otherwise cannot see. */
function statusText(project) {
  if (!project || (!project.id && !project.name)) return 'Seturos → just you';
  if (!project.id) return `Seturos → just you (not on ${project.name})`;
  return `Seturos → ${project.name}`;
}

module.exports = { repoKeyFrom, originUrl, repoKeyForDir, readState, writeState, sweepState, statusText, readLive, writeLive };
