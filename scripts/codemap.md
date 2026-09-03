# scripts/

## Responsibility
End-to-end test harness. These shell scripts verify failure modes that unit tests cannot reach in a globally-installed binary: bin-shim symlink resolution, ESM chunk shebangs, `prepublishOnly` staging, native `better-sqlite3` resolution, and dynamic-import bundling. `e2e-remote.sh` additionally covers cross-process behavior only a real worker/client pair can expose: remote hooks and search over HTTP, bearer auth, the viewer cookie handshake, and spool/drain across a worker outage.

## Design
Three companion scripts cover the two distinct publish paths plus the remote-mode runtime:
- `e2e-publish.sh` — covers the **changeset publish** path (CI default). Builds, packs (mirroring what `changeset publish` ships), installs into an isolated `.e2e/` prefix with an isolated `$HOME`, drives every Claude Code hook event with realistic payloads, exercises FTS search and the MCP server, then uninstalls. Runs 15 numbered checks. Self-cleans on success.
- `e2e-pack-release.sh` — covers the legacy `pnpm publish:release` path (via `apps/cli/scripts/pack-release.mjs` writing `apps/cli/release/`). Dry-runs the same artifact: pack → install → drive a hook → search.
- `e2e-remote.sh` — covers the **remote-mode runtime** path against the published artifact (build + pack + install as above). Boots a worker in one isolated `$HOME` (free port, `provider: none`, idle shutdown off) and points a second isolated `$HOME` at it via `remote.url`/`worker-token`. Drives every hook event from the client and asserts: rows land only on the server (no client `data.db`), remote search/`status`/`doctor` behave, local-only commands refuse, `install --ide claude-code` writes an http `/mcp` entry, MCP-over-HTTP answers `initialize` with a bearer token and 401s without one, the viewer requires its single-use cookie handshake (nonce → 302 → cookie, which never authenticates `/api/*`), and hooks spool during a worker outage and drain on recovery. Runs 15 numbered checks. Self-cleans via an EXIT trap (kills the worker, removes `.e2e-remote/`).

## Flow
1. Build and stage publish files.
2. `npm pack` the release dir (mirrors what `changeset publish` / `publish:release` uploads).
3. `npm install -g` into an isolated `--prefix` with a sandboxed `$HOME` (unsetting `CAVEMEM_HOME`/`XDG_DATA_HOME` to keep the test from escaping the sandbox — issue #47).
4. Drive the full hook lifecycle, verify FTS search, `doctor`, `status`, `config show`, MCP launch, and uninstall cleanup.
5. (`e2e-remote.sh` only) Start the worker in a server `$HOME`, point a client `$HOME` at it over HTTP, then drive hooks, search, MCP-over-HTTP, and the viewer handshake against it — including a kill/restart cycle to prove spool-and-drain.

## Integration
- Consumes the built `apps/cli` binary (CLI and `worker run`) and `packages/installers`.
- Required gate in CI before `changeset publish` runs; `e2e-remote.sh` is the additional gate for remote-mode changes.
- Re-run locally when touching `apps/cli/`, `packages/installers/`, the hook stdout/stderr contract, the publish surface, or the remote-mode surface (worker HTTP endpoints, `/mcp`, the viewer cookie handshake, client remote settings, spool/drain).
