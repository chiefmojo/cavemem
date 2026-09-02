# packages/installers/

## Responsibility

`@cavemem/installers` owns per-IDE integration: nine modules that write cavemem's hook registrations and MCP server entries into each IDE's config files, behind a uniform `Installer` contract (`detect` / `install` / `uninstall` plus metadata). It is consumed by `apps/cli`'s `install` / `uninstall` / `status` / `doctor` commands and never captures memory itself — its output is config files whose hook commands invoke `cavemem hook run <id>` at runtime, which lands in `@cavemem/hooks`. The package is `private: true` (not published).

## Design

- **`Installer` interface** (`src/types.ts`): `id`, `label`, `capture: CaptureLevel` (`'full' | 'partial' | 'none'`), optional `captureNotes`, and async `detect(ctx)` / `install(ctx)` / `uninstall(ctx)` returning `string[]` of human-readable messages. `CaptureLevel` exists (issue #58) so `cavemem status` and the README capability matrix can tell users when an IDE records nothing (e.g. Gemini CLI is MCP-query-only).
- **`InstallContext`** carries `{ ideConfigDir, cliPath, nodeBin, dataDir }`. `nodeBin` is explicit because IDE configs must spawn `nodeBin cliPath …`, not `cliPath …` — spawning a raw `.js` fails with EFTYPE on Windows (no associated exec handler).
- **`registry.ts`** maps `IdeName` → module in a single `installers` record (claude-code, gemini-cli, opencode, codex, cursor, copilot, augment, antigravity, bob); `getInstaller(name)` throws with the known-IDE list on unknown names. `index.ts` exports the registry plus the `windows-sh` helpers and types — the package's entire public surface.
- **Shared structural pattern across per-IDE modules**: private `*File(ctx)` path helpers → `detect` is an `existsSync` on the IDE's config dir → `install` reads current config with a fallback default, strips prior cavemem entries for idempotent re-install (an `isCavememHook*` helper matching the `hook run <id>` substring, or Augment's wrapper-dir prefix), appends fresh entries, `deepMerge`s to preserve user keys, writes via `writeJson` → `uninstall` removes only cavemem entries, deletes emptied keys, and reports. Non-cavemem user content is preserved verbatim everywhere; several modules also clean up *legacy* locations written by earlier installer versions (codex `config.json`, opencode `~/.opencode/config.json` + stale `mcpServers` key, claude-code `settings.mcpServers`).
- **`fs-utils.ts`** provides the shared primitives: `readJson` (fallback on missing file or parse error), `writeJson` (`mkdirSync -p`, 2-space indent, trailing newline), `shellQuote` (bare-token whitelist; backslashes are *excluded* from the whitelist because MSYS-bash — Claude Code's shell on Windows — strips unquoted backslashes, while double quotes preserve them under both cmd.exe and sh), and recursive `deepMerge` (plain objects merged, arrays and everything else replaced).
- **`windows-sh.ts`** handles Claude Code's Windows failure mode (issue #56): hook `command` strings run through `sh -c` even on win32, so a missing `sh` means every hook fails non-blocking and capture silently stops while `doctor`/`status` look healthy. `checkWindowsSh` (platform and `resolveSh` injectable for tests/CI) returns `WINDOWS_SH_MISSING_WARNING` — plain text, so callers can colorize and tests assert substrings — or `null` when `sh` resolves (`resolveShDefault` spawns `sh -c "exit 0"`) or the platform isn't win32.
- **Only external runtime dependency**: `smol-toml` (codex's `config.toml` round-trip); everything else is `node:fs`/`node:path`/`node:child_process` plus `@cavemem/config`.

## Flow

CLI `install` → build `InstallContext` → `getInstaller(name)` → `detect` → `install` → messages printed. Install artifacts:

1. **Hook registrations** — entries shaped like `{ command: "<nodeBin> <cliPath> hook run <id> --ide <ide>" }` in the IDE's hook config (quoted via `shellQuote` where the target is a shell command string, since Windows npm paths can contain spaces).
2. **MCP registration** — `mcpServers.cavemem = { command: nodeBin, args: [cliPath, 'mcp'] }` (shape varies: `mcp` array-form for OpenCode, `servers` + `type: 'stdio'` for VS Code/Copilot, `[features] codex_hooks = true` + `mcp_servers` TOML for Codex).
3. At runtime the IDE fires the registered command → `cavemem hook run` → `@cavemem/hooks#runHook`.

## Integration

- Depends on `@cavemem/config` (below it in the package order) and `smol-toml`; nothing else.
- Consumed exclusively by `apps/cli` (`install`, `uninstall`, `status`, `doctor` — including `checkWindowsSh` for the Windows health check).
- Capture coverage per IDE: **full** — claude-code, codex (`no SessionEnd event`), copilot (`no SessionEnd event`, payloads deliberately Claude-Code-compatible), augment (`no UserPromptSubmit event`), opencode (`via bundled bridge plugin, not hooks.json`); **none (MCP query only)** — gemini-cli, cursor, antigravity, bob (both installers emit an explicit query-only WARNING message).
- Tests: `test/installers.test.ts` (vitest) exercises install/uninstall against temp `ideConfigDir`s.
