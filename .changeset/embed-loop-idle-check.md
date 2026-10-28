---
"@chiefmojo/cavemem": patch
---

The worker no longer re-reads every stored embedding every two seconds while idle, which used to stall other requests (hooks, the viewer, searches) for a few hundred milliseconds on large stores.
