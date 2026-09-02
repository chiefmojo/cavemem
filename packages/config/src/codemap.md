# packages/config/src/

## Responsibility

Implementation of the settings subsystem: the zod `SettingsSchema` and its derived `Settings` type (`schema.ts`), the singleton `defaultSettings` (`defaults.ts`), load/save of `settings.json` (`loader.ts`), schema-driven self-documentation (`docs.ts`), the cavemem home / data-dir resolution order (`home.ts`), and dependency-free path-glob matching (`glob.ts`). `index.ts` re-exports the public surface.

## Design

- `schema.ts` — `SettingsSchema` is a strict zod object (`.strict()`; unknown keys reject) with a `.describe()` and `.default()` on every field: `dataDir` (default = `resolveCavememHome()`, evaluated lazily via a default factory so the default is re-resolved on every load and never persisted), `workerPort` (37777), `logLevel`, `compression.intensity` (`CompressionIntensity`: `lite|full|ultra`) and `compression.expandForModel`, `embedding` (`provider` via the `EmbeddingProvider` enum `local|ollama|openai|none`, `model` default `Xenova/all-MiniLM-L6-v2`, `endpoint`, `apiKey`, `batchSize`, `autoStart`, `idleShutdownMs` clamped `>= 0` by a `.transform`), `search.alpha` (0–1 hybrid BM25/cosine weight) and `search.defaultLimit`, `privacy.excludePatterns` + `privacy.redactSecrets`, `capture.excludeTools`/`includeTools` (exclude always wins), `enrich` (`enabled` opt-in, `maxResults` ≤ 5, `timeoutMs`), and `ides` (record set by `cavemem install`). Exports the inferred `Settings` type.
- `defaults.ts` — `defaultSettings = SettingsSchema.parse({})`: one line; defaults live only in the schema, never duplicated.
- `loader.ts` — `settingsPath(dataDir?)` joins `settings.json` under the resolved home; `loadSettings` returns `defaultSettings` when the file is missing and wraps parse failures as `Invalid settings at <path>: <zod message>`; `saveSettings` always writes to `settingsPath()` (a custom `dataDir` relocates data only, never settings.json — comment at `loader.ts:27`) and strips the `dataDir` key from the persisted JSON when it equals `resolveCavememHome()` so machine-specific absolute paths never freeze into a portable settings file. Re-exports `resolveDataDir`.
- `docs.ts` — `settingsDocs()` walks the schema's object shape recursively (`walk`/`unwrap` peel `.default`/`.optional` wrappers up to 8 levels) and emits `SettingDoc { path, type, default, description }`; `typeLabel` renders `enum: a|b|c` labels; `describeText`/`defaultValue` walk wrapper chains to find the first description / default factory.
- `glob.ts` — two wildcard operators only: whole-segment `**` (matches zero or more segments) and within-segment `*`. `patternSegments` caches normalised segments (backslashes → `/`, duplicate `**` collapsed, embedded `**` like `**.log` demoted to `*`); `segmentMatch` is the classic iterative single-star matcher; `matchSegments` applies the same backpointer technique one level up; `matchesGlob(value, patterns)` returns true on any pattern hit and false for an empty pattern list. No RegExp concatenation — documented rationale: repeated globstars must stay linear on long slash-dense inputs.
- `home.ts` — `resolveCavememHome()` (process-lifetime cached) implements the #47 order: absolute-or-tilde `CAVEMEM_HOME` → existing `~/.cavemem` → `XDG_DATA_HOME/cavemem` → Linux-only `~/.local/share/cavemem` → `~/.cavemem`. `envDir` treats non-absolute, non-`~` env values as unset (relative paths would fragment the store because hooks run with cwd = project dir). `resolveDataDir(raw)` expands a leading `~` and otherwise `resolve()`s.

## Flow

- Every process (hooks, worker, MCP server, CLI) starts with `loadSettings()`: `resolveCavememHome()` (cached) → `settingsPath()` → read + `SettingsSchema.parse` (or `defaultSettings` if absent). Writes go through `saveSettings`, which mkdirs the parent and pretty-prints JSON with a trailing newline.
- The schema default factory on `dataDir` means an unset `dataDir` in the in-memory object is always the current resolved home; on save, that key is omitted from disk.
- `settingsDocs()` is called by the CLI (`cavemem config show`) with no arguments and reflects whatever `SettingsSchema` currently contains — new fields are documented automatically.
- `matchesGlob` is a pure function used at runtime by hook handlers to test paths and tool names against settings arrays.

## Integration

- `schema.ts` imports `resolveCavememHome` from `home.ts` (internal, so the `dataDir` default tracks the resolution order); no file imports anything outside `src/`.
- `index.ts` is the only export surface (`SettingsSchema`, `Settings`, `CompressionIntensity`, `EmbeddingProvider`, `defaultSettings`, `loadSettings`, `saveSettings`, `resolveDataDir`, `settingsPath`, `settingsDocs`, `SettingDoc`, `matchesGlob`); cross-package consumers must go through it (package `exports` map points at `dist/index.js`).
- `Settings` is threaded by consumers into `MemoryStore` (compress intensity, redaction, search alpha), the worker (ports, embed batching, idle shutdown), the MCP server (progressive-disclosure / `expandForModel`), and hooks (glob filtering); `resolveDataDir` derives the `data.db` path.
