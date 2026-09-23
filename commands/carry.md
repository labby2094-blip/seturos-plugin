---
name: carry
description: Hand this conversation to the next tool — what was decided, what is still open
---

Call `carry_work` on the Seturos MCP server, passing `repo` set to this repository's remote (from
`git remote get-url origin`).

Write the handoff as a brief the next agent can act on, not a transcript:

- What this conversation settled, in plain sentences.
- What was actually done — commits, files, checks that ran and their results.
- What is still open, including anything you were asked to do and did not finish.
- Any constraint the person stated that should still hold.

Be accurate about failures. A carry that claims something passed when it did not is worse than no carry
at all, because the next tool will build on it.

Do this when a piece of work is finished, and before the person switches tools.
