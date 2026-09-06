---
'@cavemem/storage': patch
'@cavemem/hooks': patch
'cavemem': patch
---

fix(hooks,storage): session-start recency window is per-project again (WP #209)

`session-start` fetched the 20 most recent sessions **machine-wide** and
then filtered by `cwd` in JS, so 20+ sessions from any other project or IDE
evicted the current project from the window and the hook silently injected
nothing — the widened window that shipped for #39 only delays this for any
fixed N. The `cwd` filter is now pushed into SQL via
`Storage.listSessions(limit, { cwd })`, making the window per-project.
Additionally, the 3-hint cap previously ran **before** summary-less
candidates were dropped, so three bare sessions could crowd out an older
summarized one; summary-less candidates are now skipped before the cap.
