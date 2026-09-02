# evals/src/

## Responsibility

`bench.ts` — the entire executable surface of the evals package: a standalone token-savings benchmark that runs the compressor over the fixed corpus and reports per-file and total savings.

## Design

- Script, not library: no exports, no CLI flag parsing; it derives the corpus location from `import.meta.dirname` (`../corpus`) and lists `*.md` with `readdirSync`, so adding a corpus file extends the benchmark with zero code changes.
- Uses the compressor's own `countTokens` for both sides of the comparison, and `compress(text, { intensity: 'full' })` matching the production default — the numbers are apples-to-apples with what the write path actually produces.
- Output is a fixed-width table built with a tiny local `pad()` helper and written with `process.stdout.write` (one write, no logging deps).

## Flow

1. Enumerate `corpus/*.md`.
2. Per file: `before = countTokens(text)`; `afterFull = countTokens(compress(text, { intensity: 'full' }))`; accumulate totals; compute `saved% = (before - after) / before`.
3. Print the per-file rows and a `TOTAL before=… after=… saved=…%` summary line.

## Integration

- Imports only `compress` and `countTokens` from `@cavemem/compress` (workspace dependency, the sole runtime dep in `package.json`); executed as `node --import tsx src/bench.ts` via the package's `bench` script.
- Companion gates it complements: round-trip/technical-token correctness is enforced by `packages/compress` tests; this script is the quantitative check the playbook requires after lexicon/tokenizer changes.
