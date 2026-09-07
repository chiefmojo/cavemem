---
'cavemem': patch
---

Add `cavemem config unset <key>`: removes a setting, reverting it to its schema default — optional keys like `remote.url` are dropped from settings.json entirely, giving remote mode a sanctioned client rollback path (WP #219).
