---
'cavemem': patch
---

Fix OpenCode bridge hook delivery on Windows: `hookSpawnCommand` now routes `.js` CLI entrypoints through the running JS runtime instead of spawning them raw, which fails with EFTYPE on win32 (no exec handler for `.js`). Matches the pattern already used by `worker`/`lifecycle` commands.
