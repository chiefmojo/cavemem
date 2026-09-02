# packages/config/

## Responsibility

`@cavemem/config` is the single authority for cavemem's settings: its zod schema (`SettingsSchema` in `src/schema.ts`), defaults, load/save of `settings.json` (`src/loader.ts`), self-documentation of every setting (`src/docs.ts#settingsDocs`), home/data-directory resolution (`src/home.ts`), and path-glob matching used by privacy and capture filters (`src/glob.ts`). No other package may read `~/.cavemem/settings.json` directly — all settings access must go through this package.

## Design

- Zero internal dependencies (bottom of the package order `config → compress → storage → {core, embedding} → hooks → installers`); its only runtime dependency is `zod` (^3.23.8, see `package.json#dependencies`).
- `SettingsSchema` is a strict zod object; every field carries a `.describe()` string and a `.default()`. Adding a new field there automatically makes it appear in `cavemem config show` and `settingsDocs()` — no parallel docs to maintain.
- `docs.ts#settingsDocs()` is reflection over the schema (`walk`/`unwrap`/`typeLabel`), producing flat `SettingDoc[]` rows with dotted paths, type labels, serialised defaults and description text.
- `glob.ts` is a hand-rolled, dependency-free matcher: iterative two-pointer scans at both the character level (`segmentMatch`) and the segment level (`matchSegments`) so repeated `**` stays linear instead of combinatorial regex backtracking; patterns are cached (`patternCache`).
- `home.ts#resolveCavememHome()` is cached for process lifetime (`cachedHome`) and uses only `existsSync` checks — it is called on the hook hot path and must stay fast.
- ESM only (`"type": "module"`), built with tsup, single public export surface (`exports: { "." }`).

## Flow

- Load: `loadSettings(path?)` → `settingsPath()` → `resolveDataDir(resolveCavememHome())` + `settings.json` → `SettingsSchema.parse(raw)`; missing file returns `defaultSettings` (`SettingsSchema.parse({})`); parse errors are re-thrown as `Invalid settings at <path>: ...`.
- Save: `saveSettings(settings, path?)` always writes to the resolved cavemem home (never next to a custom `dataDir`, which would orphan the file), and omits the `dataDir` key when it equals the resolved default so the persisted file stays portable — the default is re-resolved on every load.
- Home resolution order: `CAVEMEM_HOME` (absolute or `~` only) → existing `~/.cavemem` → `XDG_DATA_HOME/cavemem` → Linux XDG default `~/.local/share/cavemem` → `~/.cavemem` fallback. `resolveDataDir` additionally expands a leading `~`.
- Docs: `settingsDocs()` → `walk(SettingsSchema)` → flattened leaf fields.
- Glob: `matchesGlob(value, patterns)` → segment split (backslashes normalised to `/`) → `matchSegments` against cached `patternSegments(pattern)`.

## Integration

- Consumed from below by every consumer that needs settings or paths: `apps/cli` (`commands/config.ts`, `search.ts`, `worker.ts`, `doctor.ts`, `install.ts`, `export.ts`, `reindex.ts`, `uninstall.ts`, `compress.ts`, `lifecycle.ts`, `opencode-bridge.ts`, `status.ts`), `apps/worker` (`server.ts`, `embed-loop.ts`, `security.ts`), `apps/mcp-server` (`server.ts`), `packages/core` (`memory-store.ts`), `packages/hooks` (`runner.ts`, `auto-spawn.ts`, `handlers/post-tool-use.ts` — uses `matchesGlob` for `capture.excludeTools`/`includeTools` and `privacy.excludePatterns` enforcement), and `packages/embedding` (`src/index.ts`, provider selection from `EmbeddingProvider`).
- `settingsDocs()` feeds `cavemem config show` and in-terminal help.
- `Storage` (`@cavemem/storage`) also depends on this package for the data-dir resolution used to locate `data.db`.
