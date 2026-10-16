---
name: connect
description: Turn on Seturos memory for Claude Code on this computer (approve it once in your browser)
---

Turn on Seturos memory for Claude Code on this computer.

First tell the person, in a sentence or two, what this does: a page opens in their browser asking them to
approve this computer, and once they approve, Claude Code sessions on this computer are saved to their
Seturos account, so what a session settles survives compaction and the next session (in any tool) starts
from it. API keys and tokens are scrubbed before anything is saved, files named `*.sealed.*` are never
kept, and `/seturos:disconnect` turns it off.

Then run this with the Bash tool, with a timeout of 600000 ms, since it waits up to ten minutes for the
approval:

```
node "${CLAUDE_PLUGIN_ROOT}/claude-code/hooks/seturos-compact-hook.cjs" sign-in
```

Report what it printed. "signed in: …" means memory is on from the next message. Anything else, say what
it said; running `/seturos:connect` again opens a fresh page.
