---
name: opensesame-clis
description: Install, configure, initialize, and use OpenSesame host and client CLIs
---

# OpenSesame CLIs

Ports: Host API **8787**, Identity API **8788**, Daemon **18790**.

## Install

```bash
# Host CLI + daemon
cargo build -p opensesame-cli -p opensesame-daemon
./target/debug/opensesame daemon install   # copies binary to ~/.local/bin when present

# Client / identity CLI
pnpm install
pnpm --filter @opensesame/cli build
```

## Configure

```bash
export OPENSESAME_SERVER=http://127.0.0.1:8787          # host CLI
export OPENSESAME_DAEMON_URL=http://127.0.0.1:18790
export OPENSESAME_ISSUER=http://127.0.0.1:8788          # client CLI
export OPENSESAME_HOST_API=http://127.0.0.1:8787
export OPENSESAME_ENV=development                       # or set OPENSESAME_CLAIM_PEPPER
```

## Init

```bash
./target/debug/opensesame daemon start
./target/debug/opensesame daemon status
pnpm --filter @opensesame/control-plane start   # :8788
./target/debug/opensesame-gateway --listen 127.0.0.1:8787
```

## Use

```bash
# Host
./target/debug/opensesame login --flow device --no-browser --server http://127.0.0.1:8787
./target/debug/opensesame whoami --server http://127.0.0.1:8787
./target/debug/opensesame daemon logs
./target/debug/opensesame daemon stop
./target/debug/opensesame dev check --schema fixtures/demo.env.schema
./target/debug/opensesame dev resolve --agent --schema fixtures/demo.env.schema

# Client
pnpm --filter @opensesame/cli start -- login --device --issuer http://127.0.0.1:8788
pnpm --filter @opensesame/cli start -- host health --host http://127.0.0.1:8787
pnpm --filter @opensesame/cli start -- host discover --host http://127.0.0.1:8787
```
