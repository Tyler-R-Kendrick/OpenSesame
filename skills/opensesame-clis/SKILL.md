---
name: opensesame-clis
description: Install, configure, initialize, and use OpenSesame host and client CLIs
---

# OpenSesame CLIs

Ports: Host API **8787**, Identity API **8788**, Daemon **18790**.

## Install

```bash
# Host CLI: one native binary; the daemon, Host API and worker are its roles (ADR 0138)
cargo build -p opensesame-cli
./target/debug/opensesame daemon install   # prints how to run the daemon (no files copied)

# Client / identity CLI (TypeScript, run through tsx; no build step)
pnpm install
pnpm --filter @opensesame/cli start -- --help
```

## Configure

```bash
# Endpoint names are shared (spec/config/endpoints.json)
export OPENSESAME_HOST_API=http://127.0.0.1:8787       # both CLIs (--server / --host)
export OPENSESAME_DAEMON_API=http://127.0.0.1:18790    # opensesame daemon … (--url)
export OPENSESAME_IDENTITY_API=http://127.0.0.1:8788   # client CLI (--api)
export OPENSESAME_ISSUER=http://127.0.0.1:8788         # OIDC issuer (client CLI, --issuer)
export OPENSESAME_OPERATOR_TOKEN=…                     # 32+ characters; daemon operator routes, and `daemon run` / `host run` refuse to start without it; keep it out of argv
export OPENSESAME_ENV=development                      # deployment mode (development | test | production); `daemon run` / `host run` refuse to start without one
```

`source scripts/dev/local-env.sh` sets the mode and loopback URLs and generates the
operator token, claim pepper and signing keys (under
`~/.local/state/opensesame/development/`, never printed); `pnpm dev:host`,
`dev:daemon` and `dev:cli` source it. The Host also needs `OPENSESAME_CLAIM_PEPPER`
and a loopback `OPENSESAME_RESOURCE` / `OPENSESAME_ISSUER` for a local run. The
Identity API needs a mode and `OPENSESAME_CLAIM_PEPPER`, or
`OPENSESAME_ALLOW_DEV_DEFAULTS=1` (exactly `1`).

## Init

```bash
source scripts/dev/local-env.sh
./target/debug/opensesame daemon start
./target/debug/opensesame daemon status
./target/debug/opensesame host run --listen 127.0.0.1:8787   # or `pnpm dev:host`
# In a shell that has not sourced local-env.sh:
OPENSESAME_ENV=development OPENSESAME_ALLOW_DEV_DEFAULTS=1 \
  pnpm --filter @opensesame/control-plane start               # :8788
```

## Use

```bash
# Host
./target/debug/opensesame login --flow device --no-browser --server http://127.0.0.1:8787
./target/debug/opensesame whoami --server http://127.0.0.1:8787
./target/debug/opensesame daemon logs
./target/debug/opensesame daemon stop
./target/debug/opensesame dev check --schema tests/fixtures/demo.env.schema
./target/debug/opensesame dev resolve --mode agent --schema tests/fixtures/demo.env.schema
./target/debug/opensesame daemon approve-device --user-code ABCD-EFGH
OPENSESAME_CLAIM_TOKEN=osc_clm_… ./target/debug/opensesame daemon approve-claim --claim-id clm_…

# Tailnet device management (ADR 0169; docs/operators/tailnet-devices.md).
# The secret comes from a file or stdin, never an argument; a minted auth key prints once.
./target/debug/opensesame daemon tailnet connect --tailnet example.com --api-token --secret-file ./token
./target/debug/opensesame daemon tailnet pair --origin https://vault.example.com --role read --no-qr
./target/debug/opensesame daemon tailnet devices
./target/debug/opensesame daemon tailnet approve nSAMSPHONECNTRL
./target/debug/opensesame daemon tailnet mint --description "lab runners" --tag tag:ci --preauthorized
./target/debug/opensesame daemon tailnet audit

# Connectors (Vercel-shaped: service/name). `connect token` prints a ConnectionRef, never a provider secret.
./target/debug/opensesame connect create github --help
./target/debug/opensesame connect create github --name acme-gh
./target/debug/opensesame connect create openai --name prod --data @key.json
./target/debug/opensesame connect attach github/acme-gh --project prj_…
./target/debug/opensesame connect list
./target/debug/opensesame connect inspect github
REF=$(./target/debug/opensesame connect token github/acme-gh)
./target/debug/opensesame invoke --connection-ref "$REF" --operation get --resource /user

# Client
pnpm --filter @opensesame/cli start -- login --device --issuer http://127.0.0.1:8788
pnpm --filter @opensesame/cli start -- host health --host http://127.0.0.1:8787
pnpm --filter @opensesame/cli start -- host discover --host http://127.0.0.1:8787
```
