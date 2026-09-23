---
name: find
description: Search the org for a person, project, team, tool or document
---

Call `query_org_brain` on the Seturos MCP server with what the person typed after the command.

It returns entities the person can see — never more. Take the id of the one they meant and call
`get_entity_context` with it before answering, because the name alone is ambiguous: two projects can
share a word, and the wrong one is a confident wrong answer.

If nothing matches, say so plainly. Inventing a plausible answer about a project that does not exist is
the one failure this command cannot recover from.
