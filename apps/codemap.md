# apps/

## Responsibility
The deployable entry points of cavemem: the user-facing CLI binary, the stdio MCP server agents talk to, and the HTTP daemon that hosts the read-only viewer and embedding backfill loop — in remote mode the same worker process doubles as the central shared-memory server (bearer-authenticated hooks + stateless `/mcp`).

## Design
- All three apps consume `packages/*` and never each other.
- `apps/cli` bundles every `@cavemem/*` package into a single tsup dist (monolith) so IDEs and hook shell stubs invoke one binary.
- `apps/mcp-server` is a stdio process with progressive disclosure whose `buildServer` the worker reuses for its HTTP `/mcp` route; `apps/worker` binds to configurable `workerHost` (loopback by default, `0.0.0.0` for a LAN server) with a Host/Origin allowlist and bearer auth on every route except `/healthz`.

## Flow
Editor hook → `cavemem hook run` (cli) → handler (hooks) → storage (core/storage); in remote mode the same hook POSTs to the worker's `/api/hooks/:event` instead of writing locally. Agent memory reads → MCP `search`/`get_observations` (mcp-server over stdio, or the worker's stateless `/mcp`). Background embedding → worker `embed-loop` (expand → embed → persist), viewable via the worker's read-only viewer.

## Integration
- `apps/cli` → all `packages/*`, plus its own publish scripts (`scripts/prepack.mjs`, `scripts/pack-release.mjs`).
- `apps/mcp-server` → `@cavemem/core`, `@cavemem/storage`, `@cavemem/embedding`, `@cavemem/config`, `@cavemem/compress`.
- `apps/worker` → `@cavemem/core`, `@cavemem/storage`, `@cavemem/embedding`, `@cavemem/config`.

## Directory Map
| App | Responsibility Summary | Detailed Map |
|-----|------------------------|--------------|
| `cli/` | The published `cavemem` npm binary — commander CLI (install/uninstall, config, doctor/status, search, compress/expand, export/import, reindex, daemon lifecycle, `hook run`, `mcp`) + OpenCode plugin bridge + prepack/pack-release publish tooling. | [View Map](cli/codemap.md) |
| `mcp-server/` | stdio MCP server exposing memory with progressive disclosure (compact `search`/`timeline`, full bodies via `get_observations`) + opt-in SSRF-hardened web enrichment; `buildServer` is reused by the worker for stateless HTTP `/mcp`. | [View Map](mcp-server/codemap.md) |
| `worker/` | Configurable HTTP daemon (loopback by default, `workerHost`/`workerAllowedHosts` for LAN) — read-only viewer with nonce→cookie auth, embedding backfill loop, bearer-protected `POST /api/hooks/:event`, and stateless streamable-HTTP MCP at `/mcp`. | [View Map](worker/codemap.md) |
