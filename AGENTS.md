# Repository Guidelines

## Project Structure & Module Organization

cavemem is a pnpm-workspaces TypeScript monorepo. Application entry points live in `apps/`: `cli` publishes the `cavemem` binary, `mcp-server` is the stdio MCP server, and `worker` is the HTTP daemon (viewer, embedding backfill, streamable-HTTP MCP at `/mcp`, remote-mode hook endpoint). Shared code lives in `packages/`, with a strictly downward dependency order: `config → compress → storage → {core, embedding} → hooks → installers`. `packages/storage` is the sole SQLite owner; `packages/core/src/memory-store.ts` (`MemoryStore`) is the sole write path. `viewer/` is the Vite + React read-only UI, `hooks-scripts/` the portable shell stubs, `docs/` the architecture and user docs, `evals/` the token-savings harness. Tests sit beside the code they cover, in each package's `src/` or `test/`.

## Build, Test, and Development Commands

- `pnpm install` — install workspace dependencies (Node ≥ 20, pnpm ≥ 9).
- `pnpm dev` — run the CLI and worker in watch mode against a repo-local `CAVEMEM_HOME=$PWD/.cavemem-dev`, never `~/.cavemem`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — the four required merge gates.
- `pnpm --filter @cavemem/compress test` — required after any compressor, lexicon, or tokenizer change; includes the technical-token preservation suite.
- `pnpm changeset` — required for every change under `packages/*` or `apps/*`; commit the generated file with the PR.
- `bash scripts/e2e-publish.sh` — packed-global-CLI publish test (CI gate). Add `bash scripts/e2e-remote.sh` for remote-mode changes.

## Coding Style & Naming Conventions

TypeScript throughout. Biome owns formatting and linting (`pnpm lint`, `pnpm lint:fix`) — prefer its output over local preference. Use `camelCase` for functions and variables, `PascalCase` for types and classes, `kebab-case` for file names, and `@cavemem/<name>` for package scopes. Keep functions small and pure; comments are minimal and explain **why**, not what. No upward or sideways package imports — cross-package use goes through each package's `package.json#exports`.

## Testing Guidelines

Vitest. Add focused unit tests for new behavior; test invariants and contract shapes, not broad snapshots. Any change to an MCP contract needs an integration test — the MCP inspector for stdio, the SDK's `StreamableHTTPClientTransport` for the worker's `/mcp` route. Round-trip fixtures for compression rules go under `packages/compress/test/fixtures/`. All four merge gates must pass before a PR.

## Security & Configuration

Local by default — the default configuration makes no network calls; remote embedding providers, web enrichment, and remote mode are all opt-in. Persisted prose must pass through `MemoryStore` (redact `<private>` tags → compress → store); paths matching `settings.excludePatterns` are never read, and neither private content nor excluded paths appear in logs. Read `settings.json` only through `@cavemem/config`; open SQLite only through `@cavemem/storage`. Keep runtime data — `data.db`, models, logs, spool — out of the checkout; it belongs in the resolved cavemem home (`~/.cavemem` by default). Never commit secrets or a real embedding-provider API key.

## Commit & Pull Request Guidelines

Use concise Conventional Commit subjects (`feat:`, `fix:`, `docs:`, `chore:`, `test:`), for example `feat: add hook replay metric` or `fix: preserve URL token`. Author commits `--author="Erick <chiefmojo@chiefmojo.com>"`; never add a `Co-Authored-By: <agent>` trailer. When an agent posts a PR comment, review, or description in its own voice, self-identify in the body text with a leading `## <agent name> review — <verdict>` heading instead. PRs need a green CI run and one review; describe the behavior change and the validation commands run, and include a changeset for any `apps/*` or `packages/*` change. Version and dependency bumps go through a PR — never a direct-push bump.

## Project Status — OpenProject

Companion Core status lives in OpenProject (`http://neuromancer:8000`). Sub-projects: Hermes / Identity / Infrastructure / Memory (fork tooling like this lands under Infrastructure or Memory). API reference: `companion-ops/docs/openproject-api-reference.md`.

**On completing any unit of work:**
1. Identify the relevant OpenProject work package. If the task was scoped from an existing WP, use its ID. If none exists, create one under the correct sub-project before closing out — nothing should complete without a WP.
2. Update the work package status field to reflect current state.
3. Add a comment: what changed, and a link to the relevant commit/PR if applicable. This is the log — it lives on the item, not in a shared document.
4. If the work surfaced a new dependency or blocker on another workstream, propose the relation — don't auto-apply speculative ones; flag for review first.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
