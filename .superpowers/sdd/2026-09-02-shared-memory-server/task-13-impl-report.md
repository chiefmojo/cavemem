# Task 13 implementation report

## Scope

Implemented Task 13 from `docs/superpowers/plans/2026-09-02-shared-memory-server.md` in the existing linked worktree `/tmp/cavemem-shared-memory-server` on branch `feat/shared-memory-server`.

- Baseline: `2ae3c33372ed5ece8acf615e48c8ca495771d6aa`
- Task brief: `.superpowers/sdd/2026-09-02-shared-memory-server/task-13-brief.md`
- Design: `docs/superpowers/specs/2026-09-02-shared-memory-server-design.md`
- Initial commit subject: `docs: remote mode, MCP transport, rules 6 and 9, changeset`
- Round-one correction subject: `docs: reconcile remote mode guidance`
- Round-two correction subject: `docs: qualify README local defaults`
- Required author: `Erick <chiefmojo@chiefmojo.com>`

The worktree did not contain an `AGENTS.md`; the supplied cavemem Agent Playbook and the repository's identical `CLAUDE.md` rules were treated as authoritative. No implementation behavior, deployment, live service, remote data, push, or PR operation was in scope.

## Documentation and release metadata

- `CLAUDE.md`
  - Amended privacy rule 6 to identify the server-side `MemoryStore` as the remote-mode write boundary and state that raw hook payloads cross the LAN before filtering.
  - Amended rule 9 to distinguish the daemon-free local write path from synchronous remote hook POSTs with local spooling.
  - Updated the worker/MCP layout entries for `/api/hooks/:event` and `/mcp` responsibilities.
  - Added `scripts/e2e-remote.sh` to the required publish-test guidance.
- `docs/mcp.md`
  - Documented both stdio local transport and stateless streamable HTTP remote transport.
  - Added the requested transport matrix and Host/Origin, bearer, and no-SSE constraints.
- `docs/remote.md`
  - Added the remote-mode overview.
  - Documented exact settings and defaults for `remote.url`, `remote.token`, `remote.timeoutMs`, `workerHost`, `workerAllowedHosts`, and `embedding.idleShutdownMs`.
  - Documented hook, MCP installer, search, and local-command behavior on clients.
  - Copied the design's failure-behaviour outcomes, including outage degradation, auth failures, bounded replay, and server-side poison-payload handling.
  - Repeated the privacy boundary and linked the deployment runbook.
- `README.md`
  - Added a three-sentence Remote mode section immediately after installation guidance, linking `docs/remote.md` and `deploy/README.md`.
- `apps/worker/codemap.md`
  - Documented the remote hook endpoint, HTTP MCP route, `allowedHostSet`, and `workerHost` bind responsibilities.
- `packages/hooks/codemap.md`
  - Documented `remote.ts`, `spool.ts`, and the runner's remote branch.
- `.changeset/shared-memory-server.md`
  - Added the exact requested minor changeset for `cavemem`, config, core, hooks, installers, worker, and MCP server.

## Authorized mechanical lint cleanup

The baseline `pnpm lint` failed with exactly four existing Biome findings. Biome was run with write scope restricted to the four authorized files:

- `packages/config/src/schema.ts`: formatter collapsed the `workerPort` zod chain.
- `packages/config/test/schema.test.ts`: formatter wrapped the `workerAllowedHosts` fixture.
- `apps/mcp-server/test/server.test.ts`: import organizer sorted the three `@cavemem/*` imports.
- `apps/worker/test/server.test.ts`: formatter wrapped two long object constructions.

These changes are whitespace/import-order only and do not alter runtime or test behavior. No other source or test file was formatted.

## Round-one review corrections

Addressed every P2/P3 finding in `.superpowers/sdd/2026-09-02-shared-memory-server/task-13-review-report.md`:

- Reconciled `CLAUDE.md` with the implemented mode split: individual/injected handlers remain network-free, while only the remote runner performs bounded HTTP and replay work; remote delivery fails open; missing-token and HTTP 401 paths do not spool.
- Replaced both MCP inspector-only directives with transport-specific rules: inspector for stdio/local contracts and the SDK's `StreamableHTTPClientTransport` for `/mcp`, which intentionally remains unavailable to browser Origins.
- Reworked `codemap.md`, `apps/worker/codemap.md`, and `packages/hooks/codemap.md` throughout their responsibility, design, flow, integration, route, dependency, public-surface, and test sections. The earlier local-only descriptions were replaced rather than left beside remote-mode override paragraphs.
- Corrected the README to require rerunning the explicit Claude Code, Codex, and OpenCode installer commands after setting `remote.url`; changing settings alone does not rewrite existing IDE MCP configuration.
- Corrected remote failure telemetry: runner diagnostics are followed by the CLI's normal structured hook telemetry, and a spool-layer error may add another structured diagnostic.

## Verification

All initial Task 13 gates were run from `/tmp/cavemem-shared-memory-server` after the original implementation edits:

| Gate | Result |
|------|--------|
| `pnpm lint` | Passed; Biome checked 149 files with no fixes required. |
| `pnpm typecheck` | Passed; all 11 participating workspace projects completed. |
| `pnpm test` | Passed; 349 tests passed across 32 test files, with the eval workspace correctly reporting no tests under `--passWithNoTests`. |
| `pnpm build` | Passed; all 10 participating package/app builds completed. |
| `bash scripts/e2e-publish.sh` | Passed all 15 numbered checks and ended `ALL CHECKS PASSED`. The first sandboxed attempt failed during isolated npm installation with `EAI_AGAIN`; the required rerun with network permission completed successfully. |
| `bash scripts/e2e-remote.sh` | Passed all 14 numbered checks and ended `ALL REMOTE CHECKS PASSED`, including full remote hooks, no client DB, HTTP search, status/doctor, local-command refusal, authenticated MCP initialize, bearer rejection, and outage spool/drain. |
| `git diff --check` | Passed with no whitespace errors. |

The two e2e scripts used their own isolated homes/prefixes and packed artifact. No SSH, deployment, live service, live data, push, PR, or tracker operation was performed.

After the round-one documentation corrections, documentation consistency checks and `git diff --check` passed; `pnpm lint` checked 149 files cleanly; all 11 participating `pnpm typecheck` projects passed; and all 349 tests in 32 files passed under `pnpm test`. The build and packed-artifact e2e scripts were not rerun because this correction changes documentation only: no executable source, build configuration, package dependency, installer implementation, or publish script changed.

## Round-two review correction

The updated review identified three remaining README statements that described local mode as universal. The lead now names the default local configuration and identifies remote embeddings, web enrichment, and remote mode as opt-in network features; the Local by default feature makes the same distinctions; and the installation paragraph is explicitly scoped to local mode. Stale-wording checks and `git diff --check` passed, and `pnpm lint` checked all 149 files with no findings. The first sandboxed lint launcher encountered `EAI_AGAIN` while resolving pnpm; its authorized rerun passed. This was a two-file documentation/evidence update only, so executable gates and packed-artifact e2es were unaffected.
