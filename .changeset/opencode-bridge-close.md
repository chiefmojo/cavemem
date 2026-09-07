---
"@chiefmojo/cavemem": patch
---

Expose a `close()` on the OpenCode bridge hooks so the local SQLite store can release its file handle; fixes the `opencode-bridge` test EPERM on Windows temp-dir cleanup (WP #232).
