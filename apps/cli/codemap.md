# apps/cli/

The published npm package `cavemem` — the user-facing binary. It is the only workspace package that npm users install; everything else is bundled into it at build time.

## Responsibility

Owns three distinct surfaces that all ship in one package:

1. **The `cavemem` CLI** (`bin: ./dist/index.js`, package name `"cavemem"`): a commander-based command tree for installing/uninstalling IDE integrations, settings management (`config`), health checks (`doctor`, `status`), memory access (`search`, `compress`/`expand`, `export`/`import`, `reindex`), daemon lifecycle (`start`/`stop`/`restart`/`viewer`, `worker …`), and the internal `hook run` entrypoint that IDE shell stubs invoke. In **remote mode** (`settings.remote.url` set) the same binary acts as a thin client: `search`/`doctor`/`status`/`install` talk to the central server, while daemon/lifecycle/data commands (`worker`, `start`/`stop`/`restart`/`viewer`, `export`/`import`, `mcp`, `reindex`) refuse — there is no local store.
2. **The OpenCode plugin bridge** (`dist/opencodeBridge.js`, second tsup entry from `src/opencode-bridge.ts`) — dynamically loaded by OpenCode to translate its event stream into cavemem hook calls.
3. **The publish surface** (`scripts/prepack.mjs`, `scripts/pack-release.mjs`): stages and packages the tarball for both the changeset publish path and the legacy `publish:release` path.

Sub-packages are *not* runtime dependencies: `apps/mcp-server`, `apps/worker`, and all `@cavemem/*` packages are `devDependencies` because tsup bundles them into `dist/index.js` (`noExternal: [/^@cavemem\//]` in `tsup.config.ts`). The `dependencies` block contains only true third-party runtime deps (commander, kleur, better-sqlite3, hono, @hono/node-server, @modelcontextprotocol/sdk), plus the optional `@huggingface/transformers` (kept external — bundling it would drag ONNX runtime and sharp into dist).

## Design

- **Bundled monolith**: one tsup build, ESM, node20 target, `define: { __CAVEMEM_VERSION__ }` injected from package.json version. No `banner`/shebang stacking — the shebang lives in `src/index.ts` itself, because tsup banners would corrupt dynamic-import chunks that already carry their own shebangs (`apps/{worker,mcp-server}/src/server.ts`). Guarded by `scripts/e2e-publish.sh` (15 numbered checks) since these failure modes (bin-shim symlinks, chunk shebangs, native better-sqlite3, prepublishOnly staging) have bitten the repo before.
- **Registration pattern**: `createProgram()` in `src/index.ts` composes the command tree by calling one `register*Command(program)` function per module in `src/commands/` — commands are decoupled from entry ordering.
- **Entrypoint detection**: `isMainEntry()` resolves `process.argv[1]` through `realpathSync` so npm's bin-shim symlink doesn't defeat the `import.meta.url` comparison. The bundled worker/MCP servers re-apply the same guard so dynamic import from the CLI does not auto-start them; `mcp.ts`/`worker.ts` call their `main()`/`start()` explicitly.
- **Thin orchestration layer**: commands mostly load settings via `@cavemem/config`, construct `Storage`/`MemoryStore` from `@cavemem/storage`/`@cavemem/core`, and delegate to `@cavemem/installers`, `@cavemem/hooks`, `@cavemem/worker`, `@cavemem/mcp-server`, `@cavemem/embedding`. Business logic lives in the packages, not here.
- **IDE-protocol discipline in `hook.ts`**: stderr carries structured telemetry JSON; stdout is reserved for the IDE hook protocol (`hookSpecificOutput.additionalContext` for session-start/user-prompt-submit only). Failures set exit 1 without blocking the agent turn (rule 8), and unknown/stale hook names stay non-blocking.

## Flow

- `cavemem <cmd>` → `dist/index.js` → `isMainEntry()` → `createProgram().parseAsync()` → the matching `register*Command` action → settings load (`loadSettings`) → package facade call (`Installer`, `MemoryStore`, `Storage`, `runHook`, `@cavemem/worker#start`, `@cavemem/mcp-server#main`).
- IDE hook path: `hooks-scripts/<event>.sh` (shipped via prepack) → `cavemem hook run <name> --ide <ide>` → stdin JSON → `@cavemem/hooks#runHook` → `MemoryStore.addObservation` (synchronous, compressed) + detach-spawned worker for embeddings.
- Install path: `cavemem install --ide X` → `resolveCliPath()` → `installer.install(ctx)` writes IDE config (hooks + MCP registration) → `settings.ides[X] = true`.
- Daemon path: `cavemem start` → pidfile `dataDir/worker.pid` → detached `node <cli> worker run` → `@cavemem/worker#start()` (viewer HTTP + embedding backfill loop); state surfaces back via `dataDir/worker.state.json` in `cavemem status`.
- Remote mode: with `settings.remote.url` set, `search` GETs `<remote.url>/api/search` (bearer `remote.token`), `doctor`/`status` probe the server (`/healthz` + authenticated `/api/state`), and local-only commands exit 1 with "run `cavemem <cmd>` on the server" — the daemon, store, and viewer live on the server machine (`apps/worker`); `hook run` dispatches to `<remote.url>/api/hooks/<name>` inside `@cavemem/hooks#runHook`, so `hook.ts` needs no mode check.
- OpenCode path: OpenCode loads `dist/opencodeBridge.js` → events/streams mapped to `cavemem hook run … --ide opencode` (fire-and-forget spawns); context priming reads the store directly.
- Publish path: `changeset publish` → `prepublishOnly`/`prepack` (`scripts/prepack.mjs` stages README/LICENSE/hooks-scripts) → packed tarball. Fallback: `pnpm publish:release` → `scripts/pack-release.mjs` builds `release/` for `npm publish ./release`.

## Integration

- **Downward only** (`apps/*` → `packages/*`): `@cavemem/config` (all settings access), `@cavemem/compress` (compress/expand), `@cavemem/storage` (all DB I/O), `@cavemem/core` (`MemoryStore`), `@cavemem/embedding` (`createEmbedder`), `@cavemem/hooks` (`runHook`, hook names/types), `@cavemem/installers` (installer registry, `checkWindowsSh`), plus sibling apps `@cavemem/worker` and `@cavemem/mcp-server` imported dynamically and bundled in.
- **Consumed by**: IDEs (bin + `hooks-scripts/` stubs), OpenCode (`opencodeBridge.js`), and repo-level verification (`scripts/e2e-publish.sh` drives the packed binary end to end).
- **Release machinery**: version/changesets owned by repo-level `.github/workflows/release.yml`; this app's `package.json#scripts` (`prepublishOnly`, `stage-publish`, `pack:release`, `publish:release`) implement the two publish flows. Changing anything here requires re-running `scripts/e2e-publish.sh` and `scripts/e2e-pack-release.sh` (per CLAUDE.md).

Child maps: [src/codemap.md](src/codemap.md) · [scripts/codemap.md](scripts/codemap.md)
