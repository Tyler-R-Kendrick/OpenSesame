# `opensesame` CLI command map (2026-10-08)

Host API (`:8787`), Identity API (`:8788`), and the local daemon HTTP agent (`:18790`) are gone from this binary. Global `--server` / `OPENSESAME_HOST_API` are removed.

## Kept (unchanged local / relay / P2P)

| Verb / path | Role |
|-------------|------|
| `relay run` | Optional vault-relay peer (ADR 0181) |
| `vault pass …` | Git-native sealed password store (`pass` parity) |
| `vault verify` / `ls` / `inspect` / `migrate` | Pages vault export / offline backup file |
| `ceremony list` / `show` | Compiled connector ceremony catalog |
| `rotate recipe sign`, `rotate signer keygen` | Local Ed25519 web-login recipe signing |
| `bridge …` | Password-manager bridges (feature-gated, ADR 0053) |
| `plugins …` | Runtime plugin install / enable (ADR 0150) |
| `hooks intercept` / `check` | Agent-hooks interceptor (ADR 0159) |
| `dev check` / `resolve` / `run` | `@env-spec` delivery (ADR 0006) |
| `password-agent` | 1Password helper workflows |
| `session` | Interactive first-run / setup ceremony |
| `helpers …` | Credential helper entry points |
| `config-files`, `init`, `completion` | Native `.env.schema` / shell completion |

## Rewired (local-only; no Host / Identity / daemon HTTP)

| Verb / path | Was | Now |
|-------------|-----|-----|
| `doctor` | Host OAuth PRM + `/health/authority` | Sealed-store path health, optional `OPENSESAME_SERVICE_BINDINGS_FILE` relay binding validation, `age`/`gpg` on `PATH` |
| `config …` | Host project-config `PUT …/secrets` | Per-slug sealed store under `~/.config/opensesame/project-config/{slug}/` (`ls`, `keys`, `set`, `unset`, `import`) |
| `tui` | Host provider + connection browser | Ratatui browser over local sealed-store entry **names** only (`--path` / `--tomb`) |
| `security findings` | Host breach ledger | Local `breach-findings.json` from the last scan |
| `security scan` | Host `/api/v1/security/breach-scan` | Unlock local sealed store; k-anonymity check each entry via Pwned Passwords (no Host) |
| `security check` | Host `/api/v1/security/breach-check` | Hidden stdin/prompt → Pwned Passwords range API only |
| `vault secret get` / `list` | Host connection provider reads | Same as `vault pass show` / `ls` on the sealed store (human `--reveal` gate) |
| `vault sync push` / `pull` | Host `/api/v1/sync/*` E2EE blobs | PUT/GET sealed snapshot JSON on a vault-relay peer (`--base-url`, `--owner`, `--slug`, `--slot-key`, ADR 0181) |
| `vault crypto encrypt` / `decrypt` | Host connection crypto transform | Local `age` / cloud KMS CLIs via `opensesame-connector-host` plans (`--provider`, `--recipient` / `--identity`, …) |

`vault pass attach sync --to-dir` remains directory replication only (no Host attachment target).

## Removed (with reason)

| Verb / path | Reason |
|-------------|--------|
| `login` | Device/OIDC and Host session minting; no local principal without Identity/Host |
| `logout` | Cleared Host session file only meaningful with `login` |
| `identity …` | Host session status, whoami, provider catalog — no local session plane |
| `access …` | Host-backed grants, connectors, resources, invoke, certs, lifecycle |
| `host run` | Full Host API removed; use `relay run` for ADR 0181 peer only |
| `daemon …` | Local daemon HTTP agent (`:18790`) and tailnet admin routes removed from CLI |
| `hooks policy` / `decisions` / `approver …` | Organization policy on Host |
| `config create` / `branch` / `diff` / `history` / `rollback` | Host config versioning API; local `config` keeps ls/keys/set/unset/import only |
| `vault sync rebind-legacy` | Host E2EE migration against Host SQLite sync DB |
| `tui` (old data source) | Provider/connection lists required Host `/api/v1/*` |

Legacy top-level aliases `status`, `whoami`, `auth`, `provider` stay removed.
