# packages/storage/src/

## Responsibility

The storage implementation: `schema.ts` (idempotent DDL + FTS5 virtual table + sync triggers + version stamp), `storage.ts` (`Storage` class, driver adapter, FTS search, embedding persistence), `types.ts` (public row/value interfaces), and `index.ts` (the package's only export surface). `bun.test.ts` lives here as a Bun-runtime sanity check of the dual-backend adapter.

## Design

- `schema.ts` — `SCHEMA_SQL` is one string executed on every writable open. Pragmas: `journal_mode = WAL` (concurrent hook writes + worker reads), `foreign_keys = ON`, `synchronous = NORMAL`. Tables: `schema_version` (forward-only version stamp, currently `2` via `INSERT OR IGNORE`); `sessions` (id TEXT PK, `ide`, `cwd`, `started_at`, nullable `ended_at`, `metadata` JSON text); `observations` (AUTOINCREMENT id, `session_id` FK `ON DELETE CASCADE`, `kind`, `content`, `compressed` default 1, `intensity`, `ts`, `metadata`) with `idx_observations_session(session_id, ts)` and `idx_observations_ts`; `summaries` (same shape plus `scope` CHECK `('turn','session')`) with `idx_summaries_session`; `embeddings` (`observation_id` PK FK cascade, `model`, `dim`, `vec` BLOB) with `idx_embeddings_model(model, dim)`. The FTS5 table `observations_fts` is external-content (`content='observations'`, `content_rowid='id'`, `tokenize='porter unicode61'`) and is maintained by the three triggers `obs_ai`/`obs_ad`/`obs_au` (insert / delete-marker / delete+insert on update) so the index can never drift from `observations`.
- `storage.ts` — top: driver-neutral `RunResult`/`Stmt`/`DbHandle` interfaces; `isBun` detects the runtime; `normalizeBunGet` maps `bun:sqlite`'s null-on-no-match to `undefined`. `openDb()` returns a `DbHandle` for either backend — Bun's adapter wraps prepared statements and hand-rolls `transaction` with `BEGIN`/`COMMIT`/`ROLLBACK`, Node's casts the `better-sqlite3` handle directly (`Bs3Constructor` inline type dodges the `export=` import friction). `Storage` holds the handle and exposes grouped methods (sessions / observations / summaries / search / embeddings / counts) plus `transaction(fn)` for `cavemem import` atomicity. `sanitizeMatch(q)` splits on whitespace and double-quote-wraps each term (inner `"` doubled) before it reaches `MATCH ?`.
- `types.ts` — `SessionRow`, `ObservationRow` (note `compressed: 0 | 1` and nullable `intensity` mirror the SQL columns), `SummaryRow` (`scope: 'turn' | 'session'`), the insert shapes `NewObservation`/`NewSummary` (`metadata?: Record<string, unknown>`, optional `ts`), and the compact `SearchHit { id, session_id, snippet, score, ts }` used by MCP `search` results.

## Flow

- Open: `constructor` → `mkdirSync(dirname)` → `openDb` → `runSchema(SCHEMA_SQL)` unless `readonly` (readonly connections reject the trailing `INSERT OR IGNORE` even when ignored; readonly is only used against an already-initialised DB, e.g. `cavemem export`).
- Observe: `insertObservation` defaults `ts` to `Date.now()`, JSON-stringifies `metadata`, returns `Number(lastInsertRowid)`; the insert trigger indexes the new content into FTS immediately — BM25 is always up to date, vectors lag until the worker embeds.
- Search: `searchFts` builds one of two prepared queries (with/without a `sessions.cwd` join for project scoping), orders by `bm25(observations_fts) ASC`, and sign-flips the score so `SearchHit.score` is higher-is-better; empty/whitespace queries short-circuit to `[]`.
- Backfill: the worker calls `observationsMissingEmbeddings` in batches, embeds, and writes back with `putEmbedding` (`INSERT OR REPLACE`); `allEmbeddings({model, dim})` loads the vector table for cosine scoring, copying each BLOB into a fresh buffer before wrapping in `Float32Array` (driver Buffers are reclaimed after statement iteration).
- Lifecycle: `endSession` stamps `ended_at`; `dropEmbeddingsWhereModelNot` runs on worker start when `embedding.model` changed; `rebuildFts()` re-derives the whole FTS index from `observations` via the `'rebuild'` command (routed through `prepare`/`run` so it works on both backends).

## Integration

- `index.ts` exports exactly `Storage` and the six types from `types.ts`; the `bun.test.ts` adapter check and `sanitizeMatch` (exported from `storage.ts` for testing) are not part of the public surface.
- `Storage` takes a plain `dbPath` — it resolves nothing itself; callers (`MemoryStore`, worker, CLI) compute the path from `@cavemem/config#resolveDataDir`, which is why the declared `@cavemem/config` dependency exists even though `src/*.ts` currently imports nothing from it.
- Every other package reaches the database only through these methods; the schema/triggers in `schema.ts` are the reason hook writes stay synchronous (single local SQLite call) while vector search degrades gracefully when the worker is down.
