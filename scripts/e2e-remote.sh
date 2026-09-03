#!/usr/bin/env bash
# scripts/e2e-remote.sh
#
# End-to-end test of remote mode against the *published* artifact:
#   server: isolated $HOME, provider=none, worker run on a free port
#   client: second isolated $HOME with remote.url/token, every hook event
#   asserts: rows land in the server DB, client has no data.db, search
#            from the client returns a hit, MCP over HTTP answers initialize.
#
# Run from repo root:  bash scripts/e2e-remote.sh
# Requires: node >= 20, npm, pnpm, curl
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$REPO/.e2e-remote"
PACK="$WORK/pack"
PREFIX="$WORK/prefix"
SERVER_HOME="$WORK/server"
CLIENT_HOME="$WORK/client"
WORKER_PID=""

cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
rm -rf "$WORK"
mkdir -p "$PACK" "$PREFIX" "$SERVER_HOME" "$CLIENT_HOME"

cd "$REPO"
export CAVEMEM_NO_AUTOSTART=1
unset CAVEMEM_HOME XDG_DATA_HOME

echo "==> 1. build + pack"
pnpm build >/dev/null
pnpm --filter cavemem stage-publish >/dev/null
VERSION=$(node -e "console.log(require('$REPO/apps/cli/package.json').version)")
( cd "$REPO/apps/cli" && npm pack --pack-destination "$PACK" >/dev/null )
npm install --prefix "$PREFIX" --global "$PACK/cavemem-$VERSION.tgz" >/dev/null
BIN="$PREFIX/bin/cavemem"

PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

echo "==> 2. server settings (port $PORT, provider=none, idle shutdown off)"
mkdir -p "$SERVER_HOME/.cavemem"
cat > "$SERVER_HOME/.cavemem/settings.json" <<EOF
{
  "workerPort": $PORT,
  "workerHost": "127.0.0.1",
  "embedding": { "provider": "none", "idleShutdownMs": 0 }
}
EOF

echo "==> 3. start server worker"
HOME="$SERVER_HOME" "$BIN" worker run >"$WORK/worker.log" 2>&1 &
WORKER_PID=$!
for _ in $(seq 1 50); do
  if curl -fs -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fs "http://127.0.0.1:$PORT/healthz" | grep -q '"ok":true' || { echo "server never came up"; cat "$WORK/worker.log"; exit 1; }
TOKEN=$(cat "$SERVER_HOME/.cavemem/worker-token")
test -n "$TOKEN"

echo "==> 4. client settings (remote mode)"
mkdir -p "$CLIENT_HOME/.cavemem"
cat > "$CLIENT_HOME/.cavemem/settings.json" <<EOF
{
  "remote": { "url": "http://127.0.0.1:$PORT", "token": "$TOKEN" },
  "embedding": { "provider": "none" }
}
EOF
export HOME="$CLIENT_HOME"

echo "==> 5. install --ide claude-code writes an http MCP entry"
"$BIN" install --ide claude-code >/dev/null
grep -q "\"type\": \"http\"" "$HOME/.claude.json" || { echo "expected http MCP entry"; cat "$HOME/.claude.json"; exit 1; }
grep -q "/mcp" "$HOME/.claude.json"

echo "==> 6. drive full hook lifecycle from the client"
echo '{"session_id":"e2e-remote","hook_event_name":"SessionStart","source":"startup","cwd":"/tmp"}' | "$BIN" hook run session-start --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"UserPromptSubmit","prompt":"Edit the broken /etc/hosts file"}' | "$BIN" hook run user-prompt-submit --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/x.ts"},"tool_response":{"success":true}}' | "$BIN" hook run post-tool-use --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"Stop","last_assistant_message":"shipped the migration"}' | "$BIN" hook run stop --ide claude-code
echo '{"session_id":"e2e-remote","hook_event_name":"SessionEnd","reason":"logout"}' | "$BIN" hook run session-end --ide claude-code

echo "==> 7. client has no local database"
test ! -e "$CLIENT_HOME/.cavemem/data.db" || { echo "client wrote a local data.db"; exit 1; }

echo "==> 8. rows landed on the server"
HOME="$SERVER_HOME" "$BIN" search "hosts" | grep -q "hosts" || { echo "server has no hit"; exit 1; }

echo "==> 9. client search goes over HTTP"
"$BIN" search "hosts" | grep -q "hosts" || { echo "remote search returned no hit"; exit 1; }

echo "==> 10. status + doctor report remote mode"
"$BIN" status | grep -q "remote" || { echo "status missing remote"; exit 1; }
"$BIN" doctor | grep -q "auth:     ok" || { echo "doctor auth not ok"; "$BIN" doctor; exit 1; }

echo "==> 11. local-only command refuses"
if "$BIN" reindex 2>/dev/null; then echo "reindex should refuse in remote mode"; exit 1; fi

echo "==> 12. MCP over HTTP answers initialize"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
curl -fs -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$INIT" | grep -q '"serverInfo"' || { echo "mcp initialize failed"; exit 1; }

echo "==> 13. MCP over HTTP rejects without bearer"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$INIT")
test "$code" = "401" || { echo "expected 401, got $code"; exit 1; }

echo "==> 14. viewer HTML requires the cookie handshake, not a bare GET or the real token"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
test "$code" = "401" || { echo "expected bare GET / to 401, got $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/?token=$TOKEN")
test "$code" = "401" || { echo "expected the real token to be rejected as a handshake nonce, got $code"; exit 1; }
NONCE=$(curl -fs -X POST "http://127.0.0.1:$PORT/api/viewer-session" -H "Authorization: Bearer $TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')
test -n "$NONCE" || { echo "failed to mint a viewer-session nonce"; exit 1; }
JAR="$WORK/cookies.txt"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" "http://127.0.0.1:$PORT/?token=$NONCE")
test "$code" = "302" || { echo "expected nonce handshake to 302, got $code"; exit 1; }
grep -q "cavemem_viewer" "$JAR" || { echo "handshake did not set the viewer cookie"; cat "$JAR"; exit 1; }
curl -fs -b "$JAR" "http://127.0.0.1:$PORT/" | grep -q "e2e-remote" || { echo "cookie did not authenticate the viewer"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$PORT/api/sessions")
test "$code" = "401" || { echo "viewer cookie must not authenticate /api/*, got $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/?token=$NONCE")
test "$code" = "401" || { echo "expected a reused nonce to 401, got $code"; exit 1; }

echo "==> 15. spool on outage, drain on recovery"
kill "$WORKER_PID"; wait "$WORKER_PID" 2>/dev/null || true; WORKER_PID=""
echo '{"session_id":"e2e-remote-2","hook_event_name":"UserPromptSubmit","prompt":"queued while down"}' | "$BIN" hook run user-prompt-submit --ide claude-code
test -s "$CLIENT_HOME/.cavemem/spool.jsonl" || { echo "expected a spooled entry"; exit 1; }
HOME="$SERVER_HOME" "$BIN" worker run >>"$WORK/worker.log" 2>&1 &
WORKER_PID=$!
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.1; done
echo '{"session_id":"e2e-remote-2","hook_event_name":"Stop","last_assistant_message":"back"}' | "$BIN" hook run stop --ide claude-code
test ! -s "$CLIENT_HOME/.cavemem/spool.jsonl" || { echo "spool not drained"; cat "$CLIENT_HOME/.cavemem/spool.jsonl"; exit 1; }
HOME="$SERVER_HOME" "$BIN" search "queued" | grep -q "queued" || { echo "replayed row missing"; exit 1; }

echo
echo "ALL REMOTE CHECKS PASSED"
