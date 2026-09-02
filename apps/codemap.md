# apps/

## Responsibility
The deployable entry points of cavemem: the user-facing CLI binary, the stdio MCP server agents talk to, and the local HTTP daemon that hosts the read-only viewer and runs the embedding backfill loop.

## Design
- All three apps consume `packages/*` and never each other.
- `apps/cli` bundles every `@cavemem/*` package into a single tsup dist (monolith) so IDEs and hook shell stubs invoke one binary.
- `apps/mcp-server` is a stdio process with progressive disclosure; `apps/worker` binds to 127.0.0.1 only with a three-layer security model.

## Flow
Editor hook → `cavemem hook run` (cli) → handler (hooks) → storage (core/storage). Agent memory reads → MCP `search`/`get_observations` (mcp-server). Background embedding → worker `embed-loop` (expand → embed → persist), viewable via the worker's read-only viewer.

## Integration
- `apps/cli` → all `packages/*`, plus its own publish scripts (`scripts/prepack.mjs`, `scripts/pack-release.mjs`).
- `apps/mcp-server` → `@cavemem/core`, `@cavemem/storage`, `@cavemem/embedding`, `@cavemem/config`, `@cavemem/compress`.
- `apps/worker` → `@cavemem/core`, `@cavemem/storage`, `@cavemem/embedding`, `@cavemem/config`.

## Directory Map
| App | Responsibility Summary | Detailed Map |
|-----|------------------------|--------------|
| `cli/` | The published `cavemem` npm binary — commander CLI (install/uninstall, config, doctor/status, search, compress/expand, export/import, reindex, daemon lifecycle, `hook run`, `mcp`) + OpenCode plugin bridge + prepack/pack-release publish tooling. | [View Map](cli/codemap.md) |
| `mcp-server/` | stdio MCP server exposing memory with progressive disclosure (compact `search`/`timeline`, full bodies via `get_observations`) + opt-in SSRF-hardened web enrichment. | [View Map](mcp-server/codemap.md) |
| `worker/` | 127.0.0.1-only HTTP daemon combining a read-only session viewer with a self-limiting embedding backfill loop (expand → embed → persist). | [View Map](worker/codemap.md) |
