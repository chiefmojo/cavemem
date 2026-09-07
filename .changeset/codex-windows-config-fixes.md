---
"@cavemem/installers": patch
"@chiefmojo/cavemem": patch
---

Codex install on native Windows (WP #231): write the canonical `[features].hooks` key instead of the deprecated `codex_hooks` alias (removes the startup deprecation warning); emit a `commandWindows` override beside each hook `command` so native-Windows hooks stop failing with exit code 1; and make the remote-mode bearer-token hint platform-aware (`setx` on Windows, `export` elsewhere). Persist `CAVEMEM_REMOTE_TOKEN` into the Windows user environment on remote Codex install, have `cavemem doctor` re-sync it when it drifts from `remote.token`, flag a stdio-vs-remote `mcp_servers.cavemem` mismatch, and warn when the Codex config indicates it runs under WSL (Windows paths won't resolve there).