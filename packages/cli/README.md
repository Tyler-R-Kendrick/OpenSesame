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
| `vault verify <file>`, `vault ls <file>` | Open a vault export or offline backup |

Global flags: `--json`, `--issuer <url>`, `--api <url>`, `--client-id <id>`.
The library entry exports `runCli`, `parseArgs` and `helpText`.

| Variable | Default |
|---|---|
| `OPENSESAME_ISSUER` | `http://127.0.0.1:8788` |
| `OPENSESAME_API_URL` | the issuer |
| `OPENSESAME_HOST_API` | `http://127.0.0.1:8787` |
| `OPENSESAME_CLAIM_TOKEN` | none; used by `claim poll` |
| `OPENSESAME_STATE_DIR` | then `XDG_RUNTIME_DIR`, then `~/.config/opensesame`; holds `identity-session.json` |

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
