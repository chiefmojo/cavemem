---
"cavemem": minor
"@cavemem/config": minor
"@cavemem/core": minor
"@cavemem/hooks": minor
"@cavemem/installers": minor
"@cavemem/worker": minor
"@cavemem/mcp-server": minor
---

Remote mode: one central worker owns the store. `settings.remote.url` switches a machine to POST hooks to `/api/hooks/:event` and use MCP over streamable HTTP at `/mcp`. Worker gains `workerHost` and `workerAllowedHosts`. Installers write URL-based MCP entries in remote mode.
