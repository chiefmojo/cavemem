# evals/

## Responsibility

The measurement harness for the compressor (`@cavemem/evals`, private, never published). It quantifies how many tokens the caveman grammar saves on representative prose, using the same `countTokens`/`compress` functions the production write path uses. Per the agent playbook, new compression rules (lexicon changes) must be re-measured here.

## Design

- **Fixed corpus**: `corpus/*.md` — `commit-message.md`, `readme-excerpt.md`, `review-comment.md`, `stack-trace-note.md` — small real-world-style prose samples chosen to exercise both compressible natural language and the technical-token preservation rules (paths, code, stack traces) that must survive compression byte-for-byte.
- **No framework**: a single script (`src/bench.ts`) run via `pnpm bench` → `node --import tsx src/bench.ts` (tsx dev-dependency, so no build step). The package has exactly one runtime dependency: `@cavemem/compress`.
- Measurement is done at `intensity: 'full'` (the settings default) so numbers reflect real-world operation, and token counting uses the compressor's own `countTokens` — the same authority the savings claims are made against.

## Flow

`bench.ts` reads every `.md` in `corpus/`, computes per-file `countTokens(text)` (before) vs `countTokens(compress(text, { intensity: 'full' }))` (after), and prints a padded table (`file / before / after / saved%`) plus a TOTAL line with the aggregate saved percentage to stdout. Exit code is 0 regardless of the numbers — it is a reporting tool; pass/fail gates live in the round-trip test suite of `@cavemem/compress`.

## Integration

- Consumes only the public `@cavemem/compress` API (`compress`, `countTokens`); no storage, config, or app dependencies — it can never drift into DB or settings concerns.
- Workflow position: after editing `packages/compress/src/lexicon.json` or the tokenizer, run the compress round-trip tests (`pnpm --filter @cavemem/compress test`) and then this benchmark to check the savings impact before committing to a lexicon change.
- `test` script is `vitest run --passWithNoTests` (the package currently ships no tests of its own; correctness gates live in the compress package).
