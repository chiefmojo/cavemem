---
'cavemem': patch
---

Fix OpenCode bridge hook delivery: `hookSpawnCommand` now routes `.js` CLI entrypoints through a resolved node runtime instead of spawning them raw. Raw `.js` spawns fail with EFTYPE on win32 (no exec handler for `.js`), and `process.execPath` cannot be used as a fallback because inside IDE-embedded runtimes (e.g. opencode's compiled Bun binary) it is the IDE executable, which would launch the IDE recursively. Bin shims stay untouched. `.js` entrypoints now resolve an absolute node runtime via a chain — `process.execPath` when it is actually node → the installer-written absolute node binary in `~/.config/opencode/opencode.json` (`mcp.cavemem.command[0]`, honoring `XDG_CONFIG_HOME`) → a PATH scan — and when no runtime is found the bridge disables capture with a visible system-prompt warning (instead of silently dropping hooks) until a runtime is available again.
