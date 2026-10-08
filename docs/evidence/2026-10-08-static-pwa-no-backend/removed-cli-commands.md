# Removed `opensesame` CLI commands (2026-10-08)

The native binary no longer speaks to Host API (`:8787`), Identity API (`:8788`), or the local daemon HTTP agent (`:18790`). Only local sealed-store work, P2P/relay, bridges, plugins, dev env-spec, hooks intercept, and helper entry points remain.

Global `--server` / `OPENSESAME_HOST_API` were removed; nothing in this binary calls those bases anymore.

## Top-level verbs removed

| Verb | Why |
|------|-----|
| `login` | Device/OIDC login against Host `/api/v1/device/*` |
| `logout` | Cleared Host session file only meaningful with login |
| `doctor` | Host OAuth protected-resource and authority health probes |
| `access` | Entire Host-backed grants, connectors, resources tree |
| `identity` | Host session status, whoami, providers |
| `config` | Host project-config secret store (`PUT …/secrets`) |
| `tui` | Host provider/connection browser over HTTP |
| `security` | Host breach findings, scan, and check APIs |
| `host run` | Replaced by relay-only gateway role elsewhere |
| `daemon run` / `daemon status` / `daemon logs` / `daemon start` / `daemon stop` | Local daemon HTTP API removed from CLI |
| `daemon tailnet …` | Tailnet admin routes on daemon |
| `daemon drive` / `daemon fill` / `daemon toolbar` | Daemon operator HTTP tools |

## Nested verbs removed (formerly under `access`)

| Path | Why |
|------|-----|
| `access grants local-authority` | Host operator pair/launch ceremonies |
| `access grants lease` | Host connection lease acquire/revoke |
| `access grants task` | Host task-scoped authority |
| `access grants intent` | Host frozen intent create/invoke |
| `access sessions receipt verify` | Host receipt verification |
| `access connectors connect` | Host connector registration browser flow |
| `access connectors connection` | Host connection CRUD and rotate |
| `access connectors export` / `import` | Host connection portability |
| `access connectors rotate runs` / `watch` / `attach` / `hooks` | Host web-login run observation |
| `access connectors rotate recipe ls` / `get` / `put` / `rm` / `canary` | Host-held recipe store |
| `access connectors rotate signer ls` / `add` / `rm` | Host signer pin list |
| `access resources invoke` | Host ConnectionRef invoke |
| `access resources cert` | Host-managed TLS CA/issue/list/key |
| `access resources lifecycle` | Host expiry hooks and deliveries |

`access connectors ceremony` moved to top-level `ceremony`.

Local parts of rotate moved to top-level `rotate recipe sign` and `rotate signer keygen` only.

## Nested verbs removed (formerly under `identity`)

| Path | Why |
|------|-----|
| `identity status` | Host `/health/ready` + local session |
| `identity whoami` | Host `/api/v1/whoami` |
| `identity auth doctor` | Same as top-level `doctor` |
| `identity providers list` / `test` | Host provider catalog |

Legacy aliases `status`, `whoami`, `auth`, `provider` no longer rewrite.

## Nested verbs removed (formerly under `vault`)

| Path | Why |
|------|-----|
| `vault secret get` / `list` | Host connection provider reads |
| `vault sync push` / `pull` / `migrate` | Host E2EE sync blobs |
| `vault crypto encrypt` / `decrypt` | Host connection crypto transform |

`vault pass attach sync` without `--to-dir` (Host attachment replicate) removed; `--to-dir` local copy remains.

## Hooks (Host-backed) removed

| Path | Why |
|------|-----|
| `hooks policy get` / `put` / `preset` | Organization policy on Host |
| `hooks decisions` | Host interceptor audit feed |
| `hooks approver get` / `put` | Host approver configuration |

`hooks intercept` and `hooks check` remain local.

## Kept (local / relay / P2P)

- `relay run` — vault-relay peer only
- `vault` — verify/ls/inspect/migrate and full `pass` tree (sealed store)
- `ceremony list` / `show` — compiled catalog
- `rotate recipe sign`, `rotate signer keygen` — local Ed25519 signing
- `bridge` — password-manager bridges (feature-gated)
- `plugins` — install/enable/pair files locally (`pair`/`unpair` write pairing records, no daemon HTTP)
- `hooks intercept` / `check`
- `dev check` / `resolve` / `run`
- `password-agent`
- `session` (interactive first-run)
- `helpers`, `config-files`, `init`, `completion`
