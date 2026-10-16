'use strict';

// SETUROS × CLAUDE CODE — what a session may not carry: sealed material, and everything a session says after reading it.
// Loaded by seturos-hook-transcript.cjs; copied beside it by the installer. No dependencies; Node 18+.
//
// SEALED is a `*.sealed.*` file, a folder named `*.sealed`, or anything inside a folder holding a `.seturos-sealed` file.
//
// KEEPING THE FILE OUT WAS NOT ENOUGH. The hook recorded a sealed file as touched and never stored its body — and an
// evaluation still read its own answers back out of Seturos, 34 times. They came from a later session that had read the
// eval's findings (not a sealed file), and then retold them: in its replies, and in a search command built from the
// answers. What an agent has read, it repeats. So READING sealed material ends what is kept of that session: everything
// before it is filed as usual, and in place of the rest one line says why it stops. WRITING a sealed file does not: the
// session writing an answer sheet is the work the sheet was written from — only the body it wrote is left out.
//
// WHAT A COMMAND CAN SHOW, NOT WHAT IT NAMES. On 2026-09-25 a loop printing four paths' modification times —
// `for f in … docs/seturos-eval; do printf … "$(date -u -r "$f" …)" "$f"; done` — ended what was kept of a session
// that went on for another day: billing, trials, a website, rate limits, a DNS move, none of it filed, and nobody told.
// The folder was NAMED, so it counted as read; not one line of it was shown. So a name where no contents can come out
// reads nothing: a metadata program (`date -r`, `stat`, `wc`, `find` without `-exec`, `git log` without a patch), or a
// loop's list whose body only takes metadata. A name a reading program gets still reads — directly, through a loop
// variable, a `$( )` substitution, an input redirect or a glob. And a command that names sealed material without
// reading it, by these rules, is checked by what it printed: output carrying that material's own lines has read it.
//
// A READING command is not cleared by its output. A script given the answer key that prints "Q3 expected 7824567" has
// read it, and prints no line of the key — the paraphrase is how the 34 leaked answers travelled.

const fs = require('node:fs');
const path = require('node:path');

const SEALED_NAME = /\.sealed(?:\.[^/]*)?$/i; // a path segment: `answers.sealed.md`, or a folder `eval.sealed`
const MARKER = '.seturos-sealed';
const STUB = 'Seturos stopped keeping this session here';

/** PURE: a turn text that stands in for the part of a session that is not kept — filed even though nobody spoke in it. */
function isSealedStub(turns) {
  return Array.isArray(turns) && turns.length > 0 && turns.every((t) => t && typeof t.text === 'string' && t.text.startsWith(STUB));
}

/** PURE: the line that replaces what a session did after reading `shown`. */
function stubText(shown) {
  return `${STUB}: it read sealed material (${shown}), such as an evaluation's answers, and anything it said or did after that could repeat them.`;
}

// Programs that run over a path without printing what is in it. Anything else that names a sealed path has read it.
const NON_READING = new Set([
  'cd', 'ls', 'dir', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'touch', 'chmod', 'chown', 'stat', 'test', '[', 'du', 'echo', 'printf',
  'code', 'start', 'explorer', 'open', 'realpath', 'readlink', 'basename', 'dirname', 'pwd', 'which', 'type', 'file', 'wc',
  'tree', 'md5sum', 'sha1sum', 'sha256sum', 'true', 'false', 'sleep', 'tee',
]);
// These read nothing until given the flag that makes them read: `date -r f` prints f's time, `date -f f` reads dates
// out of it; `find` prints names until `-exec` runs something on them.
const READS_WHEN = {
  date: (words) => words.some((w) => w === '-f' || w.startsWith('--file')),
  find: (words) => words.some((w) => ['-exec', '-execdir', '-ok', '-okdir'].includes(w)),
};
const GIT_NON_READING = new Set(['add', 'status', 'mv', 'rm', 'commit', 'restore', 'checkout', 'switch', 'stash', 'reset', 'push', 'pull', 'fetch', 'ls-files', 'check-ignore', 'clean', 'update-index']);
const GIT_PATCH = (words) => words.some((w) => ['-p', '-u', '--patch'].includes(w) || /^-L/.test(w) || w.startsWith('--word-diff'));
const GIT_NAMES_ONLY = (words) => words.some((w) => ['--stat', '--name-only', '--name-status', '--numstat', '--shortstat', '--summary', '--dirstat'].includes(w.split('=')[0]));
// Words that open or close a compound command rather than name a program: `do cat "$f"` runs cat.
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'done', 'fi', 'esac']);
const WRAPPERS = new Set(['sudo', 'time', 'env', 'nohup', 'command', 'exec', 'export', 'local', 'declare', 'readonly']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The first operand of these is a pattern or a script, not a file — unless one came with -e (then every operand is a
// file) or -f (then the file after it is read). `grep -vE "…|docs/seturos-eval|…"` leaves that folder OUT of what it
// shows; on 2026-09-26 the old rule read that pattern as a path and ended a session a second time.
const PATTERN_FIRST = {
  grep: ['-A', '-B', '-C', '-m', '-d', '-D', '--max-count', '--context', '--after-context', '--before-context', '--label', '--color', '--colour'],
  rg: ['-A', '-B', '-C', '-m', '-g', '-t', '-T', '-j', '-M', '-E', '--glob', '--iglob', '--type', '--type-not', '--threads', '--max-columns', '--max-count', '--context', '--after-context', '--before-context', '--encoding', '--max-depth', '--sort', '--sortr'],
  awk: ['-F', '-v'],
  sed: ['-l'],
};
const PATTERN_ALIAS = { egrep: 'grep', fgrep: 'grep', ag: 'grep', ack: 'grep', gawk: 'awk', mawk: 'awk' };
// What these flags carry is a message or a path left OUT, not a path read: `--body "…docs/eval…"`, `--exclude-dir=docs/eval`.
const MESSAGE_FLAG = /^--?(?:m|message|body|title|notes|description|subject|comment)$/;
const LEAVES_OUT = /^--?(?:exclude|exclude-dir|exclude-from|ignore|ignore-file|ignore-dir|skip)$/;
// Shells handed a command string: what they run is scanned as a command of its own.
const SHELLS = { bash: '-c', sh: '-c', zsh: '-c', dash: '-c', powershell: '-command', pwsh: '-command', cmd: '/c' };
const SUB = /\u0001\d+\u0001/g; // where a `$( )` stood in a word: what it runs is checked as a command of its own

/** Index of the `)` that closes a `$(`, `<(` or `>(` whose body starts at `i` — past quotes and nested parentheses. */
function closeParen(s, i) {
  let depth = 1;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const e = s.indexOf("'", j + 1); j = e === -1 ? s.length : e; continue; }
    if (c === '"') { j = closeQuote(s, j + 1); continue; }
    if (c === '`') { const e = s.indexOf('`', j + 1); j = e === -1 ? s.length : e; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return s.length;
}

/** Index of the `"` that closes a double-quoted string starting at `i` — `"$(date -r "$f")"` is one string. */
function closeQuote(s, i) {
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '"') return j;
    if (c === '$' && s[j + 1] === '(') { j = closeParen(s, j + 2); continue; }
    if (c === '`') { const e = s.indexOf('`', j + 1); j = e === -1 ? s.length : e; }
  }
  return s.length;
}

/**
 * PURE: a shell command → its simple commands, each `{ words, subs }`: words with quotes removed, and the text of every
 * `$( )`, `<( )`, `>( )` and backquote in it, which runs as a command of its own. Not a shell, but it keeps what a shell
 * keeps together: a quoted message spanning lines is one word, and a heredoc's body is nobody's command — a commit
 * message that MENTIONS a sealed folder has not read it.
 */
function parseCommands(command) {
  const s = String(command || '');
  const out = [];
  let words = [];
  let quoted = []; // per word: was any of it quoted — a shell expands no glob inside quotes
  let subs = [];
  let word = null;
  let wordQuoted = false;
  let quote = null;
  let heredoc = null;
  const endWord = () => { if (word !== null) { words.push(word); quoted.push(wordQuoted); } word = null; wordQuoted = false; };
  const endCommand = () => { endWord(); if (words.length > 0 || subs.length > 0) out.push({ words, quoted, subs }); words = []; quoted = []; subs = []; };
  // A substitution's text is set aside and a marker left in the word, so `"$(cat x)"` is not the word `$(cat`.
  const substitute = (start, end, next) => { subs.push(s.slice(start, end)); word = `${word || ''}\u0001${subs.length - 1}\u0001`; return next; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    const opens = c === '$' && s[i + 1] === '(' && s[i + 2] !== '(';
    if (opens || (!quote && (c === '<' || c === '>') && s[i + 1] === '(')) { const end = closeParen(s, i + 2); i = substitute(i + 2, end, end); continue; }
    if (c === '`') { const e = s.indexOf('`', i + 1); const end = e === -1 ? s.length : e; i = substitute(i + 1, end, end); continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length) word += s[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; word = word || ''; wordQuoted = true; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (m) { heredoc = m[2]; i += m[0].length - 1; endWord(); continue; }
    }
    if (c === '\n') {
      endCommand();
      if (heredoc) {
        const end = s.slice(i + 1).search(new RegExp(`^\\s*${heredoc}\\s*$`, 'm'));
        i = end === -1 ? s.length : s.indexOf('\n', i + 1 + end);
        if (i === -1) i = s.length;
        heredoc = null;
      }
      continue;
    }
    if (c === ';' || c === '|' || (c === '&' && s[i + 1] === '&')) { endCommand(); if (s[i + 1] === c) i += 1; continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word = (word || '') + c;
  }
  endCommand();
  return out;
}

/** PURE: a shell command → its simple commands, each as words with quotes removed (parseCommands without the subs). */
function simpleCommands(command) {
  return parseCommands(command).map((c) => c.words.map((w) => w.replace(SUB, ''))).filter((w) => w.some((x) => x !== ''));
}

/** PURE: one glob segment → a matcher, or null when it is no pattern at all — code in a string (`$rows[$n-1]`) is not a
 *  glob, and a hook never throws on what it reads. `*` and `?` stay inside the segment, `{a,b}` is either, `[!x]` is not x. */
function segmentMatcher(seg, win) {
  try { return globSegment(seg, win); } catch { return null; }
}

function globSegment(seg, win) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const e = seg.indexOf(']', i + 1); if (e === -1) re += '\\['; else { re += `[${seg.slice(i + 1, e).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = e; } }
    else if (c === '{') { const e = seg.indexOf('}', i + 1); if (e === -1) re += '\\{'; else { re += `(?:${seg.slice(i + 1, e).split(',').map((a) => a.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`; i = e; } }
    else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, win ? 'i' : '');
}

// Output "carries a sealed file's lines" when it holds this many of them — distinct, each long enough and wordy enough
// to be that file's own sentence rather than a brace, a separator or a short command every file has.
const MIN_SHARED_LINES = 3;
const MIN_LINE_CHARS = 24;
const MAX_FILES_READ = 200; // of one named sealed folder, when its lines are compared with what a command printed
const MAX_FILE_BYTES = 1_000_000;

/** PURE: one line as it is compared — no line number (`   12→`, `12:`), no `path:12:` prefix, spaces collapsed. */
function comparable(line) {
  return String(line)
    .replace(/^\s*\d+\s*(?:→|\t|:|\|)\s?/, '')
    .replace(/^[^\s:]+:\d+[:-]/, '')
    .trim().replace(/\s+/g, ' ').toLowerCase();
}
const distinctive = (l) => l.length >= MIN_LINE_CHARS && (l.match(/[a-z]{3,}/g) || []).length >= 3;

/**
 * Where sealed material is, for one session's folder. `exists`, `list` and `readFile` are injectable so the rule is
 * testable without a disk.
 *   isSealed(p)          a path — absolute, relative to `cwd`, Windows or Git-Bash spelling — is sealed
 *   commandReads(c)      the sealed path a shell command reads, or null (a redirect target is written, not read)
 *   commandTouch(c)      `{ read, named }`: what it reads, and the sealed paths it names without reading them
 *   showsContentOf(n, t) the sealed path among `n` whose own lines output `t` carries, or null
 *   sealedLine(l)        a line of output names a sealed path: `grepContent` when it carries that file's content
 */
function sealedCheck({
  cwd = process.cwd(),
  exists = fs.existsSync,
  list = (dir) => fs.readdirSync(dir),
  readFile = (file) => { const st = fs.statSync(file); return st.isFile() && st.size <= MAX_FILE_BYTES ? fs.readFileSync(file, 'utf8') : null; },
} = {}) {
  const marked = new Map();
  const win = process.platform === 'win32' || /^[a-z]:[\\/]/i.test(String(cwd));
  // A path as one absolute spelling. `keepGlob` leaves a pattern whole for globMatches; otherwise a glob stands for the
  // folder it starts in.
  const normal = (p, base = cwd, keepGlob = false) => {
    let s = String(p || '').trim().replace(/\\/g, '/');
    if (s === '') return '';
    if (win && /^\/[a-z](?:\/|$)/i.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`; // Git Bash: /d/TASKFLUENT → d:/TASKFLUENT
    const glob = s.search(/[*?[{]/);
    if (glob !== -1 && !keepGlob) s = s.slice(0, glob).replace(/[^/]*$/, '') || '.';
    const abs = /^(?:[a-z]:\/|\/)/i.test(s) ? s : path.posix.join(String(base).replace(/\\/g, '/'), s);
    return path.posix.normalize(abs).replace(/\/+$/, '');
  };
  // Listed once per folder: a session runs the same globs hundreds of times, and re-listing was 60% of a parse.
  const listed = new Map();
  const children = (dir) => {
    const key = dir || '/';
    if (!listed.has(key)) { let names = []; try { names = list(key); } catch { names = []; } listed.set(key, names); }
    return listed.get(key);
  };
  /** What a glob names on disk (bounded): `docs/*\/findings.md` reads the findings in every folder under docs. */
  const globMatches = (pattern, base) => {
    const parts = normal(pattern, base, true).split('/');
    let found = [parts[0]];
    for (let i = 1; i < parts.length && found.length > 0; i++) {
      const seg = parts[i];
      if (!/[*?[{]/.test(seg)) { found = found.map((p) => `${p}/${seg}`); continue; }
      if (seg === '**') {
        const deep = [];
        const walk = (d, depth) => { deep.push(d); if (depth < 6 && deep.length < 2000) for (const n of children(d)) walk(`${d}/${n}`, depth + 1); };
        for (const p of found) walk(p, 0);
        found = deep;
        continue;
      }
      const match = segmentMatcher(seg, win);
      if (!match) return [];
      // As a shell globs: `*` passes over dotfiles — `docs/eval/*` is the findings, not the `.seturos-sealed` marker.
      const hidden = seg.startsWith('.');
      found = found.flatMap((p) => children(p).filter((n) => (hidden || !n.startsWith('.')) && match.test(n)).map((n) => `${p}/${n}`)).slice(0, 500);
    }
    return found;
  };
  const markerIn = (dir) => {
    if (!marked.has(dir)) {
      let found = false;
      try { found = exists(`${dir}/${MARKER}`); } catch { found = false; }
      marked.set(dir, found);
    }
    return marked.get(dir);
  };
  const isSealed = (p, base) => {
    const abs = normal(p, base);
    if (abs === '') return false;
    const parts = abs.split('/');
    if (parts.some((seg) => SEALED_NAME.test(seg))) return true;
    for (let i = parts.length; i > 1; i--) if (markerIn(parts.slice(0, i).join('/'))) return true;
    return false;
  };
  const present = (p, base) => { try { return exists(normal(p, base)); } catch { return false; } };
  const shown = (p, base) => {
    const abs = normal(p, base);
    const root = normal(cwd);
    return abs.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? abs.slice(root.length + 1) : abs;
  };

  /** PURE: whether `program` given `words` can print what is in the paths it is given. */
  const readsContent = (program, words) => {
    if (NON_READING.has(program)) return false;
    if (READS_WHEN[program]) return READS_WHEN[program](words);
    if (program === 'sed') return !words.includes('-i');
    if (program !== 'git') return true;
    const sub = String(words[1] || '').toLowerCase();
    if (GIT_NON_READING.has(sub)) return false;
    if (sub === 'log') return GIT_PATCH(words); // commit messages and names; a patch is the files' lines
    if (sub === 'diff' || sub === 'show') return GIT_PATCH(words) || !GIT_NAMES_ONLY(words);
    return true;
  };

  /** Which operands of this simple command are a pattern, a script, a message or an option's value — not paths. */
  const notPaths = (program, words) => {
    const skip = new Set();
    for (let i = 1; i < words.length; i++) {
      const flag = words[i].split('=')[0].toLowerCase();
      if (MESSAGE_FLAG.test(flag) || LEAVES_OUT.test(flag)) { if (!words[i].includes('=')) skip.add(i + 1); skip.add(i); }
      if (words[i].startsWith('!')) skip.add(i); // `rg -g '!docs/eval'` leaves it out
    }
    const git = program === 'git' && String(words[1] || '').toLowerCase() === 'grep';
    const kind = git ? 'grep' : (PATTERN_ALIAS[program] || program);
    const valued = PATTERN_FIRST[kind];
    if (!valued) return skip;
    let given = false;
    let first = -1;
    for (let i = git ? 2 : 1; i < words.length; i++) {
      const w = words[i];
      if (w === '--') { if (first === -1 && i + 1 < words.length) first = i + 1; break; }
      if (w === '-e' || w === '--regexp' || w === '--expression') { given = true; skip.add(i + 1); i++; continue; }
      if (/^-e./.test(w) || /^--(?:regexp|expression)=/.test(w)) { given = true; continue; }
      if (w === '-f' || w === '--file') { given = true; i++; continue; } // the file after -f IS read, so it stays
      if (valued.includes(w)) { skip.add(i + 1); i++; continue; }
      if (w.startsWith('-')) continue;
      if (first === -1) first = i;
    }
    if (!given && first !== -1) skip.add(first);
    return skip;
  };

  /** A word as the paths it can stand for: its loop variables filled in, a code string's paths, a glob's matches —
   *  expanded only for a reading position (`expand`); elsewhere a glob stands for the folder it starts in. */
  const pathsIn = (word, state, expand = true) => {
    let words = [word];
    for (const m of word.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
      const values = state.vars.get(m[1]);
      if (values) words = words.flatMap((w) => values.map((v) => w.split(m[0]).join(v))).slice(0, 64);
    }
    const out = [];
    for (const w of words) {
      // A path is a word of its own — `"docs/eval/my notes.md"` is one — or a string inside one:
      // `node -e "fs.readFileSync('eval/findings.md')"`.
      const whole = /\s/.test(w) && !/['"()`;|&<>]/.test(w) && present(w, state.base);
      const candidates = !whole && /\s|['"(]/.test(w) ? (w.match(/(?:[a-z]:)?[\w.@~-]*[\\/][\w.@~/\\*?-]+/gi) || []) : [w];
      for (const c of candidates) {
        if (!(/[\\/]/.test(c) || c === '.' || /\.[a-z0-9*?]{1,8}$/i.test(c))) continue;
        const matched = expand && /[*?[{]/.test(c) ? globMatches(c, state.base) : [];
        out.push(...(matched.length > 0 ? matched : [c]));
      }
    }
    return out;
  };

  /**
   * One command, simple command by simple command, in order — so `cd` moves the folder and `for f in …` binds what a
   * later `$f` stands for. Every sealed path named goes into `named`; the first one a reading position gets is returned.
   * Only a path that EXISTS counts: a test that builds a fixture named `docs/x/CONTEXT.sealed.md` inside a `node -e`
   * string read nothing, and ended what was kept of the session that tested this very rule.
   */
  function scan(command, state, named) {
    const sealedPath = (c) => {
      if (!isSealed(c, state.base) || !present(c, state.base)) return null;
      const p = normal(c, state.base);
      if (!named.includes(p)) named.push(p);
      return p;
    };
    for (const { words: raw, quoted, subs } of parseCommands(command)) {
      // What a `$( )`, `<( )` or backquote runs is a command of its own, in a subshell that sees this one's variables.
      for (const sub of subs) {
        const read = scan(sub, { base: state.base, moved: state.moved, vars: new Map(state.vars) }, named);
        if (read) return read;
      }
      const words = raw.map((w) => w.replace(SUB, '')).map((w, i, all) => {
        let x = i === 0 ? w.replace(/^[({]+/, '') : w; // `(cd x && cat y)` is cd, then cat
        if (i === all.length - 1 && !x.includes('(')) x = x.replace(/\)+$/, '');
        return x;
      });
      // A glob expands only where the shell would expand it: unquoted. `node -e "…docs/*/findings.md…"` names a
      // pattern in a string, and expanding it on disk read a real eval file into a session that had never opened it.
      const bare = quoted.map((q) => !q);
      const drop = () => { bare.shift(); return words.shift(); };
      for (;;) {
        if (words.length > 0 && (KEYWORDS.has(words[0]) || words[0] === '')) { drop(); continue; }
        if (words.length > 0 && WRAPPERS.has(words[0])) { drop(); continue; }
        if (words.length > 0 && ASSIGN.test(words[0])) {
          // DIR=docs/eval, alone or before a program: a later `$DIR` is that path (an assignment globs nothing).
          const [name, ...value] = drop().split('=');
          state.vars.set(name, pathsIn(value.join('='), state, false).concat(value.join('=')).slice(0, 64));
          continue;
        }
        break;
      }
      // An input redirect feeds the file to whatever runs, `echo` or `while read` alike: `done < docs/eval/key.md`.
      for (let i = 0; i < words.length; i++) {
        const attached = /^\d?<(?![<(&>])/.test(words[i]);
        const source = words[i] === '<' ? words[i + 1] : (attached ? words[i].replace(/^\d?</, '') : null);
        if (!source) continue;
        for (const c of pathsIn(source, state, bare[attached ? i : i + 1])) { const p = sealedPath(c); if (p) return p; }
      }
      if (words.length === 0) continue;
      const program = words[0].replace(/^.*[\\/]/, '').toLowerCase();
      if (program === 'cd') { if (words[1]) { state.base = normal(words[1], state.base); state.moved = true; } continue; }
      if (program === 'for' || program === 'select') {
        // `for f in a b c` reads nothing: it names what the body gets as $f, and the body says what is done with it.
        if (words[2] === 'in' && /^[A-Za-z_]\w*$/.test(words[1] || '')) {
          const values = words.slice(3).flatMap((w, j) => pathsIn(w, state, bare[3 + j]).concat(/[\\/.]/.test(w) ? [] : [w]));
          values.forEach((v) => sealedPath(v));
          state.vars.set(words[1], values.slice(0, 64));
        }
        continue;
      }
      // `bash -c "cat docs/eval/key.md"` runs what it is handed.
      const shellFlag = SHELLS[program.replace(/\.exe$/, '')];
      const handed = shellFlag ? words.findIndex((w, i) => i > 0 && w.toLowerCase() === shellFlag) : -1;
      if (handed !== -1 && words[handed + 1]) {
        const read = scan(words.slice(handed + 1).join(' '), { base: state.base, moved: state.moved, vars: new Map(state.vars) }, named);
        if (read) return read;
        continue;
      }
      const reading = readsContent(program, words);
      const skip = notPaths(program, words);
      for (let i = 1; i < words.length; i++) {
        if (skip.has(i)) continue;
        // What a redirect or `tee` names is written, not read: `cat > notes.sealed.md <<'EOF'`.
        if (['>', '>>', '2>', '&>', 'tee', '<'].includes(words[i - 1]) || /^\d?&?[<>]/.test(words[i])) continue;
        const w = words[i].startsWith('-') ? (words[i].includes('=') ? words[i].slice(words[i].indexOf('=') + 1) : '') : words[i];
        if (w === '') continue;
        for (const c of pathsIn(w, state, reading && bare[i])) {
          const p = sealedPath(c);
          if (p && reading) return p;
        }
      }
      // A sealed working folder is read by a reading command that names no path at all: `grep -r answer`, `cat *`.
      if (reading && state.moved && isSealed('.', state.base)) return normal('.', state.base);
    }
    return null;
  }

  /** `{ read, named }`: the sealed path the command reads (shown relative to the folder), or null; and every sealed
   *  path it names without reading, which its output is then checked against (showsContentOf). */
  function commandTouch(command) {
    const named = [];
    const read = scan(command, { base: cwd, moved: false, vars: new Map() }, named);
    return { read: read ? shown(read) : null, named: read ? [] : named };
  }

  function commandReads(command) {
    return commandTouch(command).read;
  }

  // The lines of each named sealed path, read once: a file's own, or every file's under a named folder (bounded).
  const linesOf = new Map();
  const sealedLines = (p) => {
    if (linesOf.has(p)) return linesOf.get(p);
    const files = [];
    const walk = (d, depth) => {
      for (const n of children(d)) {
        if (files.length >= MAX_FILES_READ) return;
        const f = `${d}/${n}`;
        if (n === MARKER) continue;
        let text = null;
        try { text = readFile(f); } catch { text = null; }
        if (typeof text === 'string') files.push(text);
        else if (depth < 6 && children(f).length > 0) walk(f, depth + 1);
      }
    };
    let own = null;
    try { own = readFile(p); } catch { own = null; }
    if (typeof own === 'string') files.push(own);
    else walk(p, 0);
    const sets = files.map((t) => new Set(t.split('\n').map(comparable).filter(distinctive))).filter((s) => s.size > 0);
    linesOf.set(p, sets);
    return sets;
  };

  function showsContentOf(named, output) {
    const printed = new Set(String(output || '').split('\n').map(comparable).filter(distinctive));
    if (printed.size === 0) return null;
    for (const p of named || []) {
      for (const lines of sealedLines(p)) {
        let shared = 0;
        const need = Math.min(MIN_SHARED_LINES, lines.size);
        for (const l of printed) if (lines.has(l) && ++shared >= need) return shown(p);
      }
    }
    return null;
  }

  /**
   * A line of output that names a sealed path. `grep -n` prints `path:12:text`, `-C` prints `path-12-text`. The dash
   * form is content only where the part before the dash IS a file: `docs/eval/SESSION-CONTEXT-2026-09-17.sealed.md`,
   * a file NAME in a listing, read as the line `-2026-` of a file called `SESSION-CONTEXT` and ended a session.
   */
  function sealedLine(line) {
    const s = String(line);
    const m = /^\s*((?:[a-z]:)?[^\s:]*[\\/][^\s:]*):(?:\d+:)?(.*)$/i.exec(s);
    if (m && isSealed(m[1])) return { path: m[1], grepContent: m[2].trim() !== '' };
    for (const d of s.matchAll(/(?=-(\d+)-)/g)) {
      const p = s.slice(0, d.index).trim();
      if (/[\\/]/.test(p) && !/\s/.test(p) && isSealed(p) && present(p)) return { path: p, grepContent: s.slice(d.index + d[1].length + 2).trim() !== '' };
    }
    for (const token of String(line).match(/(?:[a-z]:)?[\w./\\@~-]*[\\/][\w./\\@~-]*/gi) || []) if (isSealed(token)) return { path: token, grepContent: false };
    return null;
  }

  /** The sealed file a person's message attaches with `@path` — Claude Code puts that file's contents in front of the
   *  agent, so the message has read it. A real session was sent `@docs/seturos-eval/findings.md` with the answers. */
  function mentionReads(text) {
    for (const m of String(text || '').matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s,;)]+))/g)) {
      const p = (m[1] || m[2] || '').replace(/[.:]$/, '');
      if (/[\\/.]/.test(p) && isSealed(p) && present(p)) return shown(p);
    }
    return null;
  }

  return { isSealed, shown, commandReads, commandTouch, showsContentOf, sealedLine, mentionReads };
}

module.exports = { MARKER, STUB, isSealedStub, stubText, sealedCheck, simpleCommands, parseCommands };
