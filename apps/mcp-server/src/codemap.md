# apps/mcp-server/src/

## Responsibility

The two modules that make up the MCP server binary: `server.ts` owns transport, tool registration, and process lifecycle; `enrich.ts` is a self-contained web-search enrichment module (DuckDuckGo HTML scraping → plain-text extracts) with hard-coded safety bounds.

## Design

### server.ts

- `buildServer(store, settings, deps?: ServerDeps)` — the single composition point. Every tool is a thin adapter: zod input schema → `MemoryStore` call → `JSON.stringify` into one text content block.
- Progressive disclosure is structural, not advisory: `search`/`timeline` handlers project rows down to compact shapes (`{id, kind, ts}` for timeline; store-defined compact hits for search), while `get_observations(ids[])` is the only path to full content, with `expand` defaulting to `true` (human/agent-readable expanded caveman text).
- `resolveEmbedder()` memoizes failure as `null` (logged to stderr) so repeated `search` calls never re-attempt a broken provider load.
- `enrich` tool is conditionally registered (`settings.enrich.enabled`), creates one synthetic `enrich` session per process on first use, and scrubs `query`/`note` via `scrubMeta()` (`redactPrivate`, conditionally `redactSecrets`) because `MemoryStore` persists metadata verbatim.

### enrich.ts

- Pure module — no MCP or storage imports — so the fetch/parser logic is unit-testable with injected `fetchImpl` and saved HTML fixtures.
- `enrichQuery(query, cfg, deps)` orchestrates: DDG HTML search → `parseDdgResults` → fetch each top page → `htmlToText` extract (falls back to the search snippet when a page strips to nothing).
- SSRF hardening in `fetchPublic`: redirects are followed manually (max `MAX_REDIRECT_HOPS = 3`) and every hop must pass `isPublicHttpUrl` — http(s) only, hostname checked after WHATWG canonicalization so obfuscated hosts (`http://2130706433/`) are caught; rejects loopback, RFC1918, link-local (169.254.x), unique-local (fc00::/7), and IPv4-mapped IPv6 targets.
- DoS hardening: all HTML scanning (`splitResultBlocks`, `findClassElement`, `tagEnd`) is index-based and single-pass; regexes run only on pre-bounded slices (`MAX_TAG_LEN = 2000`) or use bounded quantifiers, so adversarial pages cannot stall the single-threaded server. `readBodyCapped` reads the real stream (not `content-length`) up to 500 KB then cancels. `clampMaxResults` enforces a hard cap of 5 that callers cannot exceed.

## Flow

- Startup: `main()` (guarded by `isMainEntry()`) → settings → `MemoryStore` → `buildServer` → stdio connect. Nothing loads the embedding model until the first `search`.
- `enrich` call: `enrichQuery` → DDG search page → result blocks (skipping ads via the `result`+`results_links` class-token check in `splitResultBlocks`) → per-page fetch/extract, individual page failures are logged and skipped, not fatal → back in `server.ts`, each result is persisted as an `enrichment` observation (`title\nurl\n\nextract`; the bare URL survives compression byte-for-byte) → response includes `stored_ids` for immediate `get_observations` follow-up.

## Integration

- `server.ts` imports only from `@cavemem/*` packages (`config`, `core`, `embedding`, `compress`) plus the MCP SDK and `zod`; `enrich.ts` imports nothing project-internal (uses `settings`-derived numbers passed in via `EnrichConfig`).
- Upstream callers: the installed `cavemem-mcp` bin (spawned by IDE integrations) and tests, which call `buildServer` directly with in-memory stores and `fetchImpl` stubs.
- The bundle entry is `src/server.ts` (see `package.json#scripts.build`, tsup ESM + dts), which is why `enrich.ts` needs no separate entrypoint guard.
