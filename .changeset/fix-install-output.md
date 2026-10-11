---
"@chiefmojo/cavemem": patch
---

Fix install and doctor output. `cavemem install --ide opencode` no longer prints a false "could not read effective configuration" warning on OpenCode 2: it now reads the source list from `opencode debug config` (OpenCode 2 has no `--pure`) and checks the last source that defines `mcp.cavemem`, naming the overriding source when it differs. Install warnings are shown as warnings instead of with a green check mark. A remote-mode install no longer says local embedding weights will download, since the client never embeds. `cavemem doctor` no longer leaves a trailing space after `server: ok`, and shows a failure detail on the line of the check that failed.
