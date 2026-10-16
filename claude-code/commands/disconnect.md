---
name: disconnect
description: Turn off Seturos memory for Claude Code on this computer
---

Turn off Seturos memory for Claude Code on this computer. Run this with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/claude-code/hooks/seturos-compact-hook.cjs" sign-out
```

Then tell the person: sessions on this computer are no longer saved from the next message; what was saved
before stays in their Seturos account; and this computer's sign-in stays listed in Seturos until they
revoke it there. `/seturos:connect` turns it back on.
