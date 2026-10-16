'use strict';

// SETUROS × CLAUDE CODE — what the hooks say in the middle of a session: passages for the message just sent, and a
// settled rule when a command or an edit touches what it names. PURE — the entry file does the reading and fetching.

/** PURE: has this session been compacted — is any of it now only in Seturos rather than in the context? */
function wasCompacted(transcriptText) {
  return String(transcriptText || '').includes('"isCompactSummary":true');
}

/** PURE: the message as a lookup, or '' for one that cannot be about earlier work — a slash command, "continue". */
function promptQuery(prompt) {
  const text = String(prompt || '').replace(/<([a-z][a-z_-]*)>[\s\S]*?<\/\1>/gi, '').trim();
  if (text.startsWith('/') || text.split(/\s+/).filter((w) => w.length > 2).length < 3) return '';
  return text.slice(0, 500);
}

/** PURE: what UserPromptSubmit adds for the model. Framed as evidence, because it was matched, not decided. */
function recallText(evidence) {
  const body = String(evidence || '').trim();
  if (body === '') return '';
  return `Seturos matched the message above to earlier parts of this work that are no longer in the conversation:\n\n${body}`;
}

/** PURE: the rules reminder → its rule lines. "Not yet decided" lines are not rules to hold a command to. */
function rulesFrom(rulesText) {
  const out = [];
  let open = false; // bullets under "Still open" are questions, not rules
  for (const line of String(rulesText || '').split('\n')) {
    if (/^[^\s-]/.test(line)) open = /^Still open/.test(line); // a heading, not a bullet
    if (open) continue;
    const bullet = /^\s*-\s+(.+)$/.exec(line);
    const rule = bullet ? bullet[1].trim() : '';
    if (rule !== '' && !/^Not yet decided/.test(rule) && !out.includes(rule)) out.push(rule);
  }
  return out;
}

// Filenames every repository has several of. A rule naming `route.ts` does not name the route being edited.
const COMMON_FILES = new Set(['route.ts', 'page.tsx', 'index.ts', 'index.js', 'layout.tsx', 'package.json', 'readme.md', 'config.ts']);

/**
 * PURE: the identifiers a rule names — what a command or a path can concretely match. Backticked spans, and bare
 * tokens shaped like identifiers (a path, a flag, a host, a name with a digit). Plain words never: "deploy" is in a
 * hundred commands that have nothing to do with a rule about deploying on Fridays, and a reminder that fires on
 * weak matches teaches the agent to ignore it.
 */
function identifiersOf(rule) {
  const found = new Set();
  const text = String(rule || '');
  for (const m of text.matchAll(/`([^`\n]{3,120})`/g)) found.add(m[1].trim().toLowerCase());
  for (const m of text.replace(/`[^`\n]*`/g, ' ').matchAll(/(?:^|[\s("'])((?:--?)?[A-Za-z0-9][A-Za-z0-9_./:@-]*[A-Za-z0-9])/g)) {
    const token = m[1];
    const shaped = /^--?[a-z]/i.test(token) || /[_/:@]/.test(token) || /\d/.test(token) || (token.includes('.') && token.length >= 8);
    if (shaped && token.length >= 5 && /[a-z]/i.test(token)) found.add(token.toLowerCase());
  }
  return [...found].filter((id) => id.length >= 4 && !COMMON_FILES.has(id.split('/').pop()) && !/^\d+(?:[./]\d+)*$/.test(id));
}

/** PURE: what a tool call acts on, as text to match — the command, or the file it writes. */
function actedOn(toolName, toolInput) {
  const input = toolInput || {};
  const raw = toolName === 'Bash' ? input.command : input.file_path || input.notebook_path || input.path;
  return String(raw || '').replace(/\\/g, '/').toLowerCase();
}

/** PURE: the settled rules this tool call touches, each at most once per session (`reminded` holds rule texts). */
function ruleHits(rules, toolName, toolInput, reminded = []) {
  const target = actedOn(toolName, toolInput);
  if (target === '') return [];
  const already = new Set(reminded);
  const hits = [];
  for (const rule of rules || []) {
    if (already.has(rule)) continue;
    const id = identifiersOf(rule).find((candidate) => target.includes(candidate));
    if (id) hits.push({ rule, id });
  }
  return hits.slice(0, 3);
}

/** PURE: the PreToolUse context. A reminder, not a refusal: the agent decides whether the rule applies here. */
function preToolText(hits, toolName) {
  if (hits.length === 0) return '';
  const what = toolName === 'Bash' ? 'This command' : 'This edit';
  const lines = hits.map((h) => `- \`${h.id}\` — "${h.rule}"`);
  return `Seturos: ${what} touches something a settled rule for this work names. Check it still holds before going on:\n${lines.join('\n')}`;
}

module.exports = { wasCompacted, promptQuery, recallText, rulesFrom, identifiersOf, ruleHits, preToolText };
