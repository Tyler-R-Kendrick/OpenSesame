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
```

The Pages PWA embeds Turso WASM in the browser and persists its connector cache
to OPFS. It needs no database service. Admins can optionally set a remote Turso
sync URL in Pages **Settings**; the auth token is kept only for the current tab.
The Host remains the credential authority and does not put secrets in this cache.

Full live drill: `./scripts/live-stack-test.sh`

Health:

- `/health/live` — process up
- `/health/ready` — accepts traffic only when authority quorum OK
- `/health/authority` — quorum status
- `/health/degraded` — structured degradation (A0 still available)
- `/health/providers` — OpenFGA/OpenBao wiring (operator bearer / `X-OpenSesame-Operator`); confirms agent API is `connection_ref`
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

## Sign a static site in, with no backend of its own

A site with no server cannot hold a client secret and cannot talk to Google
directly (Google serves no CORS). It signs people in by pointing at a **broker**
that does both parts for it. An OpenSesame control plane is such a broker — the
same shape as the public ones a static site would otherwise use. The full
contract is `docs/architecture/federated-signin.md` §0.

Run the broker:

```bash
OPENSESAME_ORIGIN_CLIENTS_ENABLED=true \
OPENSESAME_PUBLIC_URL=http://127.0.0.1:8788 \
OPENSESAME_ENV=development OPENSESAME_ALLOW_DEV_DEFAULTS=true \
pnpm --filter @opensesame/control-plane start
```

`OPENSESAME_PUBLIC_URL` must be the URL the **browser** really reaches: it is the
origin inside the origin-profile client id and the base of the one redirect URI
every upstream is registered against. Over Tailscale, that is the serve FQDN,
not loopback:

```bash
tailscale serve --bg 8788      # https://<host>.<tailnet>.ts.net
# then restart the broker with OPENSESAME_PUBLIC_URL set to that URL
```

### The deployed Pages vault over Tailscale Serve

`https://tyler-r-kendrick.github.io` is on both planes' CORS allowlists by
default, and stays there when `OPENSESAME_CORS_ORIGINS` is overridden — the
Identity API (`apps/control-plane/src/config.ts`) and the Host API
(`crates/host-core`, `parse_cors_origins`) both append it. A browser console
full of

```
Access to fetch at 'https://<host>.<tailnet>.ts.net/identity/v1/health/live'
from origin 'https://tyler-r-kendrick.github.io' has been blocked by CORS
policy: No 'Access-Control-Allow-Origin' header is present
```

is therefore almost never the allowlist. Look at the status on the same line:
`net::ERR_FAILED 502 (Bad Gateway)` means Tailscale Serve answered because the
process behind it was not listening, and Serve's own 502 carries no CORS
headers — the browser reports the missing header, the cause is the service
being down. Check from the machine that runs it:

```bash
curl -si http://127.0.0.1:8788/v1/health/live \
  -H 'Origin: https://tyler-r-kendrick.github.io' | grep -i 'access-control\|HTTP/'
curl -si http://127.0.0.1:8787/api/v1/health \
  -H 'Origin: https://tyler-r-kendrick.github.io' | grep -i 'access-control\|HTTP/'
tailscale serve status
```

A `200` with `access-control-allow-origin: https://tyler-r-kendrick.github.io`
on loopback and a `502` through Serve is a Serve target pointing at the wrong
port or a service that has exited; a `200` on loopback with no
`access-control-allow-origin` is an `OPENSESAME_CORS_ORIGINS` set to `*` or
`null`, which production refuses to start with and which suppresses the
appended Pages origin. The vault polls every plane on a 30-second cadence
(5 seconds while one is down), so the console repeats the same failure until
the service is back; the statusline shows the same fact once.

Point a static site at it. Nothing is registered in advance — the broker admits
an origin on its first `/auth`:

```js
const sesame = createOpenSesame({ issuer: "https://<broker>" });
await sesame.signIn({ returnTo: "/" });   // provider: sesame.signIn({ provider: "google" })
```

`apps/example-static-rp` is that page, ready to run:

```bash
pnpm --filter @opensesame/example-static-rp dev:4101
```

For the OpenSesame PWA the broker URL arrives at deploy time rather than build
time, so a static deploy is repointed without a rebuild:

```bash
PAGES_IDENTITY_API=https://<broker> scripts/deploy-pages.sh
```

Without it the deploy ships an empty `os-runtime-config.json` and the vault says it is
not connected to an identity service — which is the honest answer, not a bug.

**Real providers.** Google, Microsoft, GitHub and Apple are configured on the
*broker*, never on the static site: set `OPENSESAME_PROVIDERS` plus each
provider's client id and secret, and register exactly one redirect URI with each
— `{OPENSESAME_PUBLIC_URL}/v1/federated/callback`. A site naming a provider
(`signIn({ provider: "google" })`) is sent straight there, with no OpenSesame
page in between; a site naming none gets the picker, because then there is a
choice to make.

## Fail-closed quorum drill

```bash
curl -X POST http://127.0.0.1:8787/api/v1/admin/authority \
  -H 'content-type: application/json' \
  -H "x-opensesame-operator: ${OPENSESAME_OPERATOR_TOKEN:-opensesame-dev-operator}" \
  -d '{"quorum_ok":false}'
# subsequent invokes return 403
```

Device approve and claim complete also require the same operator header (or `Authorization: Bearer operator:<token>`). Set `OPENSESAME_OPERATOR_TOKEN` in production — the `opensesame-dev-operator` default is local-only.

Set `OPENSESAME_CLAIM_PEPPER` in production too. User codes are eight characters
from a twenty-letter alphabet — roughly 2^35 possibilities — so their stored
digests are only out of reach while they are keyed by a server-held pepper. The
Host logs an error and runs without one if it is unset in production.

### Receipt signing key

Receipts are the non-repudiation record and the receipt store outlives the process,
so the signing key must too. Set `OPENSESAME_RECEIPT_SIGNING_KEY` to a base64
32-byte ed25519 seed; the gateway refuses to start without it when
`OPENSESAME_ENV=production`, because an ephemeral key makes every receipt written
before a restart verify as `valid: false` — indistinguishable from tampering.

```bash
export OPENSESAME_RECEIPT_SIGNING_KEY="$(openssl rand -base64 32)"
```

Locally the key may be omitted; the gateway logs a warning and generates one per run.

To rotate, move the old key's *public* half into
`OPENSESAME_RECEIPT_VERIFY_KEYS` (comma-separated base64 32-byte ed25519 public
keys) and set a new `OPENSESAME_RECEIPT_SIGNING_KEY`. Verification needs no secret,
so the retired seed can be destroyed while the receipts it signed stay verifiable.
`GET /api/v1/receipts/keys` publishes the accepted keys so a receipt holder can
check one without taking the gateway's word for it.

## Compose (when Docker available)

See `deploy/compose/docker-compose.yml` for Keycloak, Postgres, OpenFGA, OpenBao, NATS, gateway, worker, callback-edge.

If Docker Engine cannot be installed (no elevated privileges), use the native binary path above — it exercises the same OpenFGA/OpenBao HTTP adapters.

### NATS / JetStream (TaskBus)

Compose already starts JetStream:

```bash
# from deploy/compose — nats:2.11.4 with -js
# client port 4222 (monitoring 8222 inside the container network)
```

Point gateway and worker at the bus with placeholders only (no seeds or operator
creds in git). Defaults stay in-memory for unit tests.

```bash
# <!-- TASKBUS_ENV -->
export NATS_URL="nats://127.0.0.1:4222"          # or nats://nats:4222 in Compose
export OPENSESAME_TASKBUS="${OPENSESAME_TASKBUS:-nats}"  # memory | nats
# Stream / consumer names (configurable; defaults):
#   subjects: opensesame.events.>
#   durable:  opensesame-worker
# Callout namespace reserved: opensesame.callout.>
```

Auth callout terminates on **Host** (`:8787`), not Identity. Architecture:
[docs/architecture/task-bus-nats.md](../architecture/task-bus-nats.md)
([ADR 0042](../adr/0042-nats-taskbus-auth-callout-and-xkeys.md)). Never put NATS
operator seeds or xkey private keys in committed env files.

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

It is superseded by `opensesame-daemon`: it refuses to start without
`OPENSESAME_LEGACY_CREDENTIAL_AGENT=1`, and every `/v1/*` route requires the
operator bearer, since any co-resident process can reach loopback.

```bash
OPENSESAME_LEGACY_CREDENTIAL_AGENT=1 cargo run -p opensesame-credential-agent
curl -s -X POST http://127.0.0.1:18790/v1/mint_capability \
  -H "authorization: Bearer operator:${OPENSESAME_OPERATOR_TOKEN}" \
  -H 'content-type: application/json' -d '{"audience":"devcontainer"}'
```
