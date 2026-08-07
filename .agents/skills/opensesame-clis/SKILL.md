---
name: opensesame-clis
description: Install, configure, initialize, and use OpenSesame host and client CLIs
---

# OpenSesame CLIs

## Host CLI (`opensesame`)

```bash
cargo build -p opensesame-cli -p opensesame-daemon
./target/debug/opensesame daemon install
./target/debug/opensesame daemon start
./target/debug/opensesame daemon status
./target/debug/opensesame login --flow device --no-browser --server http://127.0.0.1:8787
./target/debug/opensesame whoami --server http://127.0.0.1:8787
```

Env: `OPENSESAME_SERVER` (Host API, default `http://127.0.0.1:8787`), `OPENSESAME_DAEMON_URL`.

## Client / identity CLI (`opensesame-id`)

```bash
pnpm --filter @opensesame/cli start -- help
pnpm --filter @opensesame/cli start -- login --device --issuer http://127.0.0.1:8788
pnpm --filter @opensesame/cli start -- host health --host http://127.0.0.1:8787
```

Env: `OPENSESAME_ISSUER` (Identity API `:8788`), `OPENSESAME_HOST_API` (`:8787`).
