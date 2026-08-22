# 1Password — craft bar / consume target (op CLI, Connect, CXF)

> Competitive reference for OpenSesame's **1Password consume paths** and the
> shared **FIDO CXF** format work
> ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md)). Never
> brand marks; never position OpenSesame as a 1Password replacement.

**Stance: craft bar for human vault habits, consume target for machine
access.** 1Password's clients and servers are proprietary, so serving them
is not merely expensive — it is impossible. Consuming a 1Password account
is clean and already partly built, and 1Password is a co-author of the FIDO
credential-exchange work that gives every vault a portable exit.

## Overview

[1Password](https://1password.com/) is the commercial polish leader in the
category, and — unusually for a consumer password manager — it built a
genuine developer and machine-access surface alongside the human one:
a first-class CLI, service accounts, secret *references* instead of
secret values in config, and a self-hosted REST server for infrastructure.

| Dimension | 1Password |
|-----------|-----------|
| Category | Commercial password manager + developer/machine secrets surface |
| Trust model | Account password + Secret Key (a device-held second factor mixed into key derivation); server holds ciphertext |
| Sync | 1Password's own hosted service; no self-hosted vault server |
| Agent story | Strong for *ops* — `op run`, service accounts, Connect; not an authorization model |
| License | Proprietary (clients, server, and format) |

## Feature surface

### `op` — the CLI

`op` is the surface most engineering teams actually touch:

- `op read 'op://<vault>/<item>/<field>'` — resolve one field.
- `op item get` / `op item list` / `op item create` — item CRUD as JSON.
- `op run -- <command>` — run a process with `op://` references in its
  environment resolved to values for that process only.
- `op inject -i template -o out` — substitute references into a file.
- `op signin` / biometric unlock against the desktop app.

### Service Accounts

A **service account** is a non-human identity with a token and a scoped set
of vaults. It is what makes `op` usable in CI without a desktop app or a
human unlock. The token is the credential; scope is per-vault.

### `op://` secret references

The `op://vault/item/field` URI is 1Password's most-copied idea: **config
files hold a reference, not a value**, and resolution happens at process
start.

OpenSesame's stance on this is recorded and unchanged
([REUSE.md](../../REUSE.md) "Evaluated / adapter-only"): `op://` is
**late-binding prior art that is insufficient**, because resolution ends by
**materializing the secret into the process environment**. It moves *when*
the secret appears, not *whether* it appears. ConnectionRef + Intent
([ADR 0005](../adr/0005-authority-handle-connectionref.md)) is the answer
that removes the value from the flow entirely: the agent gets a handle, the
Host performs the call, and a receipt records it.

### 1Password Connect — the self-hosted REST server

Connect is a container pair (an API server plus a sync service) that an
operator runs inside their own infrastructure. It holds a credentials file
and serves a REST API to callers presenting a bearer token:

| Endpoint | Role |
|---|---|
| `GET /v1/vaults` | List vaults the token can see |
| `GET /v1/vaults/{id}/items` | List items in a vault |
| `GET /v1/vaults/{id}/items/{itemId}` | Full item, **including plaintext field values** |
| `PATCH /v1/vaults/{id}/items/{itemId}` | JSON-Patch style updates |
| `GET /heartbeat`, `/health` | Liveness |

Authentication is `Authorization: Bearer <connect token>`.

**Connect returns plaintext field values to any authenticated caller.**
That is not a criticism — it is what a secrets API for Kubernetes and
Terraform has to do — but it fixes the plane. Under ADR 0052 §2 a Connect
consume path is a **human/ops-plane** path: run by an operator, against a
server the operator hosts, with the token treated as an operator
credential. It is never wired to the agent plane, and a Connect token is
never handed to an agent. The same reasoning classifies OpenSesame's own
Vault KV v2 read facade as ops-plane with a receipt per read.

### `.1pux` — the export archive

`.1pux` is a ZIP containing `export.data`, a JSON document carrying
accounts, vaults, categories, items, fields, and attachment references.
It is the highest-fidelity way out of 1Password (CSV loses cards, sections,
and custom fields).

**OpenSesame already reads it**: the `1password-1pux` adapter in
`apps/pages/src/lib/vault/import/formats/onepassword.ts`, with a
`1password-csv` adapter alongside it that explicitly warns the user to
export `.1pux` instead.

### CXF co-authorship

1Password is a co-author of the FIDO Alliance's **Credential Exchange**
work: **CXF**, the JSON format (Header / Account / Collection / Item, with
seventeen credential types), and **CXP**, the HPKE-based direct
device-to-device transport. CXF reached Proposed Standard in August 2025.

CXF matters more than any vendor export format because it is **the only
interchange format that carries passkeys faithfully**. A KDBX or CSV
export of a modern vault silently drops the credentials people increasingly
depend on; CXF does not. OpenSesame implements CXF **import and export** in
Pages. CXP — the transport half — targets 2026 and is a roadmap row, not a
build (ADR 0052 §4).

## Differentiators (why teams still pick 1Password)

- The best end-to-end polish in the category, on every platform, with
  family/team management that non-engineers actually use.
- The Secret Key genuinely raises the offline-attack floor above
  "password-only" designs.
- A developer surface that predates its competitors': `op run`, `op://`
  references, service accounts, Connect, and CI integrations that work.
- Serious investment in the passkey and credential-exchange standards.

## Differentiators (why OpenSesame does not compete as a PM)

- We are an authorization fabric with a sealed ceremony store, not a
  consumer vault product with a sync promise.
- **Agents never receive values.** `op run` and `op inject` end with a
  secret in a process; OpenSesame ends with a receipt.
- Host connectors, capability ceilings, grants, and the git-native sealed
  store are the product; item management is the part we keep minimal and
  local.
- No hosted vault service, and no ambition to be one.

## OpenSesame mapping

| 1Password concept | OpenSesame |
|---|---|
| `op read` / `op item get` shelling | Existing `HumanProviderPlan` `op` command plans in `crates/connector-host/src/providers.rs` — human plane, unchanged |
| Service account token | Catalog provider `1password` (`configuration`: `service_account_token` secret, `account`, `vault`); `OP_SERVICE_ACCOUNT_TOKEN` already an env alias in `crates/connection-detect` |
| `op://vault/item/field` | **Evaluated and rejected as the agent API** — materializes into the process; ConnectionRef + Intent instead ([REUSE.md](../../REUSE.md)) |
| `op run` env injection | Human/ops-plane convenience; the agent path is invoke-through (ADR 0048) |
| Connect REST (`/v1/vaults`, `/v1/vaults/{id}/items`, JSON-Patch, `/heartbeat`) | A human/ops-plane consume path — it returns plaintext to authenticated callers, so it is classified, not casually wired in |
| Connect's shape as a self-hosted secrets API | Prior art for OpenSesame's own **Vault KV v2 read facade** (default off, receipt per read, ops plane) |
| `.1pux` archive | **Already supported** — `1password-1pux` Pages import adapter |
| 1Password CSV | Supported, with a warning steering the user to `.1pux` |
| CXF | Pages CXF import **and** export; the only format carrying passkeys faithfully |
| CXP (HPKE transport) | Roadmap only (ADR 0052 §4) |
| Serving 1Password's own clients | **Impossible and not attempted** — proprietary clients, server, and format |

## Deliberate non-goals vs 1Password

- Do not attempt server or client compatibility. Unlike Bitwarden or
  KeePass, there is no public protocol or format to implement from, and
  the code is not open to study.
- Do not adopt `op://`-style reference resolution as the agent API.
- Do not clone the vault UI or brand. 1Password is craft bar for human
  habits only ([PRODUCT.md](../../PRODUCT.md),
  [DESIGN.md](../../DESIGN.md)).
- Do not treat a Connect token as agent-usable authority.

Related: [ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md),
[`bitwarden.md`](bitwarden.md), [`keepass.md`](keepass.md),
[`docs/architecture/pm-bridges.md`](../architecture/pm-bridges.md),
[REUSE.md](../../REUSE.md).
