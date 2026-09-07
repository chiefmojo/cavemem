---
'cavemem': patch
---

Fix OpenCode bridge hook delivery: `hookSpawnCommand` now routes `.js` CLI entrypoints through a resolved node runtime instead of spawning them raw. Raw `.js` spawns fail with EFTYPE on win32 (no exec handler for `.js`), and `process.execPath` cannot be used as a fallback because inside IDE-embedded runtimes (e.g. opencode's compiled Bun binary) it is the IDE executable, which would launch the IDE recursively. Bin shims stay untouched.
