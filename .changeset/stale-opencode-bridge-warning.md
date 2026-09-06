---
"cavemem": patch
"@cavemem/hooks": patch
"@cavemem/installers": patch
"@cavemem/storage": patch
---

Fix silent loss of turn summaries caused by a stale OpenCode bridge plugin. OpenCode loads every file in `~/.config/opencode/plugins/`, so a hand-written bridge plugin (anything other than our `cavemem.js` symlink) runs alongside the bundled one and — being older — drops `turn_summary`, silently disabling turn summaries for OpenCode. `cavemem install` now detects these foreign bridges in the plugins dir and warns (never deletes: non-interactive CLI); the Stop hook logs a `dropped: missing-summary` JSON line to stderr when `logLevel` is `debug` so the gap is diagnosable; and `cavemem doctor` / `cavemem status` print per-IDE turn-summary coverage (`ide summaries/sessions`), highlighting IDEs that record sessions but never summaries.
