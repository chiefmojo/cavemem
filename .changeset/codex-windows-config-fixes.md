---
"@cavemem/installers": patch
---

Codex installer: write the canonical `[features].hooks` key instead of the deprecated `codex_hooks` alias (removes the startup deprecation warning), emit a `commandWindows` override beside each hook `command` so native-Windows hooks stop failing with exit code 1, and print a Windows-aware `setx` remote-token hint instead of a POSIX `export` when installing for Codex in remote mode.