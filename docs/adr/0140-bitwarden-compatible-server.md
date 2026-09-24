# ADR 0140 — A Bitwarden-compatible server, with Argon2id and a replaceable hash

- Status: Accepted
- Date: 2026-09-24
- Builds on: [ADR 0052](0052-password-manager-ecosystem-bridging.md)
  (password-manager ecosystem bridging), [ADR 0097](0097-bounded-kdf-policy.md)
  (bounded KDF work), [ADR 0065](0065-agent-surface-parity.md) (agent-surface
  parity), [ADR 0138](0138-self-issued-identity-one-native-host.md) (one native
  host)

## Context

Bitwarden's clients — `bw`, the browser extension, the desktop and mobile
apps — accept any server URL. People already run vaultwarden to own their data
while keeping those clients. OpenSesame reads a Bitwarden vault
(`crates/provider-bitwarden`, ADR 0052) but could not *be* one: a person could
not point a Bitwarden client at their OpenSesame Host.

Bitwarden's key derivation is widely praised for offering Argon2id, the
Password Hashing Competition winner (RFC 9106), beside PBKDF2. Two different
KDFs are involved, and they are easy to conflate:

1. **The client KDF.** The client runs PBKDF2-SHA256 or Argon2id over the master
   password to derive the master key, which wraps the user key. The server never
   runs it; it stores the client's choice and returns it at prelogin.
2. **The server hash.** The client sends a *master-password hash* (one more
   PBKDF2 round over the master key). That value is a login credential, so the
   server hashes it again before storing it. Bitwarden's server and vaultwarden
   use PBKDF2 here.

Argon2id will not be the last word. Whatever succeeds it has to arrive without a
flag day: no forced password reset and no re-encryption.

## Decision

1. **A new crate, `crates/bitwarden-server`**, implements the client protocol
   Bitwarden's clients speak for a personal vault: prelogin (both the flat and
   the `kdfSettings` + `salt` shapes), the password and refresh-token grants,
   registration (the two-step `send-verification-email` → `finish` form and the
   legacy one-step form), sync, profile, revision date, key pair, user-key id,
   verify-password, security stamp, KDF change, password change, folders, and
   ciphers of every type with trash, restore, move, purge and import. It is
   mounted on the Host at `/bitwarden` when the operator sets
   `OPENSESAME_BITWARDEN_COMPAT=on`, and is off by default.
2. **Zero knowledge is kept.** Every value a client encrypts is stored and
   returned verbatim as an `EncString`. The server holds the client-wrapped user
   key, never the user key, and a hash of the client's hash, never the password.
3. **Argon2id is the default client KDF.** An email with no account is told
   Bitwarden's recommended Argon2id (64 MiB, three passes, four lanes) at
   prelogin, so an unknown address reads like a known one. New accounts and KDF
   changes are held to the ranges Bitwarden's server accepts; an operator may
   refuse PBKDF2 outright (`OPENSESAME_BITWARDEN_REQUIRE_ARGON2ID=true`). The
   ranges live in one table keyed by the wire enum, so a successor KDF is a new
   enum value and one row.
4. **Argon2id writes the server hash, through a registry that can retire it.**
   Stored hashes are PHC strings, which name their own algorithm and
   parameters. `HashRegistry` holds one *current* `PasswordHashScheme` (Argon2id
   v1.3 at OWASP's server parameters: 19 MiB, two passes, one lane) and any
   number of *accepted* ones. A sign-in that verifies against an accepted scheme,
   or against the current one under older parameters, is re-hashed under the
   current scheme on the spot. PBKDF2-SHA256 is accepted verify-only, so an
   account imported from a Bitwarden or vaultwarden server upgrades on its first
   sign-in. Replacing Argon2id is: implement the trait for the successor, make it
   current, keep Argon2id accepted.
5. **The official client is the oracle.** Parity is not asserted from reading
   Bitwarden's source (which this project does not copy); it is observed. The
   pinned `@bitwarden/cli` is driven over HTTPS against the surface, and its
   results are cross-checked by OpenSesame's own Bitwarden client, an independent
   implementation of the key schedule. Any request `bw` makes that has no route
   fails the run.

## Behaviour that deliberately differs

- `/api/config` names the server `OpenSesame`, so clients show their usual
  notice for a server that is not Bitwarden's.
- Accounts report `premium: true`: there is no billing on a self-hosted Host.
- Access tokens are signed with a per-process key. A restart, or a request that
  lands on another replica, costs the client one refresh-token exchange.
- No mail is sent, so registration behaves as a self-hosted Bitwarden server with
  email verification off; signups are closed unless the operator opens them
  (`OPENSESAME_BITWARDEN_SIGNUPS=open` or a domain list).
- Not served: organizations and collections, Sends, attachments, emergency
  access, two-factor providers, the notifications hub, API-key
  (`client_credentials`) sign-in, and key rotation. A write that names an
  organization is refused with a message saying so.

## Consequences

- A person can move from Bitwarden or vaultwarden to their own Host without
  changing apps.
- `pnpm test:bitwarden-oracle` installs `@bitwarden/cli@2026.9.0` into
  `.cache/bitwarden-oracle/` and runs the oracle suites; they fail rather than
  skip without it. `tests/protocol.rs` covers refusals, isolation and wire
  shapes in ordinary CI. Raising the pinned client is a deliberate change made
  together with `COMPATIBLE_SERVER_VERSION`.
- The surface is human-plane only. Its capability entry excludes every agent
  surface: an agent reaches a credential through a ConnectionRef, never through a
  vault session (ADR 0005).
- Each Argon2id hash holds its memory while it runs, so concurrent hashes are
  bounded (`hash_concurrency`, four by default), and an unknown email spends the
  same work as a known one.
