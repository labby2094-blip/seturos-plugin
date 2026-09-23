---
name: seturos
description: How to read and write Seturos from a coding session — the ## entity reference, the repository rule, and when to carry work forward. Load when the person writes ## or #/, asks what was decided or done earlier, or switches tools mid-task.
---

Seturos holds an organisation's people, teams, projects, agents and tools, and what has recently been
done about each. This session reaches it through the `seturos` MCP server.

## `##Name` names an entity

`##Atlas Renewal` points at a specific thing in Seturos, not a heading. Resolve it before answering:
`query_org_brain` with the name, then `get_entity_context` with the id it returns. Do not guess from the
name — the whole point of the symbol is that the person already told you which one they meant.

`⦿ Name ⟨e/alias⟩` is the same reference already resolved. Pass the `e/…` key straight to
`get_entity_context`; prefer it over the name, because it cannot be ambiguous.

## One repository's work never leaks into another

Reads are scoped to the repository you are working in. Always pass `repo` — the git remote
(`git remote get-url origin`) — to `resume_work` and `carry_work`. Without it, work from elsewhere can be
handed to you as if it belonged here, which is worse than having no memory at all.

Outside any repository, `resume_work` returns an index of where recent work is rather than its content.

## Ask rather than re-derive

When you are unsure what was decided earlier — a commit, a score, a file, why something was left alone —
call `resume_work` with a `question`, phrased in the words the answer would use. That is cheaper and more
accurate than reconstructing it from the code.

## Carry when the conversation should travel

`carry_work` records what a conversation settled so the next tool continues from there. Write a brief,
not a transcript, and be honest about what failed or is unfinished. `log_decision` and
`update_execution_state` record where a project stands; they are a different thing from a handoff, and
only the handoff is read back by `resume_work`.

## When a name does not resolve

Say so. "I could not find ##X" is correct and useful; a confident answer about a project that does not
exist is neither.
