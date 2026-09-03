---
"cavemem": minor
"@cavemem/config": minor
"@cavemem/core": minor
"@cavemem/hooks": minor
"@cavemem/installers": minor
"@cavemem/worker": minor
"@cavemem/mcp-server": minor
---

Remote mode: one central worker owns the store. `settings.remote.url` switches a machine to POST hooks to `/api/hooks/:event` and use MCP over streamable HTTP at `/mcp`. Worker gains `workerHost` and `workerAllowedHosts`. Installers write URL-based MCP entries in remote mode. The worker requires auth on every route except `/healthz`: `/api/*` and `/mcp` stay bearer-only, and viewer HTML (`/`, `/sessions/:id`) authenticates via a one-time `?token=` handshake that trades for an `HttpOnly`/`SameSite=Strict` session cookie — a plaintext-memory viewer is never reachable unauthenticated once `workerHost` binds off loopback.
