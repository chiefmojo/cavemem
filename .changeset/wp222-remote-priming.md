---
'cavemem': patch
'@cavemem/worker': patch
'@cavemem/hooks': patch
---

Fix WP #222: OpenCode remote-mode priming fetches prior-session context from the worker (`GET /api/context`) instead of the empty client-local store. Adds the shared `buildPriorContext` builder (also now backing `sessionStart`); the bridge error log moved to `os.tmpdir()` so it works on Windows.
