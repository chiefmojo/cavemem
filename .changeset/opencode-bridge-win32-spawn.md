---
'cavemem': patch
---

Fix OpenCode bridge hook delivery: `.js` CLI entrypoints now resolve an absolute Node runtime instead of being spawned raw or through a guessed `node`. Raw `.js` spawns fail with EFTYPE on win32, and `process.execPath` cannot be used as a fallback inside IDE-embedded runtimes (e.g. opencode's compiled Bun binary) because it is the IDE executable. Resolution order: `process.execPath` when it is actually node → the absolute node the installer records (a new `cavemem-bridge.json` sidecar written in both local and remote mode, plus the legacy local MCP `command[0]`) → a PATH scan. When no runtime is found the bridge disables capture with a visible system-prompt warning instead of silently dropping hooks; only node-runtime launch failures (`ENOENT`/`ENOEXEC`/`EFTYPE`) disable capture, while transient and CLI errors log and retry. The bridge error log now lives under the OS temp dir so it works on Windows.
