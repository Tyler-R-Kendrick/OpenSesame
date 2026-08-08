# Daemon local socket contract

Canonical binary: `opensesame-daemon` (`apps/daemon`).

Legacy: `opensesame-credential-agent` remains for compatibility; prefer daemon.

| Item | Value |
|------|-------|
| Default TCP listen | `127.0.0.1:18790` (non-loopback refused unless `OPENSESAME_ALLOW_NONLOCAL=1`; legacy alias `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`) |
| Env TCP | `OPENSESAME_DAEMON_LISTEN` (alias `OPENSESAME_AGENT_LISTEN`) |
| Unix socket (optional) | `OPENSESAME_AGENT_SOCK` (e.g. `/tmp/opensesame-agent.sock`) |
| UDS-only | `OPENSESAME_DAEMON_UDS_ONLY=1` — skip TCP; requires `OPENSESAME_AGENT_SOCK` |
| Health | `GET /health` |
| Toolbar | `GET /v1/toolbar/status` |
| Approve device | `POST /v1/toolbar/approve_device` → Host API |
| Approve claim | `POST /v1/toolbar/approve_claim` → Identity API |
| Operator L1 | `POST /v1/operator/invoke_l1` (materialize denied) |
| Mint capability | `POST /v1/mint_capability` |
| Never | refresh token dump, WebAuthn material, secrets |

Host CLI: `opensesame daemon install|start|status|stop|logs`  
Toolbar: `opensesame-toolbar health|status|approve-device|approve-claim`

## Sandbox / compose note

Devcontainers and agent sandboxes should reach the **host broker only**:

- Set `OPENSESAME_AGENT_URL=http://host.docker.internal:18790` and/or mount `OPENSESAME_AGENT_SOCK`.
- Do not grant the container direct provider egress for credentials; use daemon-minted capabilities + Host API invoke.
- See `deploy/devcontainer/devcontainer.json` and `docs/operators/local.md`.
