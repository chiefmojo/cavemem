# apps/cli/scripts/

Node build/publish scripts for the `cavemem` npm package. Plain `.mjs` (no TypeScript) because they run in npm lifecycle hooks outside the compiled bundle.

## Responsibility

Two publish paths, both required to work (CLAUDE.md release policy):

- `prepack.mjs` — the **changeset publish / npm publish** path. Registered in `prepublishOnly` and `stage-publish`, after `verify-dist.mjs` in `package.json`. Stages repo-root assets into `apps/cli/` so the `files` allowlist (`dist`, `hooks-scripts`, `README.md`, `LICENSE`) picks them up when npm builds the tarball.
- `verify-dist.mjs` — publish guard. Runs first in `prepublishOnly` and `stage-publish`: fails unless `dist/index.js --version` equals `package.json#version` and `dist/opencodeBridge.js` is a sole default `{ id, setup, server }` plugin (the e2e step 6b predicate). Added after 0.4.4 shipped the stale 0.4.3 build. Catches version-stale builds only.
- `pack-release.mjs` — the **legacy `publish:release`** path (`pnpm pack:release` → `pnpm publish:release`). Builds a fully self-contained `apps/cli/release/` staging directory that is published directly via `npm publish ./release --access public`.

## Design

**prepack.mjs**
- Copies `README.md`, `LICENSE`, and `hooks-scripts/` from the repo root into `apps/cli/` (recursive copy for the hook stubs). The portable shell stubs (`session-start.sh`, `user-prompt-submit.sh`, `post-tool-use.sh`, `stop.sh`, `session-end.sh`) must ship in the tarball — they are what installed IDE hook configs invoke, and they in turn call `cavemem hook run <name>`.
- Guards against non-source environments: `npm prepack` also fires when the package is installed from a tarball or git URL, where repo-root sources don't exist. The script detects this by checking for `pnpm-workspace.yaml` at the resolved repo root and exits 0 silently if absent; missing individual sources exit 1 with a short message (no silent failures).

**pack-release.mjs**
- Wipes and recreates `apps/cli/release/`, then assembles a hand-written minimal `package.json` instead of copying the workspace one: keeps package identity/engines/`bin`/`main`, but **narrows `dependencies` to the exact list tsup keeps external** (`RUNTIME_DEPS` = commander, kleur, better-sqlite3, hono, @hono/node-server, @modelcontextprotocol/sdk). All `@cavemem/*` workspace code is bundled into `dist/index.js` by tsup (`noExternal: [/^@cavemem\//]`), so shipping them as dependencies would be wrong — they don't exist in the tarball.
- **Preserves `optionalDependencies`** (`@huggingface/transformers`): tsup also keeps it external (bundling it would drag the ONNX runtime + sharp native binaries into the CLI dist), so dropping it would ship a package whose local embedding provider can never load. This is why the `dependencies` block of `apps/cli/package.json` is contract-sensitive — changing it requires re-running `scripts/e2e-pack-release.sh`.
- Copies `dist/` (both entries: `index.js`, `opencodeBridge.js`), `hooks-scripts/`, `README.md`, `LICENSE` from the repo root. Strips the leading `./` from `bin`/`main` values.

## Flow

- **changeset path**: `pnpm release` (`pnpm build && changeset publish`) → npm `prepublishOnly` → `verify-dist.mjs` → `prepack.mjs` stages assets → npm packs per `files` → publishes (guarded by `scripts/e2e-publish.sh`, whose 15 checks mirror this packing).
- **release path**: `pnpm publish:release` → `pack:release` (`pnpm build && node scripts/pack-release.mjs`) → `release/` ready → `npm publish ./release --access public`.
- Both paths build first (`pnpm release` and `pack:release` each run `pnpm build`); `verify-dist.mjs` enforces it on the changeset path (tsup emits `dist/index.js` + `dist/opencodeBridge.js` with `__CAVEMEM_VERSION__` defined and no banner-shebang stacking).

## Integration

- Wired via `apps/cli/package.json#scripts`: `prepublishOnly` + `stage-publish` → `verify-dist.mjs && prepack.mjs`; `pack:release`/`publish:release` → `pack-release.mjs`.
- Consumes repo-root artifacts: `README.md`, `LICENSE`, `hooks-scripts/` (root), `apps/cli/dist/`, `apps/cli/package.json`; produces `apps/cli/release/` and staged copies inside `apps/cli/`.
- Verified end-to-end by `scripts/e2e-publish.sh` (changeset path) and `scripts/e2e-pack-release.sh` (release path) — per CLAUDE.md, re-run both after touching anything in this directory, the tsup config, or the `dependencies` block.
