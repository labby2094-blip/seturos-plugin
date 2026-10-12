# Seturos for Claude Code and Cursor

Shared work memory across coding tools. Start something in Codex, finish it in Claude Code or Cursor, and
the second tool knows what the first one decided, did, and left open — scoped to the repository you are
in, so one project's work never shows up in another's.

## What it adds

| | |
|---|---|
| `resume` command | What this repository's work stands at, from every tool you use |
| `carry` command | Hand this conversation to the next tool — decisions, work done, open threads |
| `find` command | Find a person, project, team or document in your org |
| `seturos` MCP server | 15 tools: org search, project context, carried work, execution state, decisions, impact |
| `seturos` skill | Teaches the agent the `##entity` grammar and the per-repository rule |

In Claude Code the commands are `/seturos:resume`, `/seturos:carry` and `/seturos:find`.

## Install in Claude Code

```
/plugin marketplace add labby2094-blip/seturos-plugin
/plugin install seturos@seturos-plugins
```

Claude Code will prompt you to sign in to Seturos the first time the MCP server is used; approval happens
in your browser and nothing is pasted into a settings file.

## Install in Cursor

Install Seturos from the Cursor Marketplace, or add the server yourself under **Customize → MCPs → New**:

```json
{
  "mcpServers": {
    "seturos": {
      "url": "https://app.seturos.com/api/mcp"
    }
  }
}
```

Then select **Connect** next to Seturos, sign in to Seturos in your browser and approve. If the browser
says localhost refused to connect, select **Connect** in Cursor again: you are signed in by then, so it
takes one click.

## What it sends

The MCP tools send what you ask them to send: a handoff you write with the `carry` command, a question you
ask, a decision you log. Results are limited to what your Seturos account can see — the server never
returns more than your own visibility allows.

A Seturos account is required; signing up is free at <https://app.seturos.com/sign-up>. Documentation:
<https://app.seturos.com/docs>. Support: support@seturos.com.

## Layout

`.claude-plugin/` holds the Claude Code manifest and `.mcp.json` its server; `.cursor-plugin/` holds the
Cursor manifest and `mcp.json` its server. Both point at the same endpoint and share `skills/` and
`commands/`.

## License

MIT
