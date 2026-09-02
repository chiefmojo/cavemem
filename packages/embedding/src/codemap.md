# packages/embedding/src/

## Responsibility

Implementation root of `@cavemem/embedding`: the `createEmbedder` factory (`index.ts`), the shared type contracts (`types.ts`), and the musl-libc detection probe (`libc.ts`). Provider implementations live one level down in `src/providers/`.

## Design

- **`index.ts`** — `createEmbedder(settings, opts?: EmbeddingFactoryOptions): Promise<Embedder | null>`. Returns `null` for `provider: 'none'` (degraded, keyword-only search — not an error). Defaults filled here: `log` falls back to writing `[cavemem:embed]` lines to `process.stderr`; `cacheDir` falls back to `join(resolveDataDir(settings.dataDir), 'models')`. The `switch` passes `settings.embedding.model`, `settings.embedding.endpoint`, and `settings.embedding.apiKey` to the provider constructors; its `default` branch assigns the provider to a `_never: never` and throws — a runtime exhaustiveness check so an unwired schema enum value can't silently return nothing.
- **`types.ts`** — `Embedder { readonly model: string; readonly dim: number; embed(text: string): Promise<Float32Array> }` and `EmbeddingFactoryOptions { cacheDir?; log? }`. The `Embedder` interface is deliberately re-declared here instead of imported from `@cavemem/core`: consumers of this package shouldn't need a core dependency, and the sibling rule forbids either direction. The two declarations are manually synced; a drift would surface as a compile error in `MemoryStore.search`, which accepts the core-side type.
- **`libc.ts`** — `detectMusl(io?: LibcProbeIO): LibcProbeResult { isMusl, reason? }`, with all environment access injectable via `LibcProbeIO` (`platform`, `getReport`, `readFile`, `exists`) for deterministic tests. Three-stage Linux-only detection: (1) `process.report.getReport()` — a report *without* `header.glibcVersionRuntime` means musl-built Node; (2) `/etc/os-release` matching `/^ID(_LIKE)?=.*alpine/im`; (3) existence of `/lib/ld-musl-x86_64.so.1` or `/lib/ld-musl-aarch64.so.1`. Non-Linux platforms short-circuit to `{ isMusl: false }`. Every probe is wrapped/fallback-guarded so an unavailable `process.report` or unreadable file just falls through to the next stage.

## Flow

Factory flow: `Settings` → provider switch in `index.ts` → `createLocalEmbedder` / `createOllamaEmbedder` / `createOpenAIEmbedder` (see `providers/` codemap) → provider performs optional musl guard, lazy import, and `dim` warm-up → returns `Embedder`. `libc.ts` is invoked only by the local provider, before the ONNX runtime is touched, converting what would be a segfault (issue #20: glibc-targeted onnxruntime-node prebuilts on musl) into a thrown, remediation-bearing error.

## Integration

- `index.ts` imports `resolveDataDir` from `@cavemem/config` — the only package dependency; settings access never bypasses config per the playbook.
- Exports (via `../index.ts` barrel / `package.json#exports` `.`): `createEmbedder`, and re-exported types `Embedder`, `EmbeddingFactoryOptions`.
- `libc.ts` is internal to the package (not in the public barrel); its tests in `test/libc.test.ts` exercise the injected-IO path.
- Produced `Embedder` objects flow to `apps/worker`, `apps/mcp-server`, and `apps/cli` and are handed to `MemoryStore.search`, which verifies `qvec.length === embedder.dim` at query time as a final contract check.
