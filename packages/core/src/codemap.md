# packages/core/src/

## Responsibility

Source of `@cavemem/core`: five modules that together implement the domain facade. `memory-store.ts` is the heart — the only sanctioned write path into the database and the search/ranking entry point; `types.ts` holds the domain models; `ranker.ts` the pure hybrid-scoring math; `ids.ts` the session-ID scheme; `index.ts` the public barrel.

## Design

- **`memory-store.ts`** — exports `MemoryStore`, `MemoryStoreOptions { dbPath, settings }`, and the `Embedder` interface (`{ readonly model: string; readonly dim: number; embed(text): Promise<Float32Array> }`; declared here rather than in `types.ts` because it is part of the facade's search contract).
  - Writes: `addObservation` returns the new row id, or **`-1` when `redactPrivate` empties the content** (nothing persisted). Both writers stamp `compressed: true` and the `settings.compression.intensity` used.
  - `ensureSession(id)` is a private idempotency guard: it re-issues `storage.createSession` before every child insert because Claude Code does not guarantee `SessionStart` fires first (installing mid-session, hook-chain failure, resumed sessions); without it, inserts fail the foreign-key constraint.
  - Reads: `toObservation(row, expand)` converts storage rows; `compressed` is reported as `!expand && row.compressed === 1`; `metadata` goes through `safeParse` (JSON parse failure → `null`, never throws).
- **`ranker.ts`** — `hybridRank(items, alpha)` min-max normalizes the BM25 and cosine populations independently into `[0, 1]` (a flat population uses range `1` via `|| 1` to avoid divide-by-zero), then blends `score = alpha * b + (1 - alpha) * c` and sorts descending; `alpha=1` → pure keyword, `alpha=0` → pure vector. `cosine(a, b)` iterates the shorter length with per-element `?? 0` guards and returns `0` on zero-norm denominators.
- **`types.ts`** — `Observation` (id, session_id, kind, content, compressed, intensity, ts, metadata), `Session`, `SearchResult` (compact shape: id, session_id, snippet, score, ts — this is the MCP progressive-disclosure payload), `GetObservationsOptions { expand? }`.
- **`ids.ts`** — `createSessionId()` = `sess_<Date.now() in base36>_<4 random bytes as hex>` via `node:crypto`; time-sortable prefix plus entropy suffix.
- **`index.ts`** — public barrel: `MemoryStore` + `Embedder`, `hybridRank` (note: `cosine` is *not* exported), the four domain types, `createSessionId`.

## Flow

1. Producers (hook handlers) call `MemoryStore.addObservation`/`addSummary` → redaction → `ensureSession` → `compress` → `storage.insertObservation/insertSummary` → numeric id.
2. MCP `timeline` tool → `MemoryStore.timeline` → compressed rows (disclosure layer 1).
3. MCP `get_observations` tool → `MemoryStore.getObservations(ids, { expand: true })` → expanded rows (disclosure layer 2); default expand value comes from `settings.compression.expandForModel`.
4. MCP/CLI search → `MemoryStore.search(query, limit?, embedder?)`: `cap = limit ?? settings.search.defaultLimit`; `searchFts(query, cap * 2)` gives keyword hits; when an embedder is supplied and `settings.embedding.provider !== 'none'`, `allEmbeddings({ model, dim })` loads persisted vectors, the query is embedded, per-id BM25/cosine scores are merged and blended by `hybridRank(..., settings.search.alpha)`; vector-only hits get snippet/session info fetched from storage. Any degrade condition (no embedder, no vectors, `qvec.length !== embedder.dim`) returns the keyword slice untouched.

## Integration

- Imports `@cavemem/compress` (write/read text pipeline), `@cavemem/config` (`Settings` type drives every branch), `@cavemem/storage` (`Storage`, `NewObservation`, `ObservationRow`). No upward or sideways imports — `core` never imports `@cavemem/embedding`; the `Embedder` here is a structural interface satisfied by that package's returned objects.
- Consumed across the tree: `packages/hooks/src/runner.ts` and handlers (write path), `apps/mcp-server/src/server.ts`, `apps/worker/src/{server,embed-loop}.ts`, `apps/cli/src/commands/search.ts` and `opencode-bridge.ts`.
- Tests live in `../test/` (`memory-store.test.ts`, `memory-store-search.test.ts`, `ranker.test.ts`); built by tsup from `src/index.ts` with `--dts` per `package.json#scripts`.
