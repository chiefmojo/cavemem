# packages/

## Responsibility
The reusable library layer of the cavemem monorepo. Each package ships a focused capability; together they implement the full memory pipeline — from settings and compression, through SQLite persistence and hybrid search, up to the hook handlers that IDE integrations invoke.

## Design
- pnpm workspace with strict downward dependency order: `config → compress → storage → { core, embedding } → hooks → installers`. `core` and `embedding` are siblings (both consume `config` + `storage`, neither depends on the other).
- Each package exposes a narrow public surface via `package.json#exports`; internal files are never imported across package boundaries.
- `config` and `compress` have zero runtime dependencies; `storage` is the only package permitted to open the DB.

## Flow
Settings (`config`) → compression (`compress`) → persistence (`storage`) → domain facade + hybrid search (`core`) and vectors (`embedding`) → hook handlers (`hooks`) → per-IDE wiring (`installers`).

## Integration
- Consumed by `apps/*` (cli, mcp-server, worker) and `evals`.
- Each package has its own codemap at the paths below.

## Directory Map
| Package | Responsibility Summary | Detailed Map |
|---------|------------------------|--------------|
| `config/` | Single authority for settings — zod `SettingsSchema`, portable `settings.json` load/save, `settingsDocs()`, home/data-dir resolution, path-glob matching. | [View Map](config/codemap.md) |
| `compress/` | Deterministic caveman-grammar compression engine — `compress`/`expand`, technical-token-preserving tokenizer, privacy scrubbers. | [View Map](compress/codemap.md) |
| `storage/` | Sole SQLite owner — idempotent schema (WAL + FTS5 + sync triggers), dual backend, BM25 `searchFts`, embedding persistence. | [View Map](storage/codemap.md) |
| `core/` | Domain layer — models, hybrid ranker, session IDs, and `MemoryStore`, the single enforced write path (redact → compress → persist). | [View Map](core/codemap.md) |
| `embedding/` | Provider factory — `Embedder { model, dim, embed }` (local/Ollama/OpenAI/`none`), dim correctness before first use, musl-libc guard. | [View Map](embedding/codemap.md) |
| `hooks/` | IDE lifecycle hook handlers + dispatcher + worker auto-spawn (150 ms p95 hot path, no network calls). | [View Map](hooks/codemap.md) |
| `installers/` | Per-IDE detect/install/uninstall modules registering hooks + MCP entries across nine IDEs behind a uniform `Installer` contract. | [View Map](installers/codemap.md) |
