---
"@cavemem/installers": patch
"@chiefmojo/cavemem": patch
---

Codex install on native Windows (WP #231): write the canonical `[features].hooks` key instead of the deprecated `codex_hooks` alias (removes the startup deprecation warning); emit a `commandWindows` override on win32 so native-Windows hooks stop failing with exit code 1; and write the remote bearer as a static `http_headers` Authorization header (matching Claude Code / OpenCode) instead of an out-of-band `CAVEMEM_REMOTE_TOKEN` env var. `cavemem doctor` flags a stdio-vs-remote `mcp_servers.cavemem` mismatch, and the installer warns when the Codex config indicates it runs under WSL (Windows paths won't resolve there).