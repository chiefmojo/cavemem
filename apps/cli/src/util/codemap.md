# apps/cli/src/util/

Shared CLI helpers.

## Responsibility

Currently a single module: `resolve.ts#resolveCliPath()` — resolves the absolute path to the running `cavemem` CLI binary.

## Design

`resolveCliPath()` returns `realpathSync(process.argv[1])`. The realpath step is essential: npm installs the bin as a **symlink** (`bin-shim`), and IDE config files must reference the real script location, not the symlink (which may be recreated/unstable across npm operations). If `argv[1]` is missing or cannot be realpathed, it degrades to `'cavemem'` (PATH lookup) or the raw `argv[1]` respectively. Deliberately dependency-free — pure `node:fs`.

## Flow

Every command that records or spawns the CLI calls it:
- `commands/install.ts` / `commands/uninstall.ts` — pass it as `ctx.cliPath` to the installer, which writes it into IDE hook/MCP config files.
- `commands/lifecycle.ts` / `commands/worker.ts` — use it as the script argument in `spawn(process.execPath, [resolveCliPath(), 'worker', 'run'], …)` for the detached daemon.
- Indirectly, `opencode-bridge.ts#resolveCavememCli()` performs the analogous discovery for the already-running bridge (sibling file → `which` → `npm root -g`), but does not use this module.

## Integration

- Consumers: `src/commands/{install,uninstall,lifecycle,worker}.ts` (see `../util/resolve.js` imports).
- Counterpart: `src/index.ts#isMainEntry()` solves the same npm-symlink problem from the other side (comparing `import.meta.url` against the realpath of `argv[1]`).
- The path it produces ends up in persisted IDE configs, so a wrong value surfaces only after install — this is one of the failure modes covered by `scripts/e2e-publish.sh` (bin-shim resolution check).
