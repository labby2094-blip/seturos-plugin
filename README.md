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
| `connect` / `disconnect` commands | Claude Code only: turn automatic memory on or off on this computer |
| Hooks | Claude Code only: automatic memory, off until you run `/seturos:connect` (below) |
| `seturos` MCP server | 15 tools: org search, project context, carried work, execution state, decisions, impact |
| `seturos` skill | Teaches the agent the `##entity` grammar and the per-repository rule |

In Claude Code the commands are `/seturos:resume`, `/seturos:carry`, `/seturos:find`, `/seturos:connect` and
`/seturos:disconnect`.

## Install in Claude Code

```
/plugin marketplace add labby2094-blip/seturos-plugin
/plugin install seturos@seturos-plugins
```

Claude Code will prompt you to sign in to Seturos the first time the MCP server is used; approval happens
in your browser and nothing is pasted into a settings file.

## Automatic memory in Claude Code (optional)

Claude Code shortens a long session when it compacts, and the rules and decisions said early are what the summary
drops. With automatic memory on, the plugin's hooks keep them:

- **Before a compaction**, the session so far is saved to your Seturos account, tagged with the repository.
- **After a compaction, or in a new session**, what was already settled is put back at the top: the rules, the
  decisions, what is still open.
- **When a message is about earlier work**, the relevant passages are looked up and added. Nothing is added when
  it is not.
- **When Claude says it committed, pushed or passed tests**, the hook checks that a tool actually printed it.

It is **off until you turn it on**. Until then the hooks save nothing, check nothing and open nothing; a session
is told, at most once a week, that `/seturos:connect` turns it on. `/seturos:connect` opens a page in your
browser that says what it records and asks you to approve this computer, once. `/seturos:disconnect` turns it off.

What it does not do: it never saves API keys or tokens (they are scrubbed before anything leaves your computer),
it never keeps a file named `*.sealed.*`, a folder named `*.sealed` or anything in a folder holding a
`.seturos-sealed` file, and work from one repository is never shown in another. Each save writes one line to
`~/.seturos/capture.log`, so you can see what was filed and why.

If a repository already has the Seturos hooks installed in its own `.claude/settings.json`, those run there and
the plugin's copy steps aside, so nothing is saved twice.

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
ask, a decision you log. In Claude Code, automatic memory (above) sends your sessions too, but only after you
turn it on with `/seturos:connect`. Results are limited to what your Seturos account can see — the server never
returns more than your own visibility allows.

A Seturos account is required; signing up is free at <https://app.seturos.com/sign-up>. Documentation:
<https://app.seturos.com/docs>. Support: support@seturos.com.

## Layout

`.claude-plugin/` holds the Claude Code manifest and `.mcp.json` its server; `.cursor-plugin/` holds the
Cursor manifest and `mcp.json` its server. Both point at the same endpoint and share `skills/` and
`commands/`. `claude-code/` holds what only Claude Code uses: the hooks (`hooks.json` and the scripts in
`claude-code/hooks/`, Node 18+, no dependencies) and the `connect` and `disconnect` commands.

## License

MIT
