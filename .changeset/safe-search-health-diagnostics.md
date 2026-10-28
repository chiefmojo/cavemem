---
"@chiefmojo/cavemem": patch
"@cavemem/compress": patch
---

Redact private content and credentials from retained search-health diagnostics before truncating them, protecting structured logs and session-start warnings. Diagnostics also catch credentials in quoted JSON fields (`"api_key": "…"`), as provider error bodies carry them; redaction of stored observations is unchanged. Keep scan-thread and malformed-embedding test fixtures compatible with Node 20.
