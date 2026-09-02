# scripts/

## Responsibility
End-to-end publish test harness. These shell scripts verify failure modes that unit tests cannot reach in a globally-installed binary: bin-shim symlink resolution, ESM chunk shebangs, `prepublishOnly` staging, native `better-sqlite3` resolution, and dynamic-import bundling.

## Design
Two companion scripts cover the two distinct publish paths:
- `e2e-publish.sh` — covers the **changeset publish** path (CI default). Builds, packs (mirroring what `changeset publish` ships), installs into an isolated `.e2e/` prefix with an isolated `$HOME`, drives every Claude Code hook event with realistic payloads, exercises FTS search and the MCP server, then uninstalls. Runs 15 numbered checks. Self-cleans on success.
- `e2e-pack-release.sh` — covers the legacy `pnpm publish:release` path (via `apps/cli/scripts/pack-release.mjs` writing `apps/cli/release/`). Dry-runs the same artifact: pack → install → drive a hook → search.

## Flow
1. Build and stage publish files.
2. `npm pack` the release dir (mirrors what `changeset publish` / `publish:release` uploads).
3. `npm install -g` into an isolated `--prefix` with a sandboxed `$HOME` (unsetting `CAVEMEM_HOME`/`XDG_DATA_HOME` to keep the test from escaping the sandbox — issue #47).
4. Drive the full hook lifecycle, verify FTS search, `doctor`, `status`, `config show`, MCP launch, and uninstall cleanup.

## Integration
- Consumes the built `apps/cli` binary and `packages/installers`.
- Required gate in CI before `changeset publish` runs.
- Re-run locally when touching `apps/cli/`, `packages/installers/`, the hook stdout/stderr contract, or the publish surface.
