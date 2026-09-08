# apps/cli/src/util/

Shared CLI helpers.

## Responsibility

Four modules:

- `resolve.ts#resolveCliPath()` — resolves the absolute path to the running `cavemem` CLI binary.
- `mode.ts` — remote-vs-local mode detection and the local-only command guard.
- `remote.ts` — remote-mode HTTP client calls (search + server health/auth probe).
- `summary-coverage.ts` — pure formatter for per-IDE turn-summary coverage rows (`doctor`/`status`).

## Design

### `resolve.ts`

`resolveCliPath()` returns `realpathSync(process.argv[1])`. The realpath step is essential: npm installs the bin as a **symlink** (`bin-shim`), and IDE config files must reference the real script location, not the symlink (which may be recreated/unstable across npm operations). If `argv[1]` is missing or cannot be realpathed, it degrades to `'cavemem'` (PATH lookup) or the raw `argv[1]` respectively. Deliberately dependency-free — pure `node:fs`.

### `mode.ts`

Mode detection is deliberately minimal: `isRemote(settings)` is just `Boolean(settings.remote.url)` — the same single switch `@cavemem/hooks#remoteTarget()` uses (schema: `packages/config` `remote.url`/`remote.token`/`remote.timeoutMs`), so there is exactly one source of truth for "am I talking to a server". `requireLocal(settings, command)` guards commands that have no meaning on a remote-mode client because there is no local store: in remote mode it writes `remote mode: run \`cavemem <command>\` on the server (<remote.url>)` to stderr (red `remote mode:` prefix), sets `process.exitCode = 1`, and returns `false` so the caller can bail before opening the (empty or absent) local `data.db` — refuse loudly rather than silently operate on a fresh database.

### `remote.ts`

Thin `fetch` wrappers over the `RemoteTarget { url, token, timeoutMs }` produced by `@cavemem/hooks#remoteTarget()` — the exact same target type the hook POST path uses, so URL canonicalization/token/timeout semantics can't drift between hooks and CLI:

- `checkedRemoteTarget(settings)` — calls `remoteTarget()` and rethrows its URL-validation errors as `Invalid remote configuration: <message>`; returns `null` in local mode, so callers use `if (target)` as the remote branch.
- `remoteSearch(target, query, limit)` — GET `<url>/api/search?q=<query>&limit=<n>` with a `Bearer <token ?? ''>` header and `AbortSignal.timeout(timeoutMs)`; throws `remote search failed: <status>` on any non-ok response; parses the body as `SearchResult[]`.
- `probeRemote(target)` — GET `/healthz` unauthenticated, then GET `/api/state` with the bearer header; returns `{ healthz, auth, error? }` and **never throws** (transport errors are folded into `error`), which is what makes it usable for `doctor`/`status` reporting.

A 401 is not special-cased here (it's just `!res.ok`): unlike the hook POST path — where `RemoteAuthError` exists so the runner knows spooling/replay would fail identically — search/probe failures are terminal for the command anyway.

### `summary-coverage.ts`

`formatSummaryCoverage(rows)` renders `SummaryCoverageRow { ide, sessions, summaries }` rows as `ide summaries/sessions`, comma-joined. A row with `sessions > 0 && summaries === 0` is wrapped in `kleur.yellow`: that shape means the IDE records sessions but `turn_summary` never arrives — in practice a stale hand-written OpenCode bridge plugin shadowing the bundled one (OpenCode loads every file in its `plugins/` dir, WP #210). Deliberately pure — no I/O; the underlying query, including folding empty `ide` values into an `unknown` bucket, lives in `packages/storage` (`Storage.summaryCoverage`).

## Flow

`resolveCliPath()` consumers:

- `commands/install.ts` / `commands/uninstall.ts` — pass it as `ctx.cliPath` to the installer, which writes it into IDE hook/MCP config files.
- `commands/lifecycle.ts` / `commands/worker.ts` — use it as the script argument in `spawn(process.execPath, [resolveCliPath(), 'worker', 'run'], …)` for the detached daemon.
- Indirectly, `opencode-bridge.ts#resolveCavememCli()` performs the analogous discovery for the already-running bridge (sibling file → `which` → `npm root -g`), but does not use this module.

`mode.ts` / `remote.ts` consumers (remote mode):

- **Remote-aware** (`if (checkedRemoteTarget(settings))` branch): `commands/search.ts`, `commands/doctor.ts`, `commands/status.ts`, `commands/install.ts`.
- **Local-only** (`requireLocal` bail): `commands/export.ts` (`export`/`import`), `commands/lifecycle.ts` (`start`/`stop`/`restart`/`viewer`), `commands/worker.ts` (`worker start/run/stop/status`), `commands/mcp.ts`, `commands/reindex.ts`.
- Unguarded by design: `hook run` needs no mode check in this layer — `@cavemem/hooks#runHook` itself dispatches to `postHook()` when remote.

`formatSummaryCoverage()` consumers (local mode only — the remote branch of both commands returns before the DB section):

- `commands/doctor.ts` / `commands/status.ts` — feed it the rows from `Storage.summaryCoverage()` and print the result as their `summaries:` line.

## Integration

- `resolve.ts` consumers: `src/commands/{install,uninstall,lifecycle,worker}.ts` (see `../util/resolve.js` imports).
- `mode.ts`/`remote.ts` depend on `@cavemem/config` (`Settings`) and — for `remote.ts` — `@cavemem/hooks` (`remoteTarget`, `RemoteTarget`) and `@cavemem/core` (`SearchResult`). The endpoints they call are served by `apps/worker`'s Hono server (`/healthz`, `/api/state`, `/api/search`), which in remote mode runs on the central machine.
- `summary-coverage.ts` depends only on `kleur`; its input rows come from `Storage.summaryCoverage()` (`@cavemem/storage`), so the SQL-side bucketing (empty/null `ide` folded into `unknown`) lives in the storage package and this module stays a pure formatter.
- Counterpart: `src/index.ts#isMainEntry()` solves the same npm-symlink problem from the other side (comparing `import.meta.url` against the realpath of `argv[1]`).
- The `resolveCliPath()` output ends up in persisted IDE configs, so a wrong value surfaces only after install — this is one of the failure modes covered by `scripts/e2e-publish.sh` (bin-shim resolution check).
