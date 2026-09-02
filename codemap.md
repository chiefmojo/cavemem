# Repository Atlas: cavemem

## Project Responsibility
A cross-agent persistent memory system for coding assistants. It captures observations from editor sessions, compresses prose using the project's deterministic caveman grammar (`@cavemem/compress`), stores entries in a local SQLite + vector index (`@cavemem/storage`), and exposes them to agents through an MCP server (`apps/mcp-server`) and a local web viewer (served by `apps/worker`). The signature property is that **memory is stored compressed** — every write runs through `compress`, every human-facing read runs back through `expand`.

## System Entry Points
- `apps/cli/src/index.ts` — the published `cavemem` binary: commander CLI + OpenCode plugin bridge (`opencode-bridge.ts`).
- `apps/mcp-server/src/server.ts` — stdio MCP server (tool registration, progressive disclosure).
- `apps/worker/src/server.ts` — local HTTP daemon (read-only viewer + embedding backfill).
- `packages/core/src/memory-store.ts` — `MemoryStore`, the single enforced write path.
- `packages/compress/src/tokenize.ts` — the single authority for technical-token preservation.
- `package.json` / `pnpm-workspace.yaml` — workspace + build orchestration.
- `CLAUDE.md` — authoritative project rules and architecture.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `packages/config/` | Single authority for settings — zod `SettingsSchema`, portable `settings.json` load/save, `settingsDocs()`, home/data-dir resolution, path-glob matching. | [View Map](packages/config/codemap.md) |
| `packages/compress/` | Deterministic caveman-grammar compression engine — `compress`/`expand`, technical-token-preserving tokenizer, privacy scrubbers. | [View Map](packages/compress/codemap.md) |
| `packages/storage/` | Sole SQLite owner — idempotent schema (WAL + FTS5 + sync triggers), dual backend, BM25 `searchFts`, embedding persistence. | [View Map](packages/storage/codemap.md) |
| `packages/core/` | Domain layer — models, hybrid ranker, session IDs, and `MemoryStore`, the single enforced write path (redact → compress → persist). | [View Map](packages/core/codemap.md) |
| `packages/embedding/` | Provider factory — `Embedder { model, dim, embed }` (local/Ollama/OpenAI/`none`), dim correctness before first use, musl-libc guard. | [View Map](packages/embedding/codemap.md) |
| `packages/hooks/` | IDE lifecycle hook handlers + dispatcher + worker auto-spawn (150 ms p95 hot path, no network calls). | [View Map](packages/hooks/codemap.md) |
| `packages/installers/` | Per-IDE detect/install/uninstall modules registering hooks + MCP entries across nine IDEs behind a uniform `Installer` contract. | [View Map](packages/installers/codemap.md) |
| `apps/cli/` | The published `cavemem` npm binary — commander CLI + OpenCode plugin bridge + prepack/pack-release publish tooling. | [View Map](apps/cli/codemap.md) |
| `apps/mcp-server/` | stdio MCP server — progressive disclosure + opt-in SSRF-hardened web enrichment. | [View Map](apps/mcp-server/codemap.md) |
| `apps/worker/` | 127.0.0.1-only HTTP daemon — read-only viewer + embedding backfill loop. | [View Map](apps/worker/codemap.md) |
| `evals/` | Token-savings benchmark harness running `@cavemem/compress` over a fixed corpus. | [View Map](evals/codemap.md) |
| `hooks-scripts/` | Portable shell stubs that invoke `cavemem hook run <event>`. | [View Map](hooks-scripts/codemap.md) |
| `scripts/` | End-to-end publish test harness (changeset + legacy `publish:release` paths). | [View Map](scripts/codemap.md) |
| `examples/` | Reference `settings.example.json` sample. | [View Map](examples/codemap.md) |

## Dependency Direction
Strictly downward: `apps/*` may depend on `packages/*`; `packages/*` may depend on each other only in the order `config → compress → storage → { core, embedding } → hooks → installers`. `core` and `embedding` are siblings. No upward or sideways imports.

## Notes
- The `viewer` listed in `CLAUDE.md`'s Layout does not exist as a standalone directory — the read-only UI is served by `apps/worker` (`viewer.ts`). The worker's codemap is the authority for viewer behavior.
- `.github/workflows/`, `.changeset/`, and `docs/` are not mapped (not source/config-tracked); `docs/mcp.md` documents the MCP contract, `docs/architecture.md` the high-level design.
