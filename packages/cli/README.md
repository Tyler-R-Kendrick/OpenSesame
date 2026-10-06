# @opensesame/cli

The Client CLI, binary `opensesame-id` (alias `opensesame-identity`). It signs
in to the Identity API by device flow, loopback PKCE or as an anonymous guest,
keeps that session in a private file, polls claims, probes the Host API, and
opens a sealed vault export or offline backup to verify it or list its items
(names and paths, never values). It is the Client-plane counterpart of the Host
CLI, `opensesame` in [`apps/cli`](../../apps/cli).

## Where it fits

- **Used by:** people and scripts; nothing in the workspace imports it.
- **Builds on:** [`@opensesame/sdk-cli`](../sdk-cli) (device flow, loopback
  login, Identity API client, secret redaction),
  [`@opensesame/api-client`](../api-client) (the `host` verbs),
  [`@opensesame/vault-core`](../vault-core) (`openVaultFile`) and
  [`@opensesame/app-core`](../app-core) (the Node host, installed before a
  vault is opened).
- The session file is refused if anyone but its owner can read or write it.
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
| `vault retired-credentials status` | Authenticate as the current owner and show local trap/evidence metadata only |
| `vault retired-credentials enroll --acknowledge-password-verifier-risk [--response reject\|synthetic_decoy]` | Enroll a selected retired password; both credentials are read privately from the terminal |
| `vault retired-credentials remove <id>`, `vault retired-credentials clear` | Remove a trap or clear local observations with fresh current authentication |
| `vault new <account\|secret\|note\|card> --name <n>` | Create an item (`login` is accepted as `account`). An account's password is typed here as a stored (`manual`) method; typing one over a method keeps where its pepper goes |
| `vault copy <item> [--field secret\|rest\|username]` | Copy through the one password facade (ADR 0174): the whole password, or what comes before a pepper slot; `--field rest` copies what follows it. A pepper is never asked for or stored. A password an earlier version sealed under a pepper (`legacy_password`) is converted in the vault app |


Global flags: `--json`, `--issuer <url>`, `--api <url>`, `--client-id <id>`.
The library entry exports `runCli`, `parseArgs` and `helpText`.

| Variable | Default |
|---|---|
| `OPENSESAME_ISSUER` | `http://127.0.0.1:8788` |
| `OPENSESAME_IDENTITY_API` | the issuer |
| `OPENSESAME_HOST_API` | `http://127.0.0.1:8787` |
| `OPENSESAME_CLAIM_TOKEN` | none; used by `claim poll` |
| `OPENSESAME_STATE_DIR` | then `XDG_RUNTIME_DIR`, then `~/.config/opensesame`; holds `identity-session.json` |

Retired-password traps default to recording and rejecting the attempted unlock.
Human-readable status lists each trap ID and response policy; use that ID with
`remove`, or use `status --json` for local observation metadata. Management
currently requires one verified password protector with no additional factors.
Vaults needing a stronger owner ceremony are refused; do not remove factors to
enable this feature.
The optional synthetic response opens a separate fabricated vault for local
commands. Copy, export, import, and sharing remain denied in that realm. Every
command closes its session; current real credentials are required to open the
real vault again. Evidence is local to the state directory and can be lost or
bypassed. Retaining a password verifier allows offline guessing, including
passwords reused elsewhere; stale legitimate autofill can trigger it.

The local vault now uses the core's sealed filesystem and cross-process locks.
An existing `vault-kv.json` is migrated without overwriting newer sealed records
and retained as `vault-kv.json.migrated`. Retired traps cannot protect ciphertext
in an old snapshot that still decrypts with its original password.

Observation delivery uses the actual headless composition plan. An operator can
place an owner-only regular `os-runtime-config.json` (mode `0600`, at most
64 KiB) in the vault state directory, selected by `OPENSESAME_STATE_DIR` or the
Node vault default `~/.local/state/opensesame`. The file uses the shared runtime
configuration format with `capabilityComposition.instancePolicy`; its external
network policy and allowed service origins narrow delivery. Persisted local
policies and vault restrictions apply too. A malformed existing file fails
closed. The CLI does not load browser modules or claim a browser origin.

The headless transport fact permits only the fixed sealed-observation receiver
path; it is not an owner authentication grant. Pairing still requires fresh
real-owner authentication, a private provisioning file, destination confirmation
and a successful authenticated receiver test before enabling delivery. Local
evidence remains the default. A denied profile or destination prevents network
dispatch even when a receiver was previously enabled. Independent installed
canary validators resolve the same configured profile and retain local evidence
without opening a real vault; configuring a receiver remains a separate owner
action.

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
