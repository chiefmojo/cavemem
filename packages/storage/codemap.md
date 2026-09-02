# packages/storage/

## Responsibility

`@cavemem/storage` is the only package in the monorepo allowed to open the SQLite database (`data.db`). It owns the schema (`src/schema.ts`), the `Storage` class that encapsulates all SQL (`src/storage.ts`), the row/value types (`src/types.ts`), and the dual-backend adapter that runs on both `better-sqlite3` (Node) and `bun:sqlite` (Bun). It provides sessions, observations, summaries, FTS5/BM25 full-text search, and embedding-vector persistence; hybrid (BM25 + cosine) ranking happens above it (in `@cavemem/core`), which combines `searchFts()` hits with vectors fetched via the embedding accessors.

## Design

- Single dependency on `better-sqlite3` (^12) plus the workspace `@cavemem/config` per the layering order; ESM, built with tsup, one export surface.
- `storage.ts` defines a minimal driver-neutral interface (`DbHandle`/`Stmt`/`RunResult`) and `openDb()` picks the backend: `isBun` (via `process.versions.bun`) loads `bun:sqlite` through `createRequire`, otherwise the `better-sqlite3` native addon. Bun's `get()` returning `null` on no-match is normalised to `undefined` (`normalizeBunGet`), and Bun transactions are emulated with prepared `BEGIN`/`COMMIT`/`ROLLBACK`.
- Schema is idempotent DDL guarded by `CREATE ... IF NOT EXISTS` plus a `schema_version` table seeded with `INSERT OR IGNORE ... VALUES (2)` — this is the forward-only versioning mechanism; there is no `src/migrations/` directory of numbered SQL files.
- FTS5 is a content-synced external-content index (`observations_fts` with `content='observations'`, `content_rowid='id'`, `tokenize='porter unicode61'`), kept consistent by `AFTER INSERT/DELETE/UPDATE` triggers `obs_ai`/`obs_ad`/`obs_au` on `observations`.
- Vectors are stored as raw `BLOB`s of `Float32Array` bytes in `embeddings` keyed by `observation_id`, tagged with `model` + `dim` so stale-model rows can be detected and dropped.
- `searchFts` returns `SearchHit[]` with the FTS5 `bm25()` score sign-flipped (`-r.score`) so higher-is-better downstream, and generates highlighted `snippet()`s; `sanitizeMatch` (exported for tests) wraps each query term in escaped double quotes to avoid FTS5 syntax errors.

## Flow

- Construction: `new Storage(dbPath, { readonly? })` → `mkdirSync` of the parent dir → `openDb` → `runSchema(SCHEMA_SQL)` (skipped in readonly mode, which is only ever pointed at a DB a prior writable `Storage` has initialised). `close()` releases the handle.
- Write path (hooks → `MemoryStore`): `createSession` is `INSERT OR IGNORE` (SessionStart re-fires on resume/clear/compact; boolean return also gives `cavemem import` idempotency), `insertObservation` inserts a row and the `obs_ai` trigger keeps FTS in sync, `insertSummary` appends turn/session summaries.
- Import path: `importObservation(row)` treats the exported id as *preferred*, never authoritative — de-dupes on `(session_id, ts, content)` (`'skipped'`), inserts at the exported id when free (`'inserted'`), or falls back to a fresh AUTOINCREMENT id (`'reassigned'`); content is stored verbatim (the sanctioned exception to "compress on write" — it was compressed on the source machine).
- Read path: `getObservations(ids)` bulk IN-fetch; `timeline(sessionId, aroundId?, limit)` returns a window centred on a row via two bounded queries merged in JS (a single UNION+LIMIT would let the "after" half starve the window); `searchFts(query, limit, cwd?)` optionally joins `sessions` to restrict hits to one project cwd.
- Embedding path: `putEmbedding`/`getEmbedding` serialise `Float32Array` ⇄ `BLOB`; `allEmbeddings({model, dim})` copies each `Buffer` into a fresh `Float32Array` (the driver Buffer is freed after statement iteration); `observationsMissingEmbeddings(limit, model?)` LEFT-JOINs for backfill; `dropEmbeddingsWhereModelNot(model)` clears stale vectors after a model switch.

## Integration

- Consumed by `packages/core` (`MemoryStore` composes `Storage` with compression + hybrid search), `apps/worker` (embedding backfill, viewer), and `apps/cli` (`commands/export.ts`, `import` tests, `reindex.ts`, `status.ts`, `doctor.ts` — the readonly path).
- Downstream of `@cavemem/config` (data-dir resolution locates `data.db`); upstream consumers (`core`, `hooks`, `embedding`, apps) never issue SQL themselves — the "all DB I/O through `@cavemem/storage`" rule is enforced by convention here.
- Type exports (`SessionRow`, `ObservationRow`, `SummaryRow`, `NewObservation`, `NewSummary`, `SearchHit`) are the contract other packages compile against.
