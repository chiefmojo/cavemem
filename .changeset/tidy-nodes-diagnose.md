---
"@chiefmojo/cavemem": patch
"@cavemem/installers": patch
---

Persist stable PATH links to the running Node interpreter in IDE integrations. Add read-only installer diagnostics to doctor for missing or Homebrew-version-pinned Node paths, with an IDE-specific reinstall command.

Preserve user hooks and metadata in mixed Cavemem hook groups during reinstall and uninstall. Reject Windows PATH entries whose root depends on the working drive.

Recognize owned hooks by their Node launch tokens, event, and IDE marker instead of substring matches, preserving unrelated commands that quote hook text. Diagnose interpreter paths containing escaped double quotes without corrupting Windows backslashes.

Clean up legacy direct-JavaScript Cavemem hook commands during reinstall and uninstall. Recover a stable Homebrew prefix symlink even when its bin directory is absent from the install process PATH. Treat version-pinned interpreters as advisory while retaining a failing diagnosis for missing interpreters.

Report a fresh, absent database as having no captured sessions, and give an actionable `cavemem reindex` remedy for an existing database with an outdated schema.
