# Seturos for Claude Code

Shared work memory across coding tools. Start something in Codex, finish it in Claude Code, and the
second tool knows what the first one decided, did, and left open — scoped to the repository you are in,
so one project's work never shows up in another's.

## What it adds

| | |
|---|---|
| `/seturos:resume` | What this repository's work stands at, from every tool you use |
| `/seturos:carry` | Hand this conversation to the next tool — decisions, work done, open threads |
| `/seturos:find` | Find a person, project, team or document in your org |
| `seturos` MCP server | 13 tools: org search, project context, execution state, decisions, impact |
| `seturos` skill | Teaches Claude the `##entity` grammar and the per-repository rule |

## Install

```
/plugin marketplace add labby2094-blip/seturos-plugin
/plugin install seturos@seturos-plugins
```

Claude Code will prompt you to sign in to Seturos the first time the MCP server is used; approval happens
in your browser and nothing is pasted into a settings file.

## What it sends

The MCP tools send what you ask them to send: a handoff you write with `/seturos:carry`, a question you
ask, a decision you log. Results are limited to what your Seturos account can see — the server never
returns more than your own visibility allows.

A Seturos account is required. See <https://app.seturos.com>.

## License

MIT
