'use strict';

// seturos-hook-signin.cjs — how the hooks know who you are, without anybody pasting a token.
//
// The hooks used to authenticate with SETUROS_MCP_TOKEN, copied by hand out of Settings → Profile into a settings
// file. Every step of that is a place to fail — generate, copy, find the right file, paste, restart — and when the
// token stopped working (a revocation, a database move) nothing said so: the hooks exited quietly and a session went
// unrecorded while looking recorded. So a credential is now found, or asked for, in this order:
//
//   1. THIS COMPUTER'S OWN SIGN-IN for the Hub — ~/.seturos/credentials.json, written by an Approve click (below).
//   2. SETUROS_MCP_TOKEN, when it is set: the explicit override, kept for a developer pointing at a local Hub.
//   3. THE DESKTOP APP'S SIGN-IN for the same Hub. The app is the same person on the same computer and already
//      approved in a browser; asking them to approve again, for a second program, would be the ceremony this file
//      exists to remove. It is read, never written.
//
// A token the Hub refused is skipped for an hour (DEAD_MS), so a dead one earlier in the list does not hide a live one
// later — which is exactly how an old SETUROS_MCP_TOKEN would otherwise shadow a working desktop sign-in forever.
//
// WITH NONE, THE HOOK ASKS ONCE. It opens the same page the desktop app signs in with — /desktop/pair, one Approve
// click, a per-computer token posted straight back to a port on 127.0.0.1 — from a detached process, so no hook ever
// waits on a person. An Approve page nobody answers is not opened again by itself for COOLDOWN_MS; `sign-in` in the
// terminal always opens one.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const WAIT_MS = 10 * 60 * 1000; // how long an Approve page stays answerable
const COOLDOWN_MS = 12 * 3600 * 1000; // after an unanswered page, before one opens again on its own
const DEAD_MS = 3600 * 1000; // how long a refused token is skipped before it is tried again
const OFF_NOTICE_MS = 7 * 24 * 3600 * 1000; // as a plugin, how often a session is reminded that memory is off
const MAX_BODY = 8192;
const TOKEN_RE = /^(?:tfd|stk)_[A-Za-z0-9_-]{16,200}$/;
const DEVICE_RE = /^tfd_[A-Za-z0-9_-]{16,200}$/;
const DEFAULT_HUB = 'https://app.seturos.com';

const normalizeHub = (v) => String(v || '').trim().replace(/\/+$/, '') || DEFAULT_HUB;

/** Where this computer's Seturos files live. SETUROS_HOME moves it, for tests. */
function homeDir(env = process.env) {
  return env.SETUROS_HOME ? path.resolve(env.SETUROS_HOME) : path.join(os.homedir(), '.seturos');
}
const files = (env) => {
  const dir = homeDir(env);
  return { dir, cred: path.join(dir, 'credentials.json'), pending: path.join(dir, 'sign-in.json'), dead: path.join(dir, 'refused-tokens.json'), offNotice: path.join(dir, 'memory-off-notice.json') };
};

/** Where the desktop app keeps its sign-in: Electron's userData for the product name "Seturos". */
function desktopDeviceFile(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SETUROS_DESKTOP_DEVICE) return path.resolve(env.SETUROS_DESKTOP_DEVICE);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Seturos', 'device.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Seturos', 'device.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Seturos', 'device.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', ...(mode ? { mode } : {}) });
}

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24);

function refusedRecently(env, token, now = Date.now()) {
  const at = (readJson(files(env).dead) || {})[hashOf(token)];
  return typeof at === 'number' && now - at < DEAD_MS;
}

/** The Hub said no to this token. Remembered by HASH — the list must not become a second copy of the secret. */
function markRefused(env, token, now = Date.now()) {
  if (!token) return;
  const f = files(env).dead;
  const list = readJson(f) || {};
  list[hashOf(token)] = now;
  const kept = Object.entries(list).filter(([, at]) => typeof at === 'number' && now - at < DEAD_MS).slice(-20);
  try { writeJson(f, Object.fromEntries(kept)); } catch { /* best effort — the worst case is one wasted request */ }
}

/** The credential the hooks should use for `hub`: `{ token, source }`, source 'signed-in' | 'env' | 'desktop' | 'none'. */
function resolveCredential(env, hub) {
  const want = normalizeHub(hub);
  const usable = (t) => typeof t === 'string' && t !== '' && !refusedRecently(env, t);
  const own = readJson(files(env).cred);
  if (own && TOKEN_RE.test(String(own.token)) && normalizeHub(own.hub) === want && usable(own.token)) return { token: own.token, source: 'signed-in' };
  const fromEnv = String(env.SETUROS_MCP_TOKEN || '').trim();
  if (usable(fromEnv)) return { token: fromEnv, source: 'env' };
  const desk = readJson(desktopDeviceFile(env));
  if (desk && DEVICE_RE.test(String(desk.token)) && normalizeHub(desk.hub) === want && usable(desk.token)) return { token: desk.token, source: 'desktop' };
  return { token: '', source: 'none' };
}

/** PURE: the Approve page — the desktop app's own, told which program is asking. */
function pairUrl(hub, port, state, name) {
  const url = new URL('/desktop/pair', normalizeHub(hub));
  url.searchParams.set('port', String(port));
  url.searchParams.set('state', state);
  url.searchParams.set('name', name);
  url.searchParams.set('client', 'claude-code');
  return url.toString();
}

/** Hand a URL to the default browser without a shell, so nothing in it is ever interpreted. */
function openBrowser(url, env = process.env) {
  if (env.SETUROS_OPEN_BROWSER === 'print') { process.stdout.write(`${url}\n`); return; } // headless machines and tests
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Open the Approve page and wait for the answer on loopback. Resolves `{ ok: true, label }` or `{ ok: false, reason }`.
 * The loopback half is the desktop app's (desktop/hub.js signIn), so the page cannot tell the two callers apart.
 */
function signIn(hub, { env = process.env, name = os.hostname(), waitMs = WAIT_MS, opener = openBrowser } = {}) {
  const origin = normalizeHub(hub);
  const state = crypto.randomBytes(16).toString('hex');
  const label = `Claude Code on ${name}`;
  const f = files(env);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const server = http.createServer((req, res) => {
      // An https page POSTing to http on 127.0.0.1 is both cross-origin and into the private address space;
      // without Allow-Private-Network the browser never sends it, and this port looks broken rather than unasked.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== 'POST' || !String(req.url || '').startsWith('/paired')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not here');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        const reply = new URLSearchParams(body);
        const token = reply.get('token') || '';
        const ok = reply.get('state') === state && DEVICE_RE.test(token);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(ok ? 'signed in' : 'not this sign-in');
        // A reply for some other attempt is IGNORED, not fatal — the page stays answerable for the real one.
        if (!ok) return;
        try {
          writeJson(f.cred, { token, hub: origin, label, pairedAt: new Date().toISOString() }, 0o600);
          finish({ ok: true, label });
        } catch (error) {
          finish({ ok: false, reason: `could not save the sign-in (${error.message})` });
        }
      });
    });
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      try { writeJson(f.pending, { hub: origin, endedAt: Date.now(), ok: result.ok }); } catch { /* bookkeeping only */ }
      resolve(result);
    }
    server.on('error', (error) => finish({ ok: false, reason: `could not open a local port (${error.message})` }));
    // 127.0.0.1 EXPLICITLY — this port exists for one browser tab on this computer, never for the network.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      timer = setTimeout(() => finish({ ok: false, reason: 'nobody approved it in time' }), waitMs);
      try { writeJson(f.pending, { hub: origin, startedAt: Date.now(), pid: process.pid }); } catch { /* bookkeeping only */ }
      try { opener(pairUrl(origin, port, state, name), env); } catch (error) { finish({ ok: false, reason: `could not open a browser (${error.message})` }); }
    });
  });
}

/**
 * Ask for a sign-in WITHOUT WAITING for it: a detached `sign-in --background` does the waiting. Returns what happened,
 * for the one line the session is told — 'opened' | 'waiting' (a page is already open) | 'cooling' (one went
 * unanswered recently; the terminal command still works).
 */
function requestSignIn(env, hub, hookFile, now = Date.now()) {
  const origin = normalizeHub(hub);
  const p = readJson(files(env).pending);
  if (p && p.hub === origin) {
    // pid 0 is the moment between asking and the detached process writing its own pid.
    const waiting = p.pid ? alive(p.pid) : now - p.startedAt < 30 * 1000;
    if (p.startedAt && !p.endedAt && now - p.startedAt < WAIT_MS && waiting) return 'waiting';
    if (p.endedAt && p.ok === false && now - p.endedAt < COOLDOWN_MS) return 'cooling';
  }
  try { writeJson(files(env).pending, { hub: origin, startedAt: now, pid: 0 }); } catch { /* bookkeeping only */ }
  const child = spawn(process.execPath, [hookFile, 'sign-in', '--background'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, SETUROS_HUB: origin },
  });
  child.unref();
  return 'opened';
}

/**
 * AS A PLUGIN, ASKED FOR, NEVER OPENED. A plugin's hooks run in every project, so nobody is sent to a browser by a
 * session starting: the session is told memory is off, and how to turn it on — once a week at most, so a person who
 * chose not to is not nagged. True when the reminder is due now (and records that it was shown).
 */
function offNoticeDue(env, now = Date.now()) {
  const f = files(env).offNotice;
  const last = readJson(f);
  if (last && typeof last.shownAt === 'number' && now - last.shownAt < OFF_NOTICE_MS) return false;
  try { writeJson(f, { shownAt: now }); } catch { /* a reminder that cannot be recorded is shown again next time */ }
  return true;
}

function signOut(env) {
  try { fs.rmSync(files(env).cred, { force: true }); return true; } catch { return false; }
}

/** PURE: the one line a session is shown about signing in, or '' when there is nothing to say. */
function signInNotice(outcome, hookCommand) {
  if (outcome === 'opened') return 'Seturos: approve this computer in the browser tab that just opened — one click, once. Sessions here are recorded from then on.';
  if (outcome === 'waiting') return 'Seturos: waiting for you to approve this computer in the browser tab it opened. Until then this session is not recorded.';
  if (outcome === 'off') return 'Seturos memory is off on this computer, so this session is not saved. To turn it on, run /seturos:connect: it opens a page to approve this computer, once.';
  if (outcome === 'cooling') return `Seturos is not signed in on this computer, so this session is not recorded. To approve it: ${hookCommand} sign-in`;
  return '';
}

module.exports = {
  resolveCredential, markRefused, refusedRecently, requestSignIn, signIn, signOut, signInNotice, pairUrl, offNoticeDue,
  desktopDeviceFile, homeDir, normalizeHub, WAIT_MS, COOLDOWN_MS, DEAD_MS, OFF_NOTICE_MS,
};
