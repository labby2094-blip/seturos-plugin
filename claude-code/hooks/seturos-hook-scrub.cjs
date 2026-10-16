'use strict';

// seturos-hook-scrub.cjs — nothing that looks like a credential leaves this machine in a filed session. PURE.
//
// A Claude Code session is full of things pasted to debug something: a connection string, a key in an env line, a
// bearer header copied out of a curl. Filing the session sent all of it to Seturos, which kept it and handed it to
// the next tool on /resume. The Hub scrubs too (lib/security/secret-scrub.ts) — this is the half that means the
// secret never makes the trip at all. Same rules, same output; `smoke:secret-scrub` holds the two together.

const mark = (kind) => `[redacted ${kind}]`;

const RULES = [
  { kind: 'private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'Seturos token', re: /\b(?:stk|tfd)_[A-Za-z0-9_-]{16,}/g },
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: 'secret key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'webhook secret', re: /\bwhsec_[A-Za-z0-9+/=_-]{16,}/g },
  { kind: 'Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'Google OAuth secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'database password', re: /\bnpg_[A-Za-z0-9]{10,}/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: 'password',
    re: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]+:)([^@\s/]+)(@)/g,
    keep: (_m, head = '', _pw, at = '') => `${head}${mark('password')}${at}`,
  },
  {
    kind: 'credential',
    re: /\b(Bearer\s+)(?!\[redacted)([A-Za-z0-9._~+/-]{24,}=*)/g,
    keep: (_m, head = '') => `${head}${mark('credential')}`,
  },
  {
    kind: 'secret',
    re: /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)[A-Z0-9_]*=)(["']?)(?!\[redacted)([^\s"'#]{8,})\2/gm,
    keep: (_m, head = '', quote = '') => `${head}${quote}${mark('secret')}${quote}`,
  },
];

/** PURE: `text` with every recognised credential replaced by `[redacted <kind>]`. */
function scrubSecrets(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (match, ...rest) => {
      const groups = rest.slice(0, -2).map((g) => (typeof g === 'string' ? g : ''));
      return rule.keep ? rule.keep(match, ...groups) : mark(rule.kind);
    });
  }
  return out;
}

/** PURE: turns with their text and tool output both scrubbed. */
function scrubTurns(turns) {
  return (Array.isArray(turns) ? turns : []).map((t) => ({
    ...t,
    text: scrubSecrets(t && t.text),
    ...(t && typeof t.evidence === 'string' ? { evidence: scrubSecrets(t.evidence) } : {}),
  }));
}

module.exports = { scrubSecrets, scrubTurns, RULES };
