---
"@chiefmojo/cavemem": patch
---

Fix MCP `search` failing with `Maximum call stack size exceeded` once the corpus passes about 125k embedded observations. The hybrid ranker took the min and max of every cosine score with `Math.min(...xs)`, which throws past the engine's argument limit; it now uses a loop. Keyword-only search (CLI, `/api/search`) was unaffected.
