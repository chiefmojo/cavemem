# examples/

## Responsibility
Reference configuration sample. Documents the user-facing `settings.json` shape with sensible defaults.

## Design
A single `settings.example.json` illustrating every settings group: `dataDir`, `workerPort`, `logLevel`, `compression` (intensity + `expandForModel`), `embedding` (provider + model), `search` (alpha + defaultLimit), `privacy` (excludePatterns + redactSecrets), and `ides` (per-IDE enable flags).

## Flow
No runtime flow — the file is a static template copied or referenced by users when configuring cavemem.

## Integration
- Mirrors the schema defined in `packages/config/src/schema.ts` (the single authority for settings shape).
- New settings fields are added there, not here; this example is updated to match.
