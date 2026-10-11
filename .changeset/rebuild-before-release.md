---
"@chiefmojo/cavemem": patch
---

Rebuild before publishing. 0.4.4 shipped the stale 0.4.3 `dist` (version reported as 0.4.3, OpenCode bridge missing its V2 `{ id, setup }` definition) because `pnpm release` ran `changeset publish` without a build. `pnpm release` now runs `pnpm build` first, and `prepublishOnly` refuses a `dist` whose `--version` doesn't match `package.json` or whose OpenCode bridge isn't the `{ id, setup, server }` plugin.
