# Daemon local socket contract

Library crate `opensesame-daemon` (`crates/daemon`), run as
`opensesame daemon run` (ADR 0138: one native binary, roles as subcommands).

No `opensesame-credential-agent` crate or binary exists in this tree; the
daemon, which evolved from it, is the only local host agent.

| Item | Value |
|------|-------|
| Default TCP listen | `127.0.0.1:18790` (non-loopback refused unless `OPENSESAME_ALLOW_NONLOCAL=1`; legacy alias `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`) |
| Env TCP | `OPENSESAME_DAEMON_LISTEN` (alias `OPENSESAME_AGENT_LISTEN`) |
| Unix socket (optional) | `OPENSESAME_AGENT_SOCK` (e.g. `/tmp/opensesame-agent.sock`) |
| UDS peer UIDs | `OPENSESAME_DAEMON_ALLOWED_UIDS` (comma-separated; default: the daemon's own UID) |
| UDS-only | `OPENSESAME_DAEMON_UDS_ONLY=1` — skip TCP; requires `OPENSESAME_AGENT_SOCK` |
| Health | `GET /health`, `GET /health/live` |
| Toolbar | `GET /v1/toolbar/status` |
| Approve device | `POST /v1/toolbar/approve_device` → Host API |
| Approve claim | `POST /v1/toolbar/approve_claim`; needs `claim_token` (`OPENSESAME_CLAIM_TOKEN`), since a claim id is public. With a `claim_token` it completes the claim on the Host API (`/api/v1/agent-claims/{id}/complete`); without one it falls back to the Identity API (`/v1/claims/{id}/complete`), which needs an authenticated session. Both need the `user_code` |
| Operator L1 | `POST /v1/operator/invoke_l1` (materialize denied; an `intent_digest` is forwarded to `/api/v1/tasks/invoke`, otherwise the call goes to `/api/v1/intents`) |
| Mint capability | `POST /v1/mint_capability` |
| Other routes | `/v1/list_sessions`, `/v1/introspect_capability`, `/v1/revoke`, `/v1/discover`, `/v1/promote`, `/v1/invoke_through`, `/v1/mint`, `/v1/agent-capabilities/token` (single-use launch handle from an attested Unix-socket peer), `/v1/duress/peer/*`, the loopback proxies `/host/*` and `/identity/*`, and the vault-drive, plugin, tailnet-admin and `/v1/fill*` groups. `/v1/get_access_token` only answers `use_mint_capability` |
| Never | refresh token dump, WebAuthn material, secrets |

Host CLI: `opensesame daemon run|install|start|status|stop|logs`
Toolbar: `opensesame daemon info|approve-device|approve-claim`
The toolbar, mint, introspect, revoke, list, discover, promote, invoke,
duress-peer and vault-drive slot (open, list, close) routes require
`X-OpenSesame-Operator` from `OPENSESAME_OPERATOR_TOKEN` (`--operator-token`),
so the toolbar sends it. Without it the daemon answers 401 and nothing is
approved. Not operator-gated: the health probes, `/v1/get_access_token`, the
agent-capability launch exchange (an attested Unix-socket peer plus a launch
handle), the `/host/*` and `/identity/*` proxies (they drop the operator header
and leave authentication to the upstream), the vault-drive snapshot and part
routes (the slot's access key as a bearer), and the tailnet-admin routes (an
origin-bound pairing bearer, no operator path). `/v1/fill`, `/v1/fill/match`
and `/v1/fill/pair` take the paired extension's token, behind the
`browser-autofill` plugin switch; `/v1/fill/pair/approve`, `/v1/fill/pair/revoke`
and `/v1/fill/pairings` take the operator token. The plugin routes take the
operator token (a request with no `Origin`) or a bearer paired to the caller's
exact origin.

## Sandbox / compose note

Devcontainers and agent sandboxes should reach the **host broker only**:

- Set `OPENSESAME_DAEMON_API=http://host.docker.internal:18790` and/or mount `OPENSESAME_AGENT_SOCK`.
- Do not grant the container direct provider egress for credentials; use daemon-minted capabilities + Host API invoke.
- See `.devcontainer/devcontainer.json` and `docs/operators/local.md`.
