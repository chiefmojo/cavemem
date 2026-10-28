---
"@chiefmojo/cavemem": minor
---

Hybrid search on the worker now runs on a background thread, so a large corpus no longer stalls hooks, the viewer and other requests while a search scans vectors, and the search itself is faster. When hybrid search p95 goes over 300 ms or searches keep failing, Claude Code shows a warning at session start (this needs the server and the client both on this version or later; local mode never shows it). `search.alpha = 1` now returns keyword hits only, with raw BM25 scores, instead of padding the result with unrelated vector-only hits.
