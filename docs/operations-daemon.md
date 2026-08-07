# Daemon local socket contract

Canonical binary: `opensesame-daemon` (`apps/daemon`).

Legacy: `opensesame-credential-agent` remains for compatibility; prefer daemon.

| Item | Value |
|------|-------|
| Default listen | `127.0.0.1:18790` |
| Env | `OPENSESAME_DAEMON_LISTEN` (alias `OPENSESAME_AGENT_LISTEN`) |
| Health | `GET /health` |
| Toolbar | `GET /v1/toolbar/status` |
| Mint capability | `POST /v1/mint_capability` |
| Never | refresh token dump, WebAuthn material, secrets |

Host CLI: `opensesame daemon install|start|status|stop`
Toolbar: `opensesame-toolbar health|status`
