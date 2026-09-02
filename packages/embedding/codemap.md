# packages/embedding/

## Responsibility

`@cavemem/embedding` turns `Settings` into a working `Embedder` (or `null`): it is the provider factory layer for the semantic-search side of cavemem. It wraps the local Transformers.js/ONNX runtime plus opt-in remote providers (Ollama, OpenAI-compatible) behind one uniform contract — `{ model, dim, embed(text) → Float32Array }` — and guards platform failure modes (musl libc) before they can crash the process. It does no database access and no compression; it only produces vectors.

## Design

- **Single factory.** `createEmbedder(settings, opts?)` in `src/index.ts` switches on `settings.embedding.provider`: `'none'` → `null` (BM25-only search), `'local'`/`'ollama'`/`'openai'` → the matching provider constructor in `src/providers/`. The `default` branch uses a `_never: never` exhaustiveness check so adding a provider to the config schema without wiring it here fails immediately (at runtime and in tests).
- **Honest `dim` before first use.** Each provider knows its vector dimensionality before any real `embed()` completes: from a `MODEL_DIMS` table (local, openai) or from a warm-up probe embedding (`ollama` always probes; local/openai probe only for unlisted models). `dim` is exposed via a getter; `MemoryStore.search` double-checks the returned vector length and degrades to keyword-only if a provider lies.
- **Sibling typing.** `Embedder` is re-declared in `src/types.ts`, structurally identical to the one in `@cavemem/core` — kept in sync manually, with a comment noting that drift breaks `MemoryStore.search` compilation. This is what lets `embedding` and `core` be siblings (neither imports the other) while remaining type-compatible.
- **Lazy, optional heavyweight dep.** `@huggingface/transformers` is an `optionalDependencies` entry and is only `await import(...)`ed inside the local provider — installs using `provider: 'none'` or a remote provider never load ONNX. The import failure is converted into an actionable error telling the user to install it or switch providers.
- **Clean failure over segfault.** `src/libc.ts#detectMusl` detects musl (Alpine / musl-built Node) before onnxruntime-node loads, because its glibc prebuilts have segfaulted there (issue #20); `createLocalEmbedder` throws a descriptive error pointing at `cavemem doctor` and the `'none'`/`'ollama'` alternatives instead.
- **Expensive construction, cheap reuse.** The factory is async because model loading costs ~400–800 ms; callers are expected to cache the resulting `Embedder` per process (worker, mcp-server, cli all do).

## Flow

`settings.embedding.provider` → `createEmbedder` switch → provider constructor (`model`, `settings.embedding.endpoint`, optionally `apiKey`, plus `EmbeddingFactoryOptions { cacheDir?, log? }`) → optional musl guard (local only) → lazy import / endpoint resolution → pipeline or HTTP client built → `MODEL_DIMS` lookup or warm-up probe `embed(' ')` fixes `dim` → `Embedder` object returned. From then on every `embed(text)` call returns a normalized `Float32Array` suitable for direct persistence by `@cavemem/storage`.

## Integration

- **Depends on** `@cavemem/config` only (`Settings`, `resolveDataDir`) — sibling to `@cavemem/core`, below `packages/hooks`/`installers` in the dependency order; `@huggingface/transformers` is an optional dependency.
- **Consumed by:** `apps/worker/src/server.ts` (constructs the embedder once, feeds the backfill loop in `embed-loop.ts`), `apps/mcp-server/src/server.ts`, and `apps/cli/src/commands/search.ts` — each caches it per process and passes it into `MemoryStore.search(query, limit, embedder)`.
- **Defaults matter:** cache dir defaults to `<resolveDataDir(settings.dataDir)>/models`; the factory's default logger writes to `process.stderr` (`[cavemem:embed] …` lines); local is the default provider but requires no network after the model is cached (`allowLocalModels = true`), honoring the "local by default, remote opt-in" rule.
- Tests in `test/providers.test.ts` and `test/libc.test.ts`; built by tsup (`tsup.config.ts`) to `dist/index.js` with `.d.ts`.
