# Passbolt — study / consume target (per-user OpenPGP)

> Competitive reference for OpenSesame's **Passbolt consume-client** and the
> Passbolt server-compat roadmap row
> ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md)). Never
> brand marks. Passbolt is AGPL-3.0 and **study-only**.

**Stance: study / consume target.** Passbolt is a self-hosted team password
manager whose data model — one OpenPGP encryption per user per secret — is
the most rigorous in this competitive set and the most expensive to serve.
OpenSesame consumes a Passbolt instance as a brokered upstream (stretch);
serving Passbolt's own clients is a costed roadmap row, not a plan.

## Overview

[Passbolt](https://www.passbolt.com/) is an open-source, self-hostable
password manager for teams, built on OpenPGP rather than on a bespoke
envelope format. Every user has a personal OpenPGP keypair; the server
stores only PGP messages it cannot read. The browser extension holds the
private key and does all crypto in-page.

| Dimension | Passbolt |
|-----------|----------|
| Category | Self-hosted team password manager |
| Trust model | Per-user OpenPGP; the server holds ciphertext and never a decryption key |
| Sharing | Re-encrypt the secret to each recipient's public key, client-side |
| API | Documented REST + OpenAPI; JSON envelopes carrying PGP messages |
| Agent story | None in the product sense; the API is human/extension-facing |
| License | AGPL-3.0 (community edition) |

## Feature surface

### The data model is the differentiator, and the cost

A Passbolt "secret" is not one ciphertext with an ACL. It is **one PGP
message per (resource, user)** — the API's `/secrets/resource/{id}.json`
returns a payload whose `data` is a literal
`-----BEGIN PGP MESSAGE----- … -----END PGP MESSAGE-----` block, encrypted
to the requesting user's key.

The consequence is structural: **sharing a resource with N users is O(N)
client-side re-encryption.** The sharing client must fetch every
recipient's public key, decrypt the secret locally, encrypt it N times, and
POST the resulting set. Revoking access, rotating a key, or adding a member
to a group has the same shape. There is no server-side "grant" that avoids
it, because the server has nothing to grant with. This is a genuinely
strong property — the server is not a trusted party — bought at a
throughput cost that shapes every other design decision in the product.

### Authentication: two flows, one preferred

**GPGAuth (legacy)** is a three-stage challenge/response over OpenPGP:
verify the server's identity, verify the user's identity, then obtain a
session. It predates the JWT flow and remains for compatibility.

**JWT (preferred)** — the flow a consume-client implements:

1. The client builds a challenge object carrying `version`, `domain`, a
   client-generated `verify_token`, and `verify_token_expiry`.
2. The client **signs the challenge with its own private key, then
   encrypts it to the server's public key**, and POSTs it to
   `/auth/jwt/login.json` with the user id.
3. The server decrypts, verifies the signature, and replies with a
   response **encrypted to the user's public key** containing the access
   token, a refresh token, and the same `verify_token` echoed back.
4. The client decrypts and **checks that `verify_token` matches what it
   generated**. That check is what proves the server holds the private key
   for the fingerprint the client pinned — mutual authentication, not just
   "the TLS cert was valid."
5. Refresh tokens are **single-use and rotating**: each refresh issues a
   new one and invalidates the old.

Two properties matter for OpenSesame. First, the flow requires the user's
**private key and its passphrase** at the client — so the passphrase is
prompted on a TTY at the human plane, held in `secrecy::SecretBox`,
zeroized, and never persisted. Second, the extension pins only a
**user-supplied server URL plus the server's PGP fingerprint** — there is
no vendor-hosted component in the trust path — which is precisely why a
third-party Passbolt-compatible server is viable in a way a
Bitwarden-compatible one is not (see [`bitwarden.md`](bitwarden.md) and
ADR 0052 §4 on the push-relay installation ID).

### API surface

Documented, with a published OpenAPI description. The endpoints a
consume-client needs:

| Endpoint | Role |
|---|---|
| `/auth/jwt/login.json`, `/auth/jwt/refresh.json` | The flow above |
| `/resources.json` | Resource (item) metadata, including resource types |
| `/secrets/resource/{id}.json` | The PGP message for one resource, for this user |
| `/folders.json` | Folder tree |
| `/groups.json`, `/users.json` | Membership |
| `/permissions/…` | Per-resource ACL as Passbolt models it |
| `/comments/…` | Per-resource comments |

Resource types are extensible (password-only, password-and-description,
TOTP, and custom types), which means a reader must branch on the resource
type rather than assume a shape.

### The v5 metadata cliff

Passbolt v4 encrypts secret *values*; resource **metadata** — names, URIs,
usernames, folder structure — is stored in the clear so the server can
search and sort. Passbolt v5 **encrypts metadata too**, using shared
metadata keys.

This is a **compat cliff, not a migration slope**. A client or server
written for the v4 shape does not degrade gracefully against v5: it sees
encrypted blobs where it expects names. OpenSesame's consume-client
therefore **detects v5 metadata encryption and refuses with a named error**
pointing at this document, rather than best-effort parsing that would
silently produce a vault full of ciphertext-looking titles.

### KDBX is Passbolt's own recommended export

Passbolt's documented export formats include **KDBX**, and it is the one
their docs recommend for a full-fidelity extraction (CSV loses structure).

That is a strategically pleasant fact: **OpenSesame's KDBX support ingests
Passbolt on day one**, with no Passbolt-specific code, no API credentials,
and no network access. `opensesame pass import-kdbx` and the Pages KDBX
adapter both read a Passbolt export directly. The native consume-client is
therefore an *upgrade* (live, brokered, no manual export step), not the
prerequisite for supporting Passbolt users.

## Differentiators (why teams still pick Passbolt)

- **The server is not a trusted party.** Per-user OpenPGP is a stronger
  and more legible claim than "we encrypt your vault" — an operator can
  reason about it with standard PGP tooling.
- **Self-hostable with no vendor component**, including in the trust path.
  Nothing phones home to make sharing or notifications work.
- **Team-shaped from the start** — groups, folders, per-resource
  permissions, and comments are first-class, not a business-tier add-on.
- **Open governance and an AGPL community edition** with a documented API.

## Differentiators (why OpenSesame does not compete as a team PM)

- OpenSesame's human store is for **ceremonies on this device**, not a
  shared team vault with membership management.
- Agents never receive secret material. Passbolt's model ends at "the user
  decrypts it in their browser"; OpenSesame's authority story continues
  past that point into ConnectionRef, capability ceilings, and receipts.
- We do not adopt per-user OpenPGP as the storage model. The sealed store's
  envelope crypto (`crates/human-vault` — XChaCha20-Poly1305 with bound
  associated data, Argon2id passphrase wrap) is chosen for a single-human
  device store, where O(N) recipient re-encryption buys nothing.

## OpenSesame mapping

| Passbolt concept | OpenSesame |
|---|---|
| Resource + per-user secret | Sealed-store `Entry` — one ciphertext, one owner, no recipient fan-out |
| PGP message payload | Decrypted by `crates/provider-passbolt` (rpgp, MIT/Apache) at the human plane; never persisted decrypted |
| JWT login + `verify_token` server proof | `provider-passbolt` `auth.rs`; server URL + PGP fingerprint pinned from user configuration |
| Key passphrase | Prompted on a TTY in `apps/cli`, `secrecy::SecretBox`, zeroized, never stored |
| `/resources.json`, `/secrets/…` reads | `HumanProviderPlan::Passbolt` — declarative plan, executed by the async CLI call site (the `GitHubApp` precedent) |
| Folders / groups / permissions | Read for mapping context only; not reproduced as an OpenSesame authorization model (that is OpenFGA + ADR 0032) |
| KDBX export | **Already supported** — `opensesame pass import-kdbx` and the Pages KDBX adapter |
| v5 encrypted metadata | Detected and refused with a named error (ADR 0052 §4) |
| Serving Passbolt's own clients | **Roadmap only** — 2–4 engineer-months; O(N) sharing and the v5 cliff are the reasons |
| Catalog provider row | `passbolt`, `auth.kind: "configuration"` (`server_url`, `private_key` secret, `passphrase` secret) — an inert configuration row even if the provider crate is dropped |

## Deliberate non-goals vs Passbolt

- Do not copy Passbolt source. It is AGPL-3.0 and study-only; the API is
  implemented from its public documentation and OpenAPI description
  ([REUSE.md](../../REUSE.md), ADR 0052 §3).
- Do not implement Passbolt server compatibility opportunistically. It is
  a costed roadmap row precisely so it is not started by accident.
- Do not adopt per-user OpenPGP for the sealed store.
- Do not guess at v5 metadata. Refuse with a named error instead.

Related: [ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md),
[`keepass.md`](keepass.md), [`bitwarden.md`](bitwarden.md),
[`docs/architecture/pm-bridges.md`](../architecture/pm-bridges.md),
[REUSE.md](../../REUSE.md).
