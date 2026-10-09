# @opensesame/cli

The Client CLI, binary `opensesame-id` (alias `opensesame-identity`; both names
are `bin` entries of this package, pointing at `src/bin.ts`). It signs
in to the Identity API by device flow, loopback PKCE or as an anonymous guest,
keeps that session in a private file, polls claims, probes the Host API, and
opens a sealed vault export or offline backup to verify it or list its items
(names and paths, never values). It also serves the two MCP servers as
`opensesame-id mcp host|client`. It is the Client-plane counterpart of the Host
CLI, `opensesame` in [`apps/cli`](../../apps/cli).

## Where it fits

- **Used by:** people and scripts; nothing in the workspace imports it.
- **Builds on:** [`@opensesame/sdk-cli`](../sdk-cli) (device flow, loopback
  login, Identity API client, secret redaction),
  [`@opensesame/api-client`](../api-client) (the `host` verbs),
  [`@opensesame/vault-core`](../vault-core) (`openVaultFile`),
  [`@opensesame/app-core`](../app-core) (the Node host, installed before a
  vault is opened) and, for the `mcp` verb, [`@opensesame/mcp-host`](../mcp-host)
  and [`@opensesame/mcp-client`](../mcp-client), each loaded only when asked for.
- The session file is refused if anyone but its owner can read or write it
  (a POSIX mode check; it is skipped on Windows).
- `vault verify` and `vault ls` read the master password from a terminal
  only, and never print a field value.
- `--json` output redacts secrets.

## Surface

| Command | What it does |
|---|---|
| `login [--device\|--loopback\|--no-browser\|--anonymous] [--qr\|--no-qr]` | Sign in; `--anonymous` (alias `--guest`) starts a provisional guest |
| `auth status`, `logout`, `whoami` | Inspect or end the session |
| `project create --temporary [--name <name>]` | Create a temporary project |
| `claim poll <claimId> --token <osc_clm_…>` | Poll a claim |
| `agent init --anonymous [--name <name>]` | Register an anonymous agent |
| `host health [--host <url>]`, `host discover [--host <url>]` | Host API health and discovery |
| `vault verify <file>`, `vault ls <file>` | Open a vault export or offline backup; lists `account` items (a legacy `login` file lists as `account`) by name and path, never a method secret |
| `vault list`, `vault new <account\|secret\|note\|card> --name <n>`, `vault set\|edit <item>` | List the local vault (id, kind, name); create an item (`login` is accepted as `account`); change `--name`, `--username` or `--secret`. An account's password is typed here as a stored (`manual`) method; typing one over a method keeps where its pepper goes |
| `vault copy <item> [--field secret\|rest\|username]` | Copy through the one password facade (ADR 0174): the whole password, or what comes before a pepper slot; `--field rest` copies what follows it. A pepper is never asked for or stored. A password an earlier version sealed under a pepper (`legacy_password`) is converted in the vault app |
| `vault import <file>`, `vault export [--out <file>]`, `vault share <item>`, `vault sync [--pair <code>]` | Merge or write a sealed export of the local vault; share a secret once (link and code); sync with a tailnet drive (ADR 0144) |
| `mcp host\|client` | Serve the host- or client-facing MCP tools on stdio (`OPENSESAME_MCP_TRANSPORT=http` for the host server's loopback HTTP); see [`mcp-host`](../mcp-host) and [`mcp-client`](../mcp-client) |

Global flags: `--json`, `--issuer <url>`, `--api <url>`, `--client-id <id>`.
The library entry exports `runCli`, `parseArgs`, `helpText`, `SessionFileSchema`
and `GlobalFlagsSchema`.

| Variable | Default |
|---|---|
| `OPENSESAME_ISSUER` | `http://127.0.0.1:8788` |
| `OPENSESAME_IDENTITY_API` | the issuer |
| `OPENSESAME_HOST_API` | `http://127.0.0.1:8787` |
| `OPENSESAME_CLAIM_TOKEN` | none; used by `claim poll` |
| `OPENSESAME_STATE_DIR` | then `XDG_RUNTIME_DIR`, then `~/.config/opensesame`; holds `identity-session.json` |

## 1Password workflows

The top-level `find`, `inventory`, `audit`, `create api-credential`, `password`,
`read`, `run`, `env` and `service-account` commands use the shared
`app-core/lib/password-agent` workflow engine and the installed `op` CLI.

```bash
opensesame-id find openai stripe
opensesame-id create api-credential --title "OpenAI API Key" --vault Automation --stdin
opensesame-id password "Example Login" --vault Automation --stdin --apply
opensesame-id run --env "OPENAI_API_KEY=op://Automation/OpenAI API Key/credential" -- node app.js
opensesame-id env write .env.tpl "OPENAI_API_KEY=op://Automation/OpenAI API Key/credential"
opensesame-id env run .env.tpl -- node app.js
opensesame-id service-account setup --vault Automation --create-vault --write --save-vault Personal
```

Creation and password changes accept secrets from a pipe or `--clipboard`,
verify every write by reading it back, and never retry a write. Passwords retain
exact bytes; `password` compares unless `--apply` is supplied. Discovery and
receipts contain metadata and references. `read` and `env resolve` refuse unless
stdin and stdout are both TTYs, you pass `--reveal`, `op://` reads also need
`--desktop`, and no agent context is detected; each allowed use writes a
value-free receipt to stderr. Prefer `opensesame-id run` / `os run` with
`--env NAME=op://…` or `os://…` (1Password-style references), or `env run`, for
scripts — the same `run` wrapper pattern as `op run`, `infisical run`, and
`doppler run`. `env resolve` is deprecated in favor of `env run`. A future
broker lane (network stand-in swap) extends `run`, not a separate top-level
command. The selected child receives
injected secrets and
its exit status is preserved; the provider service token is removed before
that child starts.

Authentication selects `OP_SERVICE_ACCOUNT_TOKEN`, then a saved service account,
then desktop authentication. `--desktop` bypasses tokens. An unreadable saved
account fails closed. `service-account connect --stdin`, `status`, `recover` and
`forget` manage local unattended access; forgetting does not revoke the remote
account. macOS stores the token in Keychain, Windows uses DPAPI, and Linux uses
an encrypted file with the existing owner-only at-rest key. `doctor` checks
installation and settings without opening the token store or accessing vaults.

## Develop

```bash
pnpm --filter @opensesame/cli start help            # prints the command list
pnpm --filter @opensesame/cli test
pnpm --filter @opensesame/cli typecheck
```

`src/capability-parity.test.ts` checks the verbs against
[`@opensesame/capability-registry`](../capability-registry); a new verb needs
a registry entry.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology
- [ADR 0133](../../docs/adr/0133-shared-app-core.md) §5 — the CLI as an
  app-core host
- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent-surface parity
- [`skills/opensesame-clis`](../../skills/opensesame-clis/SKILL.md)

Private HTTPS requests use a human-approved lease. In an interactive terminal,
review the exact destination and credential before approving with desktop authentication:

```sh
opensesame-id lease approve https://api.example.com/v1/me --secret op://Automation/Example/credential --desktop --expires-in 10m --uses 1
opensesame-id request https://api.example.com/v1/me --secret op://Automation/Example/credential --lease <lease-id>
opensesame-id lease status <lease-id>
opensesame-id lease list
opensesame-id lease revoke <lease-id>
```

The durable SQLite store contains authority metadata and budgets, never credential
values or response bodies. Grants bind the exact URL fingerprint, reference,
header, prefix, local principal, and credential version. Every attempt claims a use
atomically before reading, rechecks the version, and consumes that use even if the
read or request fails. There are no automatic retries. Defaults are ten minutes
and one use; maximums are one hour and ten uses. Requests require HTTPS on port
443, exclusively public DNS answers, pinned TLS, and bounded responses and time.
Output contains only a receipt, including a safe numeric echo count.

Credential helpers resolve through absolute executable PATH entries outside the
current directory. Their working directory and interpreter startup environment
are controlled before credentials enter the process. The explicitly selected
child runs in the caller's working directory after the provider token is removed.
