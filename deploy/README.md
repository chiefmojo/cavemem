# Shared memory server — deployment & cutover runbook

Moves cavemem from per-machine local mode to one central worker on the LAN that
owns the SQLite store for every coding agent on every dev box.

- Design: `docs/superpowers/specs/2026-09-02-shared-memory-server-design.md`
  and `companion-ops/specs/2026-09-02-cavemem-shared-memory-server.md`.
- Tracks **WP #194** (`Memory` sub-project). Currently *Developed* — the code
  is on `main`; this runbook is the "ship it" step.
- Remote-mode behaviour and settings reference: `docs/remote.md`.

## Target state

| Piece | Where | Notes |
|-------|-------|-------|
| Central worker (HTTP `/api/*`, MCP over HTTP `/mcp`, embedding backfill) | `neuromancer`, user `agentops`, port `37777` | systemd unit `cavemem-worker.service`, bound `0.0.0.0`, idle shutdown disabled |
| Canonical store | `neuromancer:/home/agentops/.cavemem/data.db` | migrated from `wintermute:/home/chiefmojo/.cavemem` (the current live 207M store) |
| Clients | every dev box (`wintermute` now; others as needed) | `remote.url` + `remote.token` set; IDE MCP entries rewritten to remote; local `data.db` kept as fallback until validated |

Companions (`faye` / `dora` / `violet`) are **out of scope** — read-only access
for them is a separate problem, per the spec.

## Decisions already settled

- **Host:** `neuromancer` (consolidation target; companion-chat lands there later).
- **Service account:** `agentops`, login-capable (`/bin/bash`), expected to host
  more than cavemem over time.
- **Port / URL:** `http://neuromancer:37777`, worker and `/mcp` on the one listener.
- **Legacy store:** `neuromancer:/home/faye/.cavemem` (66M, stale) is shelved as a
  tarball, not imported.

## Inputs to have in hand

- `sudo` on `neuromancer` (account creation, systemd unit).
- `neuromancer`'s LAN IP (goes in `workerAllowedHosts` alongside the hostname).
- Final client list. `wintermute` is the only one for the initial cutover unless
  you decide otherwise.

---

## 0. Pre-flight (on the build box — `wintermute`, from `main`)

The npm registry `cavemem` is upstream's frozen release and has **no remote
mode** — the server and clients must run a build from this fork's `main`.

```bash
cd ~/dev/cavemem
git checkout main && git pull
pnpm install
pnpm build                       # must be green
bash scripts/e2e-remote.sh       # remote mode: server+client through the packed artifact
bash scripts/e2e-publish.sh      # publish surface: bin shim, hook contract, MCP
```

Both e2e scripts are required to pass before shipping the publish surface
(CLAUDE.md). Do not proceed on a red run.

Build the install artifact:

```bash
pnpm --filter cavemem stage-publish
( cd apps/cli && npm pack )       # writes apps/cli/cavemem-<version>.tgz
```

Keep the `.tgz` — the same file installs on the server and (optionally) refreshes
clients.

---

## 1. Server bring-up (`neuromancer`)

### 1a. Account + Node

```bash
sudo useradd -m -s /bin/bash agentops
```

Install a **system** Node ≥ 20 (not nvm — the systemd unit hard-codes
`PATH=/home/agentops/.local/bin:/usr/local/bin:/usr/bin:/bin` and does not load
shell profiles). Then, as `agentops`:

```bash
npm config set prefix ~/.local
env -i PATH=/usr/local/bin:/usr/bin:/bin node --version   # confirm >= 20
```

### 1b. Install the build

```bash
scp apps/cli/cavemem-<version>.tgz agentops@neuromancer:~
ssh agentops@neuromancer 'npm install -g ~/cavemem-<version>.tgz && cavemem --version'
```

### 1c. Migrate the live store (run on `wintermute` as `chiefmojo`)

This is the cutover's only real downtime — the local worker stops, the DB is
checkpointed, then copied. The local store stays on disk as a fallback.

```bash
cavemem stop                                             # confirm no `worker run` process remains
sqlite3 ~/.cavemem/data.db 'PRAGMA wal_checkpoint(TRUNCATE)'
rsync -a --exclude worker.pid --exclude worker-token --exclude worker.state.json \
      --exclude spool.jsonl \
      ~/.cavemem/ agentops@neuromancer:~/.cavemem/
```

`models/` (local embedding model) copies with it; if skipped it re-derives from
`settings.json` on first run.

### 1d. Server settings

As `agentops`, merge into `~/.cavemem/settings.json` (keep the copied
`embedding.provider` / `embedding.model`):

```json
{
  "workerHost": "0.0.0.0",
  "workerAllowedHosts": ["neuromancer:37777", "<neuromancer-lan-ip>:37777"],
  "embedding": { "idleShutdownMs": 0 }
}
```

`workerAllowedHosts` must be non-empty — an empty list keeps the loopback-only
fallback even with `workerHost: "0.0.0.0"`. `idleShutdownMs: 0` is required so
the central worker never self-exits.

> **Security note:** once bound to `0.0.0.0` the bearer token is the *only* gate.
> The Host/Origin allowlist and `0600` token file were built around the
> `127.0.0.1` trust boundary; the LAN is now trusted, consciously.

### 1e. Shelve the legacy store

```bash
sudo tar czf /home/agentops/legacy-faye-cavemem-2026-09-02.tgz -C /home/faye .cavemem
sudo chown agentops:agentops /home/agentops/legacy-faye-cavemem-2026-09-02.tgz
```

### 1f. systemd unit

```bash
sudo cp deploy/cavemem-worker.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/cavemem-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now cavemem-worker
sudo journalctl -u cavemem-worker -n 20          # expect: listening on http://0.0.0.0:37777
```

### 1g. Read the client token

```bash
sudo cat /home/agentops/.cavemem/worker-token
```

### 1h. Server smoke test (from `wintermute`)

```bash
curl -sS -m 4 -o /dev/null -w '%{http_code}\n' http://neuromancer:37777/healthz    # 200
curl -sS -H "Authorization: Bearer <token>" \
  'http://neuromancer:37777/api/search?q=<phrase-from-migrated-store>'              # hits
```

---

## 2. Client cutover (each dev box)

1. `cavemem stop` — confirm no `worker run` process remains.
2. Point at the server:
   ```bash
   cavemem config set remote.url http://neuromancer:37777
   cavemem config set remote.token <token>
   ```
3. Rewrite IDE MCP entries (stdio → remote):
   ```bash
   cavemem install --ide claude-code
   cavemem install --ide codex
   cavemem install --ide opencode
   ```
4. Codex only — add to the shell profile:
   ```bash
   export CAVEMEM_REMOTE_TOKEN=<token>
   ```
5. Verify:
   ```bash
   cavemem doctor          # server: ok, auth: ok
   ```
6. Leave local `~/.cavemem/data.db` in place as a fallback. Delete it only after
   the server has been validated for a few days.

Local-only commands (`worker *`, `start`, `stop`, `restart`, `viewer`,
`reindex`, `export`, `import`, `mcp`) now refuse with
`remote mode: run this on the server` — run them on `neuromancer` as `agentops`.

---

## 3. Verification

- **Migrated data reachable:** from `wintermute`, `cavemem search "<phrase from
  the migrated store>"` returns hits.
- **Cross-machine round-trip:** start a Claude Code session on `wintermute`, say
  something distinctive, end it. `cavemem search` for that phrase — then run a
  `search` from a Codex MCP call. Both hit the same central store.
- **Service health:** `sudo systemctl is-active cavemem-worker` → `active`.
  Hook POST telemetry is emitted by the *client* hook process (its stderr /
  structured JSON lines), not the worker journal.
- **Outage behaviour:** stop the unit, start a session, restart the unit. The
  session gets no prior-session injection (accepted degradation); subsequent
  hooks spool and drain after the worker returns.

---

## 4. Rollback / cutback

Per-client, no server teardown needed:

```bash
cavemem config unset remote.url
cavemem config unset remote.token
cavemem install --ide claude-code --ide codex --ide opencode   # rewrites stdio entries
cavemem start
```

The local `data.db` fallback resumes from where it was at cutover (it will be
stale by the gap, but functional). Anything written to the central store during
the remote window stays on `neuromancer` — re-sync it back only if that gap
matters.

To pause the whole fleet: `sudo systemctl stop cavemem-worker`. Clients spool and
degrade; they do not error out.

---

## 5. Post-deploy

- WP #194 → *In testing* during the validation window, then *Closed*.
- Comment on #194: what shipped, the server host/account/port, the `main` commit
  the artifact was built from, and the verification results.
- Note any per-IDE gaps found during round-trip testing as follow-up WPs under
  `Memory`.
