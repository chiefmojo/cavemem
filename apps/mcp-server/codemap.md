# apps/mcp-server/

## Responsibility

The stdio MCP server (`@cavemem/mcp-server`, bin `cavemem-mcp`) is the model-facing read surface of cavemem. It exposes the memory store to coding agents as MCP tools — `search`, `timeline`, `get_observations`, `list_sessions`, plus the opt-in `enrich` web-search tool — and enforces the progressive-disclosure contract: compact tool results by default, full observation bodies only on explicit request.

## Design

- **Tool registration in `src/server.ts`**: `buildServer(store, settings, deps)` builds a `McpServer` from `@modelcontextprotocol/sdk` and registers each tool with `server.tool(name, description, zodSchema, handler)`. All results are returned as a single `text` content block containing JSON — the MCP layer stays thin; shapes come from `MemoryStore`.
- **Lazy embedder**: `resolveEmbedder()` is a tri-state closure (`undefined` = not yet attempted, `null` = unavailable, `Embedder` = ready). `createEmbedder(settings)` is only invoked on the first `search` call, so the MCP handshake is fast and a broken embedding provider degrades to BM25-only instead of failing startup.
- **Dependency injection**: `ServerDeps.fetchImpl` overrides `fetch` (used exclusively by the `enrich` tool handler); `ServerDeps.embedder` injects a pre-loaded `Embedder | null` so a caller can reuse its own model — the worker passes its embedder to avoid loading a second instance on the `/mcp` route. Other tools are pure `MemoryStore` calls.
- **Entrypoint guard**: `isMainEntry()` compares `import.meta.url` against `pathToFileURL(realpathSync(argv[1]))` so the bundled bin (`dist/server.js`) only auto-runs `main()` when executed directly, not when imported by tests or the e2e harness. Fatal errors go to stderr with the `[cavemem mcp]` prefix and exit 1 (stdout stays reserved for the protocol).

## Flow

1. `main()` → `loadSettings()` → `resolveDataDir(settings.dataDir)/data.db` → `new MemoryStore({ dbPath, settings })` → `buildServer` → `StdioServerTransport` + `server.connect`.
2. `search(query, limit)` → lazy `resolveEmbedder()` → `store.search(query, limit, embedder?)` (BM25 + optional semantic re-rank) → compact hits as JSON. `limit` is zod-capped at 50.
3. `timeline(session_id, around_id?, limit?)` → `store.timeline(...)` mapped to compact `{ id, kind, ts }` rows only.
4. `get_observations(ids[], expand?)` → `store.getObservations(ids, { expand })`, expanded text by default, capped at 50 ids — the only tool that returns full bodies.
5. `list_sessions(limit?)` → `store.storage.listSessions(...)` for navigation before `timeline`.
6. `enrich(query, note?)` — registered only when `settings.enrich.enabled`: calls `enrichQuery()` (`src/enrich.ts`), then stores each result as a `kind: 'enrichment'` observation via `store.addObservation`, under a lazily created synthetic session (`ide: 'enrich'`, via `createSessionId` + `store.startSession`). Query/note are scrubbed with `redactPrivate`/`redactSecrets` before landing in the metadata column (MemoryStore only redacts content, not metadata).

## Integration

- Depends on `@cavemem/config` (`loadSettings`, `resolveDataDir`, `Settings`), `@cavemem/core` (`MemoryStore`, `Embedder`, `createSessionId`), `@cavemem/embedding` (`createEmbedder`), `@cavemem/compress` (`redactPrivate`, `redactSecrets`). All DB I/O stays behind `MemoryStore`.
- Registered as an MCP server by the IDE installers (`packages/installers`) so editor agents can call it over stdio; no network listener is opened. In remote mode, installers instead point agents at the worker's stateless streamable HTTP `/mcp` route, which reuses `buildServer` (see `apps/worker/codemap.md`).
- Tool contracts are documented in `docs/mcp.md`; changes here require an inspector integration test and re-running `bash scripts/e2e-publish.sh` (which drives this server end to end). Performance budget: `search` p95 ≤ 50 ms at 50k observations.
- Tests: `test/server.test.ts` (tool shapes), `test/enrich-tool.test.ts`, `test/enrich.test.ts` + `test/fixtures/ddg-search.html` (parser against a saved DDG page), `test/exports.test.ts`.
