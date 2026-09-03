# cavemem — Agent Playbook

This file is the source of truth for AI coding assistants working on this repository. Follow it before generating code, tests, or documentation. If a request conflicts with this file, pause and ask.

## Project identity

cavemem is a cross-agent persistent memory system for coding assistants. It captures observations from editor sessions, compresses prose using the project's deterministic caveman grammar, stores entries in a local SQLite + vector index, and exposes them to agents through a Model Context Protocol (MCP) server and a local web viewer.

The signature property of the project is that **memory is stored compressed**. Every write path runs text through `@cavemem/compress`. Every human-facing read path runs it back through `@cavemem/compress#expand`. Model-facing reads may keep content compressed when the caller requests it.

## Non-negotiable rules

1. **All persisted prose must pass through `packages/compress` before hitting storage.** Writing raw prose to SQLite is a defect. If you add a new write path, it must use `MemoryStore`, which enforces this.
2. **Never compress technical tokens.** Code blocks, inline code, URLs, file paths, shell commands, version numbers, dates, numeric literals, and quoted identifiers are preserved byte-for-byte. The tokenizer in `packages/compress/src/tokenize.ts` is the single authority.
3. **Round-trip tests must pass.** Any change to the compressor, the lexicon, or the tokenizer requires `pnpm --filter @cavemem/compress test` green, including the technical-token preservation suite.
4. **Progressive disclosure in MCP.** `search` and `timeline` return compact results (IDs + snippets). Full observation bodies are only returned by `get_observations(ids[])`. Do not bloat the compact shapes.
5. **Hot-path hooks are fast.** Local and server-injected hook handlers in `packages/hooks` must complete under 150 ms p95. Summarization, embedding, and indexing are handed off to the worker. Individual handlers make no network calls; in remote mode only the runner may perform a bounded hook POST and spool replay.
6. **Privacy is enforced at the write boundary.** Content inside `<private>…</private>` tags is stripped. Paths matching `settings.excludePatterns` are never read. Neither appears in logs. The write boundary is the server's `MemoryStore`: in remote mode, raw hook payloads cross the LAN to the central worker before `excludePatterns` and `<private>` stripping apply (spec decision 4, 2026-09-02).
7. **Local by default.** Default embedding provider is local (Transformers.js). Remote providers are opt-in via settings. Do not add default network calls.
8. **No silent failures.** Hook and worker errors are logged as structured JSON; user-visible commands surface failures with a non-zero exit code and a short message. Remote hook delivery is the deliberate exception: it fails open with structured diagnostics and optional spooling so an IDE turn is not blocked.
9. **No daemon on the local write path.** In local mode hooks write observations synchronously through `MemoryStore.addObservation` — never across a network or HTTP boundary. Hooks may *detach-spawn* the worker to kick off background embedding, but they must never wait on it. If the local worker is down, writes still succeed; only the semantic-search side is degraded (BM25 keeps working). In remote mode (`settings.remote.url` set) hooks POST synchronously to the central worker's `/api/hooks/:event` and never open a local store. Network, timeout, and non-401 HTTP failures are spooled; an invalid URL, missing token, or HTTP 401 logs without spooling.

## Architectural rules

- Monorepo with pnpm workspaces. Dependency direction is strictly downward: `apps/*` may depend on `packages/*`; `packages/*` may depend on each other only in the order `config → compress → storage → { core, embedding } → hooks → installers`. (`core` and `embedding` are siblings — both consume `config` and `storage`, neither depends on the other.) No upward or sideways imports that break this order.
- All database I/O goes through `@cavemem/storage`. No other package opens the DB directly.
- Settings access goes through `@cavemem/config`. No direct reads from `~/.cavemem/settings.json` elsewhere.
- All user-visible strings default to the caveman intensity from settings (default `full`).
- Public package exports are listed in each package's `package.json#exports`. Internal files are not imported across package boundaries.

## Layout

```
apps/cli          user-facing binary
apps/worker       local HTTP daemon: viewer, embedding backfill, remote-mode hook endpoint, MCP over streamable HTTP at /mcp
apps/mcp-server   stdio MCP server; buildServer() is shared with the worker's /mcp route
packages/config   settings schema, loader, defaults, settingsDocs()
packages/compress compression engine + lexicon
packages/storage  SQLite + FTS5 + vector adapter
packages/core     domain models, MemoryStore facade, Embedder interface
packages/embedding provider factory (local / ollama / openai / none)
packages/hooks    lifecycle hook handlers + worker auto-spawn
packages/installers per-IDE integration modules
viewer            Vite + React read-only UI
hooks-scripts     portable shell stubs that invoke node handlers
docs              architecture + user docs
evals             token-savings and round-trip harness
```

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Development workflow

- `pnpm install` once. Node ≥ 20.
- `pnpm dev` runs the CLI and worker in watch mode against `.cavemem-dev/` in the repo root (isolated data dir).
- The four required gates before merging:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
- New features require unit tests. Any change that affects MCP contracts requires an integration test: use the MCP inspector for stdio/local contracts, and the SDK's `StreamableHTTPClientTransport` for the worker's `/mcp` route because browser Origin/CORS policy intentionally rejects the inspector.
- Every PR touching a package under `packages/*` or `apps/*` needs a changeset entry (`pnpm changeset`).

## End-to-end publish test

Unit tests cover handlers, storage, and protocol contracts in isolation. They cannot catch issues that only show up in a globally-installed binary: bin-shim symlink resolution, ESM chunk shebangs, `prepublishOnly` staging, native `better-sqlite3` resolution, dynamic-import bundling. Those failure modes have bitten this repo before — they are now guarded by a dedicated script.

- `bash scripts/e2e-publish.sh` — covers the **changeset publish** path (CI default). Builds, packs (mirroring what `changeset publish` ships), installs into an isolated `.e2e/` prefix with an isolated `$HOME`, drives every Claude Code hook event with a realistic payload, exercises FTS search and the MCP server, then uninstalls. Self-cleans on success. Required to pass in CI before `changeset publish` runs.
- `bash scripts/e2e-pack-release.sh` — covers the **`pnpm publish:release`** path (legacy bespoke flow that uses `apps/cli/scripts/pack-release.mjs` to write `apps/cli/release/`). Run this if you change `pack-release.mjs` or the `dependencies` block of `apps/cli/package.json`.
- `bash scripts/e2e-remote.sh` — covers remote mode: server + client on one box through the packed artifact, all hook events, spool/drain, MCP over HTTP. Required alongside `e2e-publish.sh`.
- The 15 numbered checks in `e2e-publish.sh` must stay green. If you change anything in `apps/cli/`, `packages/installers/`, the hook handler stdout/stderr contract, or the publish surface, re-run it locally before opening a PR.
- Touching the tsup config, the `prepublishOnly` script, or the bin entrypoint guards (`isMainEntry()`) without re-running both scripts is a defect.

## Extension points

- **New IDE integration**: add a module in `packages/installers/src/` that implements the `Installer` interface (`detect`, `install`, `uninstall`, `status`) and register it in the installer index. Update the CLI `install` command choices.
- **New MCP tool**: register in `apps/mcp-server/src/server.ts`, document the contract in `docs/mcp.md`, and add the appropriate integration fixture: MCP inspector for stdio or the SDK client for streamable HTTP.
- **New compression rule**: update `packages/compress/src/lexicon.json`, add at least one round-trip fixture under `packages/compress/test/fixtures/`, and re-run the benchmark in `evals/`.
- **New embedding provider**: add a module in `packages/embedding/src/providers/`, wire it into the `createEmbedder` switch in `packages/embedding/src/index.ts`, and extend the `EmbeddingProvider` enum in `packages/config/src/schema.ts`. Each provider must expose `{ model, dim, embed(text) }` — `dim` must be correct before the first `embed()` call completes (warm-up probe).
- **New storage migration**: add a numbered SQL file in `packages/storage/src/migrations/`. Migrations are forward-only.
- **New CLI setting**: add the field to `SettingsSchema` with a `.describe(…)` string. `cavemem config show` and `settingsDocs()` pick it up automatically — no parallel docs to maintain.

## Performance budgets

- Hook handler p95 runtime: 150 ms.
- `search` MCP call p95: 50 ms for up to 50k observations.
- Compression throughput: ≥ 5 MB/s on one core.
- Worker cold start: ≤ 500 ms on Node, ≤ 100 ms on Bun.

## Release policy

- Versioning via changesets. Releases are normally cut by GitHub Actions (`.github/workflows/release.yml`) on merge to `main` when a release changeset exists. Local publishing from a laptop is permitted as a fallback when CI publishing is unavailable (e.g. missing/expired `NPM_TOKEN`); use `pnpm --filter cavemem publish:release` from `main` after `npm login`.
- Conventional Commits for commit messages. PRs require passing CI and one review.

## Authorship voice

Code comments are minimal and explain **why**, not what. Keep naming explicit. Prefer pure functions. Avoid adding dependencies when the standard library or an existing package covers the need.
