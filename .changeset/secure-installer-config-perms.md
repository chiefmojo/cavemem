---
"@cavemem/installers": patch
---

Secure installer config writes (WP #233): every config file the installers write (Claude Code `settings.json`/`~/.claude.json`, OpenCode `opencode.json`, Codex `config.toml`/`hooks.json`, and the remaining `writeJson` call sites) can carry the remote bearer token and is now written owner-only (0o600) into directories created at 0o700; a re-install also tightens a pre-existing world-readable config back to 0o600. The Claude Code `.pre-cavemem-*` settings backup is likewise chmod'd 0o600.
