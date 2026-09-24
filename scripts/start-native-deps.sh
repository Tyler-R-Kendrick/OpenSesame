#!/usr/bin/env bash
# Start user-space OpenFGA + OpenBao (no root/Docker required).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
export PATH="$TOOLS/bin:$PATH"
mkdir -p "$TOOLS/run" "$TOOLS/logs"

start_one() {
  local name="$1" pidfile="$2" check_url="$3"
  shift 3
  if curl -sf "$check_url" >/dev/null 2>&1; then
    echo "$name already up"
    return 0
  fi
  "$@" >"$TOOLS/logs/${name}.log" 2>&1 &
  echo $! >"$pidfile"
  for _ in $(seq 1 40); do
    if curl -sf "$check_url" >/dev/null 2>&1; then
      echo "$name ready (pid $(cat "$pidfile"))"
      return 0
    fi
    sleep 0.25
  done
  echo "$name failed to become ready; log:" >&2
  tail -50 "$TOOLS/logs/${name}.log" >&2
  return 1
}

start_one openfga "$TOOLS/run/openfga.pid" "http://127.0.0.1:18081/healthz" \
  env OPENFGA_DATASTORE_ENGINE=memory "$TOOLS/bin/openfga" run \
    --http-addr 127.0.0.1:18081 --grpc-addr 127.0.0.1:18082

start_one openbao "$TOOLS/run/openbao.pid" "http://127.0.0.1:18200/v1/sys/health" \
  "$TOOLS/bin/bao" server -dev \
    -dev-root-token-id=dev-only-not-for-prod \
    -dev-listen-address=127.0.0.1:18200

export OPENSESAME_OPENFGA_URL=http://127.0.0.1:18081
export OPENSESAME_OPENBAO_URL=http://127.0.0.1:18200
export OPENSESAME_OPENBAO_TOKEN=dev-only-not-for-prod
export BAO_ADDR="$OPENSESAME_OPENBAO_URL"
export BAO_TOKEN="$OPENSESAME_OPENBAO_TOKEN"

"$TOOLS/bin/bao" kv put -mount=secret github/acme token=never-to-agent >/dev/null

BOOT="$(python3 - <<'PY'
import json, urllib.request, os
base = os.environ["OPENSESAME_OPENFGA_URL"]

def post(path, obj):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(obj).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)

store = post("/stores", {"name": "opensesame-demo"})
sid = store["id"]
model = {
    "schema_version": "1.1",
    "type_definitions": [
        {"type": "user"},
        {
            "type": "connection",
            "relations": {"user": {"this": {}}},
            "metadata": {
                "relations": {
                    "user": {"directly_related_user_types": [{"type": "user"}]}
                }
            },
        },
    ],
}
post(f"/stores/{sid}/authorization-models", model)
post(
    f"/stores/{sid}/write",
    {
        "writes": {
            "tuple_keys": [
                {
                    "user": "user:demo",
                    "relation": "user",
                    "object": "connection:demo-conn",
                }
            ]
        }
    },
)
print(sid)
PY
)"
export OPENSESAME_OPENFGA_STORE_ID="$BOOT"
# Persist for later shells
cat >"$TOOLS/run/env.sh" <<EOF
export OPENSESAME_OPENFGA_URL=$OPENSESAME_OPENFGA_URL
export OPENSESAME_OPENFGA_STORE_ID=$OPENSESAME_OPENFGA_STORE_ID
export OPENSESAME_OPENBAO_URL=$OPENSESAME_OPENBAO_URL
export OPENSESAME_OPENBAO_TOKEN=$OPENSESAME_OPENBAO_TOKEN
export BAO_ADDR=$BAO_ADDR
export BAO_TOKEN=$BAO_TOKEN
EOF
echo "OPENSESAME_OPENFGA_URL=$OPENSESAME_OPENFGA_URL"
echo "OPENSESAME_OPENFGA_STORE_ID=$OPENSESAME_OPENFGA_STORE_ID"
echo "OPENSESAME_OPENBAO_URL=$OPENSESAME_OPENBAO_URL"
echo "native deps ready"
