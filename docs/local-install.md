# Running and updating a real local install

This is for the machine where you *use* cavemem as your actual memory layer (a
real `~/.cavemem/data.db`, real agent sessions) — as opposed to hacking on the
code. If you just want a dev build that tracks the working tree, use the
`pnpm link --global` flow in `development.md` instead.

## Toolchain

Three tools do the work. Building needs all three; installing the published
package from npm needs only `node` + `npm`.

| Tool | On wintermute | What it is |
|------|---------------|------------|
| `node` | `/usr/bin/node` (system package, v22) | the JavaScript runtime everything runs on |
| `npm` | ships inside Node | installs packages; used here for the global install from npm |
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

The **server box does not need `pnpm` at all** — it installs straight from the
registry with `npm i -g @chiefmojo/cavemem@<version>` (see `deploy/README.md`).

## The npm background, in plain terms

**The published package is `@chiefmojo/cavemem`.** Releases are cut manually
from this repo's `main` (`pnpm release` after `npm login`) and installed from
the registry — the primary path on every box:

```bash
npm i -g @chiefmojo/cavemem@<version>
```

**The bundle is self-contained.** The build (`tsup`) inlines every
`@cavemem/*` workspace package into a single `apps/cli/dist/index.js`. Only
the real third-party libraries (`commander`, `better-sqlite3`, `hono`, the
MCP SDK, and the optional local-embedding library) stay as normal
dependencies. That is what "self-contained package" means: the bundle carries
all of our code and only needs npm to fetch a short list of outside
libraries. (History: commit `d69850c`.)

**A "tarball" (`.tgz`) is that bundle zipped up** with a small `package.json`
listing those third-party deps; `npm install -g <file>.tgz` unpacks it, runs
`npm install` for the third-party deps, and drops the `cavemem` command on
your `PATH`. It exists only as break-glass — a `.tgz` is attached to the
GitHub Release for boxes that cannot reach npm.

**Our global prefix is `~/.local`, not the system one.** Installs go to
`~/.local/lib/node_modules/@chiefmojo/cavemem` with the command at
`~/.local/bin/cavemem` (already on `PATH`, ahead of `/usr/local/bin`). Because
it is under your home directory, none of this needs `sudo`. Every `npm`
command below therefore passes `--prefix ~/.local`.

## How to tell what you're running

```bash
cavemem --version                                # version baked into the bundle at build time
npm ls -g --prefix ~/.local @chiefmojo/cavemem   # version npm recorded at install time
cavemem doctor                                   # store, worker, IDE wiring health
```

After a clean install the first two agree. If they disagree, the `dist/` was
hand-swapped without reinstalling the package (see below) — reinstall to fix
it.

> The old drift — an install whose `npm ls` reported `0.2.1` while
> `cavemem --version` said `0.3.0`, a side effect of hand-rebuilding tarballs
> in place — is resolved by installing from the registry: both commands now
> report the published `@chiefmojo/cavemem` version.

## Updating to a new release

Releases are cut manually from `main` and published to npm as
`@chiefmojo/cavemem`. To pick one up:

```bash
cavemem stop
npm install -g --prefix ~/.local @chiefmojo/cavemem@<version>   # or @latest
cavemem --version                        # confirm it moved

# Rewrite the per-IDE hook stubs and MCP entries against the new build.
cavemem install --ide claude-code
cavemem install --ide codex
cavemem install --ide opencode

cavemem start                            # or let the next agent hook autostart it
```

Break-glass only: if the box cannot reach npm, grab the `.tgz` attached to the
GitHub Release and `npm install -g --prefix ~/.local <file>.tgz` instead of the
registry install.

Verify: `cavemem doctor` is clean, `cavemem search "<phrase you know is stored>"`
returns hits, and a fresh agent session still gets its `## Prior-session
context` preface.

Your `~/.cavemem/` (settings, `data.db`, embedding model) is untouched by any of
this — it lives outside the package.

## Where the version number comes from

The number in `apps/cli/package.json` is what `tsup` bakes into the bundle, so
`cavemem --version` always reports the installed package's version — and with
registry installs, `npm ls` agrees by construction. The old mismatch between
the registry's `0.2.1` and a locally rebuilt `0.3.0` bundle belonged to the
hand-built-tarball era and is gone.

Bumping the version is a separate, deliberate step: it consumes the pending
`.changeset/*` files via `pnpm changeset version` and **goes through a PR** —
never a direct-push bump (release policy in `AGENTS.md`). Fold whatever
changesets are pending on `main` into the next version PR.

## When the shared server exists

Once the central worker is deployed (`deploy/README.md`), the server installs
the same published package (`npm i -g @chiefmojo/cavemem@<version>`), and the
client machines switch to remote mode instead of running their own worker. That
cutover is the deploy runbook's job; this page stays the procedure for a
standalone local install.
