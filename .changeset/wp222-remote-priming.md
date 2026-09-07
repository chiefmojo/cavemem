---
'cavemem': patch
'@cavemem/worker': patch
'@cavemem/hooks': patch
'@cavemem/storage': patch
---

Fix WP #222: OpenCode remote-mode priming fetches prior-session context from the worker (`GET /api/context`) instead of the empty client-local store. Adds the shared `buildPriorContext` builder (also now backing `sessionStart`); the bridge error log moved to `os.tmpdir()` so it works on Windows. PR #7 review fixes: remote priming prefers session-scope summaries (any-scope fallback, matching bridge-local selection), and `listSummaries` breaks same-ms ts ties newest-inserted-first.
