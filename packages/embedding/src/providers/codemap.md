# packages/embedding/src/providers/

## Responsibility

The concrete `Embedder` constructors: one module per `settings.embedding.provider` value — `local.ts` (Transformers.js/ONNX on-device), `ollama.ts` (local HTTP daemon), `openai.ts` (OpenAI-compatible HTTP APIs). There is no `none` provider module: `createEmbedder` in `../index.ts` short-circuits `provider: 'none'` to `null` before this directory is reached. Every constructor returns the same contract: `{ model, dim, embed(text) → Float32Array }`, with `dim` guaranteed correct before the first real `embed()` completes (via `MODEL_DIMS` table or warm-up probe).

## Design

- **`local.ts` — `createLocalEmbedder(model, opts?)`**
  - *Musl guard first:* `detectMusl()` from `../libc.ts`; on musl it throws with remediation (set `embedding.provider` to `'none'` or `'ollama'`; run `cavemem doctor`) instead of letting onnxruntime-node's glibc prebuilts abort the process (issue #20).
  - *Lazy import:* `await import('@huggingface/transformers')` inside the function — configs and remote-provider installs never pay the ONNX load; an import failure becomes an actionable thrown error.
  - *Cache setup:* sets `transformers.env.cacheDir` (from `opts.cacheDir`) and `env.allowLocalModels = true` so cached weights load without Hub traffic.
  - *Pipeline:* `transformers.pipeline('feature-extraction', model, { dtype: 'q8' })` — `dtype: 'q8'` is the transformers-v3 replacement for the v2 `quantized: true` default (int8 weights).
  - *dim resolution:* `MODEL_DIMS` table (7 Xenova models: all-MiniLM-L6/L12-v2, bge-small-en-v1.5, gte-small at 384; all-mpnet-base-v2, bge-base-en-v1.5, gte-base at 768) or, for unlisted models, a warm-up probe `embed(' ')` whose vector length fixes `dim`. `embed` does mean-pooling + normalization, copies the tensor's `.data` into a dense `Float32Array` (storage can persist it directly), and backfills `dim` on first call if still 0. `dim` is exposed as a getter over the closed-over value.
- **`ollama.ts` — `createOllamaEmbedder(model, endpoint?, opts?)`**
  - Base URL defaults to `http://127.0.0.1:11434`, trailing slashes stripped. `embed` POSTs `{ model, prompt: text }` to `/api/embeddings` and accepts either `embedding` or `embeddings[0]`; throws on non-OK status, a JSON `error` field, or a missing embedding field. **Always runs a warm-up probe** — this both verifies endpoint reachability up front and captures `dim` (Ollama models have no dim table).
- **`openai.ts` — `createOpenAIEmbedder(model, endpoint?, apiKey?, opts?)`**
  - Throws immediately without `apiKey` (message points at `cavemem config set embedding.apiKey`). Base defaults to `https://api.openai.com/v1`; pointing `endpoint` elsewhere makes it work with Azure, Together, Groq, etc. `embed` POSTs `{ model, input: text }` to `/embeddings` with Bearer auth; error text is truncated to 200 chars. `MODEL_DIMS`: `text-embedding-3-small`/`ada-002` → 1536, `text-embedding-3-large` → 3072; warm-up probe only for models outside the table.
- **Common shape:** all three convert the numeric response into `Float32Array` element-by-element with `?? 0` guards, expose `dim` via a getter, and use `opts.log` (defaulting to a no-op or stderr in the factory) for `[cavemem:embed]` diagnostics.

## Flow

`createEmbedder` → constructor for the chosen provider → (local: musl check → lazy import → pipeline build) or (remote: base URL resolution → API key check) → `dim` fixed via `MODEL_DIMS` lookup or one probe `embed(' ')` → `Embedder` returned to the factory's caller. During normal operation, each `embed(text)` call is either an in-process ONNX inference (local) or one HTTP round-trip (ollama/openai); the result flows through `@cavemem/storage` into the vector index, where `MemoryStore.search` later filters `allEmbeddings({ model, dim })` by this embedder's identity.

## Integration

- Providers import only from within the package: `../libc.js` (local) and `../types.js` (shared `Embedder`/`EmbeddingFactoryOptions`) — no cross-provider imports, no direct `@cavemem/config` usage (settings are decomposed by the factory).
- The local provider's `@huggingface/transformers` dependency is optional at the package level (`package.json#optionalDependencies`); `apps/cli/tsup.config.ts` treats it as an optional peer when bundling the CLI, so provider=`none` builds stay light.
- Returned objects satisfy the structurally-identical `Embedder` interfaces of both `@cavemem/embedding/src/types.ts` and `@cavemem/core/src/memory-store.ts`; `MemoryStore.search` is the runtime enforcement point for the `dim` contract (mismatch → keyword-only fallback).
- Covered by `test/providers.test.ts` (constructor behavior, dim guarantees, error paths).
