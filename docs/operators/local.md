# Local operator guide

## Prerequisites

- Rust 1.88 (`rust-toolchain.toml`)
- Optional: Docker/Podman for Compose profile
- Or user-space OpenFGA/OpenBao via `./scripts/dev/start-native-deps.sh` (no root)

## Run gateway

```bash
pnpm dev:host   # scripts/dev/dev-host.sh: sources scripts/dev/local-env.sh, then
                # cargo +1.88.0 run -p opensesame-cli -- host run --listen 127.0.0.1:8787
```

The Host refuses to start from a bare `host run`: it needs `OPENSESAME_ENV`
(or `OPENSESAME_ALLOW_DEV_DEFAULTS=1`, which also refuses any endpoint that is
not loopback), loopback `OPENSESAME_RESOURCE` and `OPENSESAME_ISSUER` for a
local-only run (their defaults are not loopback), and
`OPENSESAME_OPERATOR_TOKEN` and `OPENSESAME_CLAIM_PEPPER`, each at least 32
printable, non-space ASCII bytes with at least 8 distinct ones
(`crates/gateway/src/config.rs`, `required_secret`). `source
scripts/dev/local-env.sh` sets all of that, generating the secrets once as 0600
files under `~/.local/state/opensesame/development/`, so run the binary
directly after sourcing it:

```bash
source scripts/dev/local-env.sh
cargo run -p opensesame-cli -- host run --listen 127.0.0.1:8787
```

With live providers:

```bash
./scripts/dev/start-native-deps.sh
source .tools/run/env.sh
export OPENSESAME_PUBLIC_URL=http://127.0.0.1:18787   # the resource and Host API follow it
source scripts/dev/local-env.sh
cargo run -p opensesame-cli -- host run \
  --listen 127.0.0.1:18787
```

Full live drill: `./scripts/test/live-stack-test.sh`

Health on the full Host:

- `/health/live` — process up
- `/health/ready` — accepts traffic only when authority quorum OK
- `/health/authority` — quorum status (`{"ok": bool}`)
- `/health/degraded` — the same `{"ok": bool}` quorum answer
- `/health/providers` — OpenFGA/OpenBao wiring (operator bearer / `X-OpenSesame-Operator`); confirms agent API is `connection_ref`
- `/api/v1/connections` — agent-facing ConnectionRef list (never SecretRef)

## Relay profile

`OPENSESAME_GATEWAY_PROFILE=relay` (or `--profile relay`) serves the vault
relay and does not open the Host database. Unset, `opensesame host run` is
still the full Host API.

```bash
OPENSESAME_GATEWAY_PROFILE=relay \
  cargo run -p opensesame-cli -- host run --listen 127.0.0.1:8787
```

With `OPENSESAME_SERVICE_BINDINGS_FILE` unset, startup installs an empty
`vault_relay` binding set. A file that names another purpose, or an
operation other than `vault.relay.snapshot.read` and
`vault.relay.snapshot.write`, refuses to start.

Routes on this profile:

- `GET /health/live` — plain `ok`
- `GET /health/relay` — `{"profile":"relay","bindings":"vault_relay","durable":true}` plus `document` (`empty` or `vault_relay`)
- `GET` and `PUT /v1/vault-relay/{owner}/{slug}/snapshot`
- `GET` and `POST /v1/org-vaults`

Without issuer configuration, `x-opensesame-org-role` is `owner`, `admin`, or
`member` and `x-opensesame-principal` names the caller. A member may list an
organization vault and may not create or publish one. With those headers
absent, the slot key is the admission.

When both `OPENSESAME_VAULT_RELAY_ISSUER` and
`OPENSESAME_VAULT_RELAY_REGISTRATION_JWKS_JSON` are set, org directory and
publish policy use RS256 registration JWTs (`typ: vault-relay-registration+jwt`,
`aud: vault-relay`) from `Authorization: Bearer` or
`x-opensesame-registration`. Role and principal headers are ignored; a forged
`x-opensesame-org-role` cannot elevate a member token.

`/health/ready` and the rest of the Host API are absent here.

### Relay `mtls_required` (native sync peers)

Browsers still use plain HTTP and the slot key. Native peers set
`OPENSESAME_RELAY_TRANSPORT=mtls_required` and provision TLS material under
the `OPENSESAME_RELAY_TLS_*` prefix (same shape as the workload worker).
`OPENSESAME_SERVICE_BINDINGS_FILE` must name an exact `vault_relay` binding
for the peer. Snapshot routes then admit through that binding set only — not
the full Host transport resolver or database.

## Headless login

```bash
DEVCONTAINER=1 cargo run -p opensesame-cli -- login --flow auto --no-browser \
  --server http://127.0.0.1:8787
```

Approve the user code at Pages' `/device` route (signed in to the Identity API), whose `POST /v1/device/approve` proxies to Host `/api/v1/device/approve` with a **server-side** operator token — browsers never receive `OPENSESAME_OPERATOR_TOKEN`. Direct Host approve still accepts `X-OpenSesame-Operator` for CLI/daemon tooling.

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
OPENSESAME_ENV=development OPENSESAME_ALLOW_DEV_DEFAULTS=1 \
pnpm --filter @opensesame/control-plane start
```

`OPENSESAME_ALLOW_DEV_DEFAULTS` must be exactly `1` (or `0`), and
`OPENSESAME_ENV=development` alone is refused without an
`OPENSESAME_CLAIM_PEPPER`.

`OPENSESAME_PUBLIC_URL` must be the URL the **browser** really reaches: it is the
origin inside the origin-profile client id and the base of the one redirect URI
every upstream is registered against. Over Tailscale, that is the serve FQDN,
not loopback:

```bash
tailscale serve --bg 8788      # https://<host>.<tailnet>.ts.net
# then restart the broker with OPENSESAME_PUBLIC_URL set to that URL
```

### The deployed Pages vault over Tailscale Serve

Neither plane puts `https://tyler-r-kendrick.github.io` on a CORS allowlist for
you. The Identity API (`packages/control-plane/src/config.ts`) allows exactly the
origins in `OPENSESAME_CORS_ORIGINS`, and none when it is unset; list the Pages
origin there for the deployed vault to call it. The Host API validates the same
variable at start-up (exact HTTPS or loopback origins) but sets no CORS headers
from it (`crates/host-core/src/http_security.rs`, `apply_http_security`): a
browser reaches the Host only as a paired origin, and
`OPENSESAME_BROWSER_PAIRABLE_ORIGINS` refuses the shared GitHub origin
([Pages origin](pages-origin.md),
[local authority migration](local-authority-migration.md)). A browser console
full of

```
Access to fetch at 'https://<host>.<tailnet>.ts.net/identity/v1/health/live'
from origin 'https://tyler-r-kendrick.github.io' has been blocked by CORS
policy: No 'Access-Control-Allow-Origin' header is present
```

is the allowlist when the origin is missing from `OPENSESAME_CORS_ORIGINS`, and
the service being down otherwise. Look at the status on the same line:
`net::ERR_FAILED 502 (Bad Gateway)` means Tailscale Serve answered because the
process behind it was not listening, and Serve's own 502 carries no CORS
headers — the browser reports the missing header, the cause is the service
being down. Check from the machine that runs it:

```bash
curl -si http://127.0.0.1:8788/v1/health/live \
  -H 'Origin: https://tyler-r-kendrick.github.io' | grep -i 'access-control\|HTTP/'
curl -si http://127.0.0.1:8787/health/live | grep -i 'HTTP/'
tailscale serve status
```

A `200` with `access-control-allow-origin: https://tyler-r-kendrick.github.io`
on loopback and a `502` through Serve is a Serve target pointing at the wrong
port or a service that has exited; a `200` on loopback with no
`access-control-allow-origin` is an origin missing from
`OPENSESAME_CORS_ORIGINS` (an entry of `*` or `null` never matches, and both
planes refuse to start with one). The Host answers `/health/live` with no CORS
headers at all. The vault checks the Identity API about every 30 seconds (every
5 seconds, backing off toward 30, while it is down; a hidden or offline tab does
not probe), so the console repeats the same failure until the service is back;
the statusline shows the same fact once.

Point a static site at it. Nothing is registered in advance — the broker admits
an origin on its first `/auth`:

```js
const sesame = createOpenSesame({ issuer: "https://<broker>" });
await sesame.signIn({ returnTo: "/" });   // provider: sesame.signIn({ provider: "google" })
```

`examples/static-rp` is that page, ready to run:

```bash
pnpm --filter @opensesame/example-static-rp dev:4101
```

The OpenSesame PWA is a static export (ADR 0090). It does **not** stamp an
Identity/Host/daemon URL at deploy time. Device identity and guest/local seal
work with an empty `os-runtime-config.json`. Sessions are browser WebRTC; an
optional relay peer is separate (ADR 0181).

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
  -H "x-opensesame-operator: ${OPENSESAME_OPERATOR_TOKEN:?configure a generated operator secret}" \
  -d '{"quorum_ok":false}'
# subsequent invokes return 403
```

Device approval and claim completion require the native operator header (or `Authorization: Bearer operator:<token>`). Every deployment requires an explicitly generated operator secret. Browsers cannot present operator authority; use the native pairing ceremony instead.

`OPENSESAME_CLAIM_PEPPER` is required in every environment, like
`OPENSESAME_OPERATOR_TOKEN`: the Host refuses to start without it. User codes
are eight characters from a twenty-letter alphabet — roughly 2^35 possibilities
— so their stored digests are only out of reach while they are keyed by a
server-held pepper.

### Receipt signing key

Receipts are the non-repudiation record and the receipt store outlives the process,
so the signing key must too. Set `OPENSESAME_RECEIPT_SIGNING_KEY` to a base64
32-byte ed25519 seed; the gateway refuses to start without it in production
(`OPENSESAME_ENV=production`) or on a networked deployment (a listener or
endpoint that is not loopback), because an ephemeral key makes every receipt
written before a restart verify as `valid: false` — indistinguishable from
tampering.

```bash
export OPENSESAME_RECEIPT_SIGNING_KEY="$(openssl rand -base64 32)"
```

Locally the key may be omitted; the gateway logs a warning and generates one per run.

To rotate, move the old key's *public* half into
`OPENSESAME_RECEIPT_VERIFY_KEYS` (comma- or whitespace-separated base64 32-byte
ed25519 public keys) and set a new `OPENSESAME_RECEIPT_SIGNING_KEY`. Verification needs no secret,
so the retired seed can be destroyed while the receipts it signed stay verifiable.
`GET /api/v1/receipts/keys` publishes the accepted keys so a receipt holder can
check one without taking the gateway's word for it.

## Compose (when Docker available)

See `ops/compose/docker-compose.yml` for Postgres, OpenFGA, OpenBao, Keycloak, NATS and the gateway (`opensesame host run`); the worker (`opensesame worker run`) is under the `workload` profile. Signed provider callbacks are Host routes, not a separate service.

If Docker Engine cannot be installed (no elevated privileges), use the native binary path above — it exercises the same OpenFGA/OpenBao HTTP adapters.

### NATS / JetStream (TaskBus)

Compose already starts JetStream:

```bash
# from ops/compose — nats:2.11.4 with -js
# client port 4222 (monitoring 8222 inside the container network)
```

Point gateway and worker at the bus with placeholders only (no seeds or operator
creds in git). Defaults stay in-memory for unit tests.

```bash
# <!-- TASKBUS_ENV -->
export NATS_URL="nats://127.0.0.1:4222"          # or nats://nats:4222 in Compose
export OPENSESAME_TASKBUS="${OPENSESAME_TASKBUS:-nats}"  # memory | nats
# Stream / consumer names (fixed defaults, no environment variable):
#   stream:   OPENSESAME_EVENTS
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
# Install the bridge's dependency once (it is a pnpm workspace member)
pnpm install

# Schema check — metadata only, never secret plaintext
cargo run -p opensesame-cli -- dev check --schema tests/fixtures/demo.env.schema

# Resolve under agent policy (placeholders / handles; no materialize)
cargo run -p opensesame-cli -- dev --agent resolve --schema tests/fixtures/demo.env.schema

# Run a child with projected env
cargo run -p opensesame-cli -- dev --agent run --schema tests/fixtures/demo.env.schema -- env
```

OpenSesame is a **resolver/broker**, not exclusive shell magic — mise/direnv/devcontainers can activate the same schema by calling `opensesame dev resolve` or the env-spec bridge.

The host daemon (`opensesame daemon run`, crate `opensesame-daemon`; clients
find it at `OPENSESAME_DAEMON_API`, default `http://127.0.0.1:18790`, and it
binds `OPENSESAME_DAEMON_LISTEN`, default `127.0.0.1:18790`) issues short-lived
session capabilities into WSL/devcontainers; containers never receive refresh
tokens or WebAuthn material. The legacy `opensesame-credential-agent` binary
that used to do this has no source in this checkout; `OPENSESAME_AGENT_LISTEN`
remains an alias for `OPENSESAME_DAEMON_LISTEN`.
