---
"@chiefmojo/cavemem": patch
"@cavemem/installers": patch
---

Load the OpenCode bridge under OpenCode 2. The bridge now exports one `{ id, setup, server }` plugin definition: `setup` uses the V2 event stream and `session`/`tool` hooks; `server` keeps OpenCode 1.18.29 and later working. Capture and context injection behave as before. `cavemem install --ide opencode` stops adding the bridge to `plugin` in `opencode.json`, and removes earlier entries that OpenCode 2 rejects or ignores. Both hosts load the bridge from the `plugins/` symlink.
