# Running and updating a real local install

This is for the machine where you *use* cavemem as your actual memory layer (a
real `~/.cavemem/data.db`, real agent sessions) — as opposed to hacking on the
code. If you just want a dev build that tracks the working tree, use the
`pnpm link --global` flow in `development.md` instead.

## Toolchain

Three tools do the work. Building needs all three; installing a prebuilt
tarball needs only `node` + `npm`.

| Tool | On wintermute | What it is |
|------|---------------|------------|
| `node` | `/usr/bin/node` (system package, v22) | the JavaScript runtime everything runs on |
| `npm` | ships inside Node | installs packages; used here for the global tarball install |
| `pnpm` | `~/.local/bin/pnpm` — a two-line shim | the workspace/monorepo package manager; only needed to *build* |

`pnpm` is **not really installed** on wintermute. `~/.local/bin/pnpm` is a
hand-written shim:

```sh
#!/bin/sh
exec npx -y pnpm@9 "$@"
```

Every `pnpm …` call is `npx` fetching and running `pnpm@9` (npm caches it after
the first run). The `"packageManager": "pnpm@9.x"` line in `package.json` is
bypassed by this — the shim always takes `@9` latest.

On a fresh box, recreate it before the first build:

```sh
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec npx -y pnpm@9 "$@"\n' > ~/.local/bin/pnpm
chmod +x ~/.local/bin/pnpm
```

(`corepack enable pnpm` or `npm i -g pnpm@9` work too — the shim is just what
this machine happens to use.)

The **server box does not need `pnpm` at all** — the tarball is built here and
copied over; neuromancer only runs `npm install -g` (see `deploy/README.md`).

## The npm background, in plain terms

**The published `cavemem` on the npm registry is not ours.** `npm install -g
cavemem` pulls `JuliusBrussee/cavemem`'s last public release — `0.2.1`, frozen
August 2026, no remote mode, none of our fixes. We never install from the
registry.

**We build our own copy from this repo's `main`.** The build
(`tsup`) inlines every `@cavemem/*` workspace package into a single
`apps/cli/dist/index.js`. Only the real third-party libraries (`commander`,
`better-sqlite3`, `hono`, the MCP SDK, and the optional local-embedding library)
stay as normal dependencies. That is what "self-contained package" means: the
bundle carries all of our code and only needs npm to fetch a short list of
outside libraries. (History: commit `d69850c`.)

**A "tarball" (`.tgz`) is just that bundle zipped up** with a small
`package.json` listing those third-party deps. `npm install -g <file>.tgz`:

1. unpacks it into a global `node_modules` directory,
2. runs `npm install` there for the third-party deps,
3. drops a `cavemem` command on your `PATH` that points at the unpacked
   `dist/index.js`.

**Our global prefix is `~/.local`, not the system one.** Installs go to
`~/.local/lib/node_modules/cavemem` with the command at `~/.local/bin/cavemem`
(already on `PATH`, ahead of `/usr/local/bin`). Because it is under your home
directory, none of this needs `sudo`. Every `npm` command below therefore
passes `--prefix ~/.local`.

## How to tell what you're running

```bash
cavemem --version                       # version baked into the bundle at build time
npm ls -g --prefix ~/.local cavemem     # version npm recorded when it installed the tarball
cavemem doctor                          # store, worker, IDE wiring health
```

After a clean tarball install the first two agree. If they disagree, the `dist/`
was hand-swapped without reinstalling the package (see below) — reinstall to fix
it.

> **Known drift as of 2026-09-06:** the current install reports `0.2.1` from
> `npm ls` (a July install) but `0.3.0` from `cavemem --version` (the bundle has
> been rebuilt in place since). One clean reinstall from `main` reconciles it.

## Updating after fixes land on `main`

Run this whenever you want merged fixes in your live install:

```bash
cd ~/dev/cavemem
git checkout main && git pull
pnpm install
pnpm build

# Run the publish-surface gate when the change touched packages/installers,
# packages/hooks (the hook stdout/stderr contract), apps/cli, or the pack flow.
bash scripts/e2e-publish.sh

# Stage README/LICENSE/hook stubs into apps/cli, then build the tarball.
pnpm --filter cavemem stage-publish
( cd apps/cli && npm pack )              # writes apps/cli/cavemem-<version>.tgz

# Swap the install. `stop` first so the old worker process exits.
cavemem stop
npm install -g --prefix ~/.local apps/cli/cavemem-<version>.tgz
cavemem --version                        # confirm it moved

# Rewrite the per-IDE hook stubs and MCP entries against the new build.
cavemem install --ide claude-code
cavemem install --ide codex
cavemem install --ide opencode

cavemem start                            # or let the next agent hook autostart it
```

Verify: `cavemem doctor` is clean, `cavemem search "<phrase you know is stored>"`
returns hits, and a fresh agent session still gets its `## Prior-session
context` preface.

Your `~/.cavemem/` (settings, `data.db`, embedding model) is untouched by any of
this — it lives outside the package.

## Why the version says 0.3.0 when the registry is 0.2.1

The number in `apps/cli/package.json` (currently `0.3.0`) is what `tsup` bakes
into the bundle, so `cavemem --version` reports it regardless of what the
registry holds. Bumping that number is a separate, deliberate step: it consumes
the pending `.changeset/*` files via `pnpm changeset version` and **goes through
a PR** — never a direct-push bump (release policy in `AGENTS.md`). The local
rebuild above does not need a bump; for a private tarball install the exact
number is cosmetic. As of 2026-09-06 there are three unconsumed changesets on
`main` (`shared-memory-server`, `stale-opencode-bridge-warning`,
`fix-session-start-cwd-window`) — fold them into the next version PR.

## When the shared server exists

Once the central worker is deployed (`deploy/README.md`), the server needs the
same tarball built and installed on its box, and the client machines switch to
remote mode instead of running their own worker. That cutover is the deploy
runbook's job; this page stays the procedure for a standalone local install.
