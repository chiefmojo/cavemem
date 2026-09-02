# packages/core/

## Responsibility

`@cavemem/core` is the domain layer of cavemem: it owns the domain models (`Observation`, `Session`, `SearchResult` in `src/types.ts`), the session-ID generator (`src/ids.ts`), the hybrid BM25+vector ranker (`src/ranker.ts`), and — most importantly — `MemoryStore` (`src/memory-store.ts`), the facade that is the **single enforced write path** into storage. Per the playbook, no code may write prose to SQLite except through `MemoryStore`, which guarantees the pipeline *redact private tags → compress → persist*. It also declares the structural `Embedder` interface that the sibling `@cavemem/embedding` package implements (they are intentionally not linked by an import).

## Design

- **Facade over the lower tiers.** `MemoryStore` composes `@cavemem/storage` (all DB I/O), `@cavemem/compress` (`compress`/`expand`/`redactPrivate`/`redactSecrets`), and `@cavemem/config` (`Settings`). It is constructed with `MemoryStoreOptions { dbPath, settings }` and instantiates `Storage` internally; callers never touch the DB directly.
- **Write-path pipeline.** `addObservation` and `addSummary` both run `redactPrivate` first (dropping the write with `-1` if the content becomes empty), conditionally `redactSecrets` when `settings.privacy.redactSecrets`, then `compress` at `settings.compression.intensity`, and store with `compressed: true` plus the intensity used — so future readers know how to expand.
- **Privacy over convenience.** Content inside `<private>…</private>` tags never reaches storage; summaries get the same secret-scrubbing as observations because assistant turns routinely echo credentials.
- **Reads honor progressive disclosure.** `timeline()` always returns compressed content; `getObservations()` expands only when `opts.expand` (defaulting to `settings.compression.expandForModel`) says so.
- **Search is dependency-inverted.** `MemoryStore.search(query, limit?, embedder?)` takes an optional `Embedder` *parameter* rather than importing `@cavemem/embedding` — that keeps `core` and `embedding` siblings (both consume config + storage, neither depends on the other). `Embedder` is defined structurally in `memory-store.ts`; any object with `{ model, dim, embed }` satisfies it.
- **Graceful degradation.** Search falls back to pure keyword (BM25/FTS) whenever there is no embedder, `settings.embedding.provider === 'none'`, no vectors exist for the embedder's `{model, dim}`, or the provider's returned vector length disagrees with its declared `dim`.
- **Pure, testable helpers.** `hybridRank`/`cosine` in `ranker.ts` are stateless functions with no I/O.

## Flow

- **Write (hooks → CLI):** hook handlers call `store.addObservation({ session_id, kind, content, metadata? })` → `redactPrivate` → optional `redactSecrets` → `ensureSession(session_id)` (idempotent sessions-row materialization, guarding the missing-SessionStart case that otherwise trips the `sessions.id` foreign key) → `compress(content, { intensity })` → `storage.insertObservation` → returns row id.
- **Read (MCP):** `getObservations(ids, { expand })` → `storage.getObservations` → `toObservation` maps each `ObservationRow`, running `expand()` only when requested and `safeParse`-ing metadata JSON. `timeline(sessionId, aroundId?, limit?)` returns compressed rows.
- **Search (MCP/CLI):** FTS first: `storage.searchFts(query, cap * 2)`. If an embedder is available and usable, load `storage.allEmbeddings({ model, dim })`, embed the query, score every vector with `cosine(qvec, v.vec)`, merge BM25 and cosine scores per id in a `Map`, blend with `hybridRank(merged, settings.search.alpha)`, cut to `cap`, and backfill `session_id`/`snippet`/`ts` for vector-only hits by fetching those observations (snippet = first 120 chars of stored content).

## Integration

- **Depends on** (strictly downward): `@cavemem/config`, `@cavemem/compress`, `@cavemem/storage` — see `package.json#dependencies`.
- **Public surface** (`src/index.ts`): `MemoryStore`, `Embedder`, `hybridRank`, types `Observation`/`Session`/`SearchResult`/`GetObservationsOptions`, and `createSessionId`. Only the `.` export is published via `package.json#exports`.
- **Consumers:** `packages/hooks` (`src/runner.ts` and every handler — the hot write path), `apps/mcp-server/src/server.ts` (`MemoryStore` + `Embedder` + `createSessionId`), `apps/worker` (`src/server.ts`, `src/embed-loop.ts` — the embedding backfill loop), and `apps/cli` (`src/commands/search.ts`, `src/opencode-bridge.ts`).
- **Does NOT depend on** `@cavemem/embedding`; callers (worker, mcp-server, cli) construct an embedder via `createEmbedder(settings)` and pass it into `MemoryStore.search`.
