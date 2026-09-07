---
'cavemem': patch
'@cavemem/installers': patch
---

Fix the Codex installer's hook command strings so Windows install paths are shell-quoted. Codex executes each hook `command` through a shell (`cmd /C` on Windows, `sh -lc` on Unix), but the installer emitted `nodeBin` and `cliPath` raw — so a default Windows Node install path (`C:\Program Files\nodejs\node.exe`) would split on the space, and unquoted backslashes could be lost. The Codex installer now shell-quotes both paths the same way the claude-code and copilot installers already do.
