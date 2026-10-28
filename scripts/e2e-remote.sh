#!/usr/bin/env bash
# scripts/e2e-remote.sh
#
# End-to-end test of remote mode against the *published* artifact:
#   server: isolated $HOME, provider=none, worker run on a free port
#   client: second isolated $HOME with remote.url/token, every hook event
#   asserts: rows land in the server DB, client has no data.db, search
#            from the client returns a hit, MCP over HTTP answers initialize.
#   step 16: a second server with a stub HTTP embedding endpoint (loopback,
#            no model download) so hybrid MCP search runs on the scan thread.
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
STUB_PID=""
WORKER2_PID=""

cleanup() {
  for pid in "$WORKER2_PID" "$STUB_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
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
pnpm --filter @chiefmojo/cavemem stage-publish >/dev/null
VERSION=$(node -e "console.log(require('$REPO/apps/cli/package.json').version)")
( cd "$REPO/apps/cli" && npm pack --pack-destination "$PACK" >/dev/null )
npm install --prefix "$PREFIX" --global "$PACK/chiefmojo-cavemem-$VERSION.tgz" >/dev/null
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

echo "==> 16. hybrid MCP search through the scan thread"
# provider=none (every check above) never creates the scan thread. Serve an
# ollama-shaped embedding endpoint on loopback so the worker builds an embedder.
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
STUB_PORT=$(free_port)
cat > "$WORK/embed-stub.mjs" <<'STUB'
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const DIM = 8;
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const prompt = JSON.parse(body || '{}').prompt ?? '';
    const h = createHash('sha256').update(prompt).digest();
    const embedding = Array.from({ length: DIM }, (_, i) => (h[i] - 127.5) / 127.5);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embedding }));
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
STUB
node "$WORK/embed-stub.mjs" "$STUB_PORT" &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -fs -X POST "http://127.0.0.1:$STUB_PORT/api/embeddings" -d '{"prompt":"x"}' >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fs -X POST "http://127.0.0.1:$STUB_PORT/api/embeddings" -d '{"prompt":"x"}' | grep -q '"embedding"' || { echo "embedding stub never came up"; exit 1; }

PORT2=$(free_port)
SERVER2_HOME="$WORK/server2"
CLIENT2_HOME="$WORK/client2"
mkdir -p "$SERVER2_HOME/.cavemem" "$CLIENT2_HOME/.cavemem"
cat > "$SERVER2_HOME/.cavemem/settings.json" <<EOF
{
  "workerPort": $PORT2,
  "workerHost": "127.0.0.1",
  "embedding": { "provider": "ollama", "model": "stub-embed", "endpoint": "http://127.0.0.1:$STUB_PORT", "idleShutdownMs": 0 }
}
EOF
HOME="$SERVER2_HOME" "$BIN" worker run >"$WORK/worker2.log" 2>&1 &
WORKER2_PID=$!
for _ in $(seq 1 100); do
  curl -fs "http://127.0.0.1:$PORT2/healthz" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fs "http://127.0.0.1:$PORT2/healthz" | grep -q '"ok":true' || { echo "second server never came up"; cat "$WORK/worker2.log"; exit 1; }
TOKEN2=$(cat "$SERVER2_HOME/.cavemem/worker-token")
test -n "$TOKEN2"
cat > "$CLIENT2_HOME/.cavemem/settings.json" <<EOF
{
  "remote": { "url": "http://127.0.0.1:$PORT2", "token": "$TOKEN2" },
  "embedding": { "provider": "none" }
}
EOF
echo '{"session_id":"e2e-scan","hook_event_name":"SessionStart","source":"startup","cwd":"/tmp"}' | HOME="$CLIENT2_HOME" "$BIN" hook run session-start --ide claude-code
echo '{"session_id":"e2e-scan","hook_event_name":"UserPromptSubmit","prompt":"Edit the broken /etc/hosts file"}' | HOME="$CLIENT2_HOME" "$BIN" hook run user-prompt-submit --ide claude-code
echo '{"session_id":"e2e-scan","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/x.ts"},"tool_response":{"success":true}}' | HOME="$CLIENT2_HOME" "$BIN" hook run post-tool-use --ide claude-code
echo '{"session_id":"e2e-scan","hook_event_name":"Stop","last_assistant_message":"shipped the migration"}' | HOME="$CLIENT2_HOME" "$BIN" hook run stop --ide claude-code

caught_up='let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const s=JSON.parse(d);console.log("state: embedded="+s.embedded+" total="+s.total);process.exit(s.total>0&&s.embedded===s.total?0:1)})'
for _ in $(seq 1 100); do
  curl -fs -H "Authorization: Bearer $TOKEN2" "http://127.0.0.1:$PORT2/api/state" | node -e "$caught_up" >/dev/null && break
  sleep 0.2
done
curl -fs -H "Authorization: Bearer $TOKEN2" "http://127.0.0.1:$PORT2/api/state" | node -e "$caught_up" || { echo "embedding never caught up"; cat "$WORK/worker2.log"; exit 1; }

mcp_call() {
  curl -fs -X POST "http://127.0.0.1:$PORT2/mcp" \
    -H "Authorization: Bearer $TOKEN2" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1"
}
mcp_call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' | grep -q '"serverInfo"' || { echo "second server: mcp initialize failed"; exit 1; }
mcp_call '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
# The tool result is a JSON hit list inside the envelope, which may arrive as one SSE data: line.
parse_hits='let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const line=d.split("\n").find(l=>l.startsWith("data:"));const env=JSON.parse(line?line.slice(5):d);if(env.error||env.result.isError){console.error("search error: "+JSON.stringify(env.error??env.result));process.exit(1)}const hits=JSON.parse(env.result.content[0].text);if(!Array.isArray(hits)||hits.length===0){console.error("no hits");process.exit(1)}console.log("hits="+hits.length)})'
for q in hosts migration; do
  REQ="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"query\":\"$q\"}}}"
  mcp_call "$REQ" | node -e "$parse_hits" || { echo "hybrid MCP search '$q' failed"; cat "$WORK/worker2.log"; exit 1; }
done

if grep -E 'scan-thread-exit|scan-thread-load-timeout' "$WORK/worker2.log"; then
  echo "scan thread died or timed out during search"; exit 1
fi

kill "$WORKER2_PID"; wait "$WORKER2_PID" 2>/dev/null || true; WORKER2_PID=""
kill "$STUB_PID"; wait "$STUB_PID" 2>/dev/null || true; STUB_PID=""

echo
echo "ALL REMOTE CHECKS PASSED"
