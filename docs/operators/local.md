# Local operator guide

## Prerequisites

- Rust 1.88 (`rust-toolchain.toml`)
- Optional: Docker/Podman for Compose profile
- Or user-space OpenFGA/OpenBao via `./scripts/start-native-deps.sh` (no root)

## Run gateway

```bash
cargo run -p opensesame-gateway -- --listen 127.0.0.1:8787
```

With live providers:

```bash
./scripts/start-native-deps.sh
source .tools/run/env.sh
cargo run -p opensesame-gateway -- \
  --listen 127.0.0.1:18787
# Set OPENSESAME_DB=sqlite://$PWD/.tools/run/gateway.sqlite?mode=rwc in the environment
```

Full live drill: `./scripts/live-stack-test.sh`

Health:

- `/health/live` — process up
- `/health/ready` — accepts traffic only when authority quorum OK
- `/health/authority` — quorum status
- `/health/degraded` — structured degradation (A0 still available)
- `/health/providers` — OpenFGA/OpenBao wiring; confirms agent API is `connection_ref`
- `/api/v1/connections` — agent-facing ConnectionRef list (never SecretRef)

## Headless login

```bash
DEVCONTAINER=1 cargo run -p opensesame-cli -- login --flow auto --no-browser \
  --server http://127.0.0.1:8787
```

Approve the user code via Identity console `/device` (authenticated) which proxies to Host `/api/v1/device/approve` with a **server-side** operator token — browsers never receive `OPENSESAME_OPERATOR_TOKEN`. Direct Host approve still accepts `X-OpenSesame-Operator` for CLI/daemon tooling.

Invoke with ConnectionRef:

```bash
cargo run -p opensesame-cli -- invoke \
  --connection-ref 'conn://…/github/main' \
  --operation repository.read \
  --resource 'repo:acme/catalog'
```

## Fail-closed quorum drill

```bash
curl -X POST http://127.0.0.1:8787/api/v1/admin/authority \
  -H 'content-type: application/json' \
  -H "x-opensesame-operator: ${OPENSESAME_OPERATOR_TOKEN:-opensesame-dev-operator}" \
  -d '{"quorum_ok":false}'
# subsequent invokes return 403
```

Device approve and claim complete also require the same operator header (or `Authorization: Bearer operator:<token>`). Set `OPENSESAME_OPERATOR_TOKEN` in production — the `opensesame-dev-operator` default is local-only.

## Compose (when Docker available)

See `deploy/compose/docker-compose.yml` for Keycloak, Postgres, OpenFGA, OpenBao, NATS, gateway, worker, callback-edge.

If Docker Engine cannot be installed (no elevated privileges), use the native binary path above — it exercises the same OpenFGA/OpenBao HTTP adapters.

## Developer `@env-spec` (ADR 0006)

Preferred project contract is committed `.env.schema` (not a custom vault env YAML).

```bash
# Install bridge once
cd packages/env-spec-bridge && npm install && npm run build

# Schema check — metadata only, never secret plaintext
cargo run -p opensesame-cli -- dev check --schema fixtures/demo.env.schema

# Resolve under agent policy (placeholders / handles; no materialize)
cargo run -p opensesame-cli -- dev --agent resolve --schema fixtures/demo.env.schema

# Run a child with projected env
cargo run -p opensesame-cli -- dev --agent run --schema fixtures/demo.env.schema -- env
```

OpenSesame is a **resolver/broker**, not exclusive shell magic — mise/direnv/devcontainers can activate the same schema by calling `opensesame dev resolve` or the env-spec bridge.

Host credential-agent (`OPENSESAME_AGENT_URL`, default `127.0.0.1:18790`) issues short-lived session capabilities into WSL/devcontainers; containers do not receive refresh tokens or WebAuthn material.

```bash
cargo run -p opensesame-credential-agent
curl -s -X POST http://127.0.0.1:18790/v1/mint_capability \
  -H 'content-type: application/json' -d '{"audience":"devcontainer"}'
```

