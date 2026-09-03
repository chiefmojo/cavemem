# Deploying the shared memory server

Design: `docs/superpowers/specs/2026-09-02-shared-memory-server-design.md`. Tracks WP #194.

## Server (neuromancer, user `agentops`)

1. Create the account with a login shell:
   ```bash
   sudo useradd -m -s /bin/bash agentops
   ```
2. Install a system Node ≥ 20 (do not use nvm for this service) and, as
   `agentops`, set an npm prefix:
   ```bash
   npm config set prefix ~/.local
   env -i PATH=/usr/local/bin:/usr/bin:/bin node --version
   ```
   The unit sets a fixed system `PATH` so the `cavemem` npm shim resolves the
   system Node; confirm the reported version is at least 20. systemd does not
   load shell profiles or nvm initialization.
3. On a build box, from the fork's `main`:
   ```bash
   pnpm build && pnpm --filter cavemem stage-publish
   ( cd apps/cli && npm pack )
   scp apps/cli/cavemem-<version>.tgz agentops@neuromancer:~
   ```
   The npm registry package is upstream's frozen release; it does not contain remote mode.
4. As `agentops`:
   ```bash
   npm install -g ~/cavemem-<version>.tgz
   ```
5. Migrate the live store from wintermute (run on wintermute as chiefmojo):
   ```bash
   cavemem stop
   sqlite3 ~/.cavemem/data.db 'PRAGMA wal_checkpoint(TRUNCATE)'
   rsync -a --exclude worker.pid --exclude worker-token --exclude spool.jsonl \
     ~/.cavemem/ agentops@neuromancer:~/.cavemem/
   ```
6. As `agentops`, edit `~/.cavemem/settings.json`:
   ```json
   {
     "workerHost": "0.0.0.0",
     "workerAllowedHosts": ["neuromancer:37777", "<lan-ip>:37777"],
     "embedding": { "idleShutdownMs": 0 }
   }
   ```
   (merge into the copied file; keep `embedding.provider`/`model` as they were.)
7. Shelve the legacy store:
   ```bash
   sudo tar czf /home/agentops/legacy-faye-cavemem-2026-09-02.tgz -C /home/faye .cavemem
   sudo chown agentops:agentops /home/agentops/legacy-faye-cavemem-2026-09-02.tgz
   ```
8. Install and start the unit:
   ```bash
   sudo cp deploy/cavemem-worker.service /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/cavemem-worker.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now cavemem-worker
   sudo journalctl -u cavemem-worker -n 20
   ```
   Expect `listening on http://0.0.0.0:37777`.
9. Read the token for clients:
   ```bash
   sudo cat /home/agentops/.cavemem/worker-token
   ```

## Client cutover (each dev box)

1. `cavemem stop`; confirm no `worker run` process remains.
2. `cavemem config set remote.url http://neuromancer:37777`
   `cavemem config set remote.token <token>`
3. `cavemem install --ide claude-code`, `--ide codex`, `--ide opencode`.
4. For Codex, add to the shell profile: `export CAVEMEM_REMOTE_TOKEN=<token>`.
5. `cavemem doctor` must show `server: ok` and `auth: ok`.
6. Local `~/.cavemem/data.db` stays as a fallback; delete it only once the server has been validated.

## Verification

- From wintermute: `cavemem search "<phrase from the migrated store>"` returns hits.
- Start a Claude Code session, say something distinctive, end it. `cavemem search` for it from wintermute, then from a Codex MCP `search` call.
- `sudo systemctl is-active cavemem-worker` reports `active`; inspect the
  startup journal with `sudo journalctl -u cavemem-worker -n 20` if it does
  not. Hook POST telemetry is emitted by the client hook process, not the
  worker service journal.
