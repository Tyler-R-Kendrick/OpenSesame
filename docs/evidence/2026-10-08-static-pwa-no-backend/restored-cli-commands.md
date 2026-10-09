# `opensesame` CLI command map — restored (2026-10-09)

**Restoration note.** PR #865 (`cursor/delete-host-identity-daemon-b359`)
removed the Host API (`:8787`), Identity API (`:8788`) and daemon (`:18790`)
from the whole product and stripped this binary to relay/local paths. That
went further than requested: only the **PWA** was meant to become
backend-free (PR #861). The CLI and the backend planes are restored here from
the #861 tip (`03065913`); `apps/pages` stays static. This file replaces the
removal-era `removed-cli-commands.md`.

Global `--server` / `OPENSESAME_HOST_API` are back. The Host-backed verbs are
the defaults again; the local/relay rewrites #865 experimented with
(`vault_relay_sync`, local-only `doctor`/`tui`/`security`) are dropped in
favour of the restored Host-backed commands — `relay run` remains as the
optional ADR 0181 vault-relay peer beside them.

## Restored (Host / Identity / daemon-backed)

| Verb / path | Role |
|-------------|------|
| `login` / `logout` | Device/OIDC login against the Host; Host session file |
| `identity …` | Host session status, whoami, provider catalog |
| `access …` | Host-backed grants, connectors, resources, invoke, certs, lifecycle |
| `host run` | Full Host API on `:8787` (`crates/gateway`) |
| `daemon …` | Local daemon HTTP agent on `:18790` (`crates/daemon`), incl. tailnet admin |
| `worker run` | Workload connector host (`crates/worker`) |
| `hooks policy` / `decisions` / `approver …` | Organization agent-hooks policy on the Host (ADR 0159) |
| `config create` / `branch` / `diff` / `history` / `rollback` | Host config versioning API |
| `doctor` / `config …` / `tui` / `security …` | Host/Identity-backed doctor, project config, provider browser, breach ledger and scans |
| `vault secret get` / `list` | Host connection provider reads (human `--reveal` gate) |
| `vault sync push` / `pull` / `rebind-legacy` | Host `/api/v1/sync/*` E2EE blobs and legacy rebind |
| `vault crypto encrypt` / `decrypt` | Host connection crypto transform |

## Kept throughout (unchanged local / relay / P2P)

| Verb / path | Role |
|-------------|------|
| `relay run` | Optional vault-relay peer (ADR 0181) |
| `vault pass …` | Git-native sealed password store (`pass` parity) |
| `vault verify` / `ls` / `inspect` / `migrate` | Pages vault export / offline backup file |
| `ceremony` / `rotate` (under `access connectors`) | Host-backed connector ceremonies and web-login rotate recipes |
| `bridge …` | Password-manager bridges (feature-gated, ADR 0053) |
| `plugins …` | Runtime plugin install / enable (ADR 0150) |
| `hooks intercept` / `check` | Agent-hooks interceptor (ADR 0159) |
| `dev check` / `resolve` / `run` | `@env-spec` delivery (ADR 0006) |
| `password-agent` | 1Password helper workflows |
| `session` | Interactive first-run / setup ceremony |
| `helpers …` | Credential helper entry points |
| `config-files`, `init`, `completion` | Native `.env.schema` / shell completion |

## What stayed PWA-only

`apps/pages` remains a purely static web app: no `apps/pages/api/` serverless
routes, no `PAGES_IDENTITY_API` / `PAGES_HOST_API` / `PAGES_DAEMON_API`
stamps, no Endpoints panel, sessions served browser-to-browser over WebRTC
(ADR 0150), relay peer optional. The backend packages are restored for the
CLI/operator plane only and are not in the Pages bundle graph — see the
backend-free guard test under `apps/pages`.
