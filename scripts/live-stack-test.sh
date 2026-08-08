#!/usr/bin/env bash
# Live stack verification against OpenFGA + OpenBao + gateway (user-space).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/start-native-deps.sh"
# shellcheck disable=SC1091
source "$ROOT/.tools/run/env.sh"

export OPENSESAME_DEBUG_RUN="${OPENSESAME_DEBUG_RUN:-live-stack}"

echo "== unit/provider tests =="
cargo +1.88.0 test --lib -p opensesame-provider-openfga -p opensesame-provider-openbao

echo "== live OpenFGA/OpenBao rust tests =="
cargo +1.88.0 test -p opensesame-provider-openfga -p opensesame-provider-openbao -- --ignored --nocapture

echo "== build gateway/cli =="
cargo +1.88.0 build -p opensesame-gateway -p opensesame-cli

# Start gateway with live providers
pkill -f 'opensesame-gateway' 2>/dev/null || true
sleep 0.5
DB="$ROOT/.tools/run/gateway.sqlite"
rm -f "$DB"
export OPENSESAME_LISTEN=127.0.0.1:18787
export OPENSESAME_DB="sqlite://${DB}?mode=rwc"
export OPENSESAME_RESOURCE=http://127.0.0.1:18787
export OPENSESAME_OPERATOR_TOKEN="${OPENSESAME_OPERATOR_TOKEN:-opensesame-dev-operator}"
OP_HDR=(-H "x-opensesame-operator: ${OPENSESAME_OPERATOR_TOKEN}")
nohup "$ROOT/target/debug/opensesame-gateway" >"$ROOT/.tools/logs/gateway.log" 2>&1 &
echo $! >"$ROOT/.tools/run/gateway.pid"
for _ in $(seq 1 40); do
  if curl -sf http://127.0.0.1:18787/health/live >/dev/null; then
    break
  fi
  # surface startup failures early
  if ! kill -0 "$(cat "$ROOT/.tools/run/gateway.pid")" 2>/dev/null; then
    echo "gateway exited; log:" >&2
    /usr/bin/tail -50 "$ROOT/.tools/logs/gateway.log" >&2
    exit 1
  fi
  sleep 0.25
done
if ! curl -sf http://127.0.0.1:18787/health/live >/dev/null; then
  echo "gateway not ready; log:" >&2
  /usr/bin/tail -50 "$ROOT/.tools/logs/gateway.log" >&2
  exit 1
fi

echo "== provider health =="
curl -sf "${OP_HDR[@]}" http://127.0.0.1:18787/health/providers | tee /tmp/os-providers.json
python3 - <<'PY'
import json
p=json.load(open("/tmp/os-providers.json"))
assert p["secret_ref_agent_facing"] is False
assert p["agent_api"]=="connection_ref"
assert p["openfga"]["configured"] is True and p["openfga"].get("status")=="ok"
assert p["openbao"]["configured"] is True and p["openbao"].get("quorum_ok") is True
print("providers_ok")
PY

echo "== connections (ConnectionRef only) =="
curl -sf "${OP_HDR[@]}" http://127.0.0.1:18787/api/v1/connections | tee /tmp/os-conns.json
python3 - <<'PY'
import json
c=json.load(open("/tmp/os-conns.json"))
assert "connections" in c
assert c["connections"][0]["connection_ref"].startswith("conn://")
assert "secret" not in json.dumps(c).lower() or "secret_ref" not in json.dumps(c).lower()
print("connections_ok", c["connections"][0]["connection_ref"])
PY

CREF=$(python3 -c 'import json;print(json.load(open("/tmp/os-conns.json"))["connections"][0]["connection_ref"])')

echo "== L1 invoke via connection_ref =="
curl -sf "${OP_HDR[@]}" -X POST http://127.0.0.1:18787/api/v1/intents \
  -H 'content-type: application/json' \
  -d "{\"connection_ref\":\"$CREF\",\"operation\":\"repository.read\",\"resource\":\"repo:acme/catalog\",\"invoke_level\":1,\"idempotency_key\":\"live-1\"}" \
  | tee /tmp/os-invoke.json
python3 - <<'PY'
import json
r=json.load(open("/tmp/os-invoke.json"))
assert r.get("credential_bytes_returned") is False
assert r.get("connection_ref","").startswith("conn://")
assert "never-to-agent" not in json.dumps(r)
print("invoke_ok", r.get("outcome") or r.get("status") or "receipt")
PY

echo "== L3 materialize denied =="
CODE=$(curl -s -o /tmp/os-l3.json -w "%{http_code}" "${OP_HDR[@]}" -X POST http://127.0.0.1:18787/api/v1/intents \
  -H 'content-type: application/json' \
  -d "{\"connection_ref\":\"$CREF\",\"operation\":\"credential.resolve\",\"resource\":\"x\",\"invoke_level\":3}")
test "$CODE" = "403"
python3 - <<'PY'
import json
r=json.load(open("/tmp/os-l3.json"))
assert r.get("error")=="materialize_denied"
print("l3_denied_ok")
PY

echo "== OpenBao bearer path denied (direct) =="
cargo +1.88.0 test -p opensesame-provider-openbao live_openbao_denies_bearer -- --ignored --nocapture

echo "== battle tests =="
./scripts/battle-test.sh

echo "LIVE STACK OK"
