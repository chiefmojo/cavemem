---
"@chiefmojo/cavemem": patch
---

A remote-mode `cavemem install` no longer ends with the hint `cavemem status  show wiring + embedding backfill`. Remote `status` reports the server connection, not embedding backfill (embedding runs on the server), so the hint now says `show wiring + server connection`. Local-mode installs keep the original wording.
