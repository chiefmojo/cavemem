---
"@chiefmojo/cavemem": patch
"@cavemem/installers": patch
---

Persist stable PATH links to the running Node interpreter in IDE integrations. Add read-only installer diagnostics to doctor for missing or Homebrew-version-pinned Node paths, with an IDE-specific reinstall command.

Preserve user hooks and metadata in mixed Cavemem hook groups during reinstall and uninstall. Reject Windows PATH entries whose root depends on the working drive.
