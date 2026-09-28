# ADR 0148 — The Bitwarden server as an optional bridge, and moving onto it

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0141](0141-bitwarden-compatible-server.md) (the
  Bitwarden-compatible server), [ADR 0052](0052-password-manager-ecosystem-bridging.md)
  and [ADR 0053](0053-pm-bridge-binaries.md) (password-manager bridges, one
  cargo feature each, all off by default)

## Context

ADR 0141 made the Host answer Bitwarden's clients. Two things were missing
for it to replace a Bitwarden or vaultwarden server:

1. **It was compiled into every Host.** The other password-manager bridges
   are cargo features that a default build leaves out (ADR 0053 §6); the
   Bitwarden server was a plain dependency of the gateway, gated only by an
   environment variable. A Host that never serves Bitwarden clients still
   shipped the code.
2. **Nothing moved an existing server's people onto it.** The only road was
   "export the vault from the old server and `bw import` it": one person at a
   time, with the vault decrypted into a file on the way, a new master
   password, and no folders' or trash's history. ADR 0141 §4 anticipated an
   importer and shipped none.

## Decision

### 1. A bridge, compiled on request

The Bitwarden server is the `bitwarden-compat` cargo feature of
`opensesame-gateway` and `opensesame-cli`, off by default, like every bridge
in `crates/pm-bridges`. Serving it takes both switches: a Host built with
`--features bitwarden-compat` and `OPENSESAME_BITWARDEN_COMPAT=on`. A Host
built without the feature that is told to serve it refuses to start; it never
comes up quietly without a surface its operator configured. The container
image takes the list as a build argument (`OPENSESAME_FEATURES`), and CI
builds and tests the feature beside the default build.

### 2. An importer that keeps zero knowledge

`opensesame bridge bitwarden import` moves people onto the Host with their
master passwords, keys and vaults unchanged. The Host never sees a password
or a decrypted value on the way, exactly as it never does in service.

- **A vaultwarden server** (`import vaultwarden --from <db.sqlite3>`): the
  operator points it at vaultwarden's SQLite file, opened read-only. Every
  registered account moves: its KDF choice, wrapped user key, key pair,
  folders, favourites, trash and ciphers, byte for byte. Its server hash
  moves too. vaultwarden keeps PBKDF2-SHA256 over the client's hash in raw
  columns; the importer writes them as a `$pbkdf2-sha256$i=…,l=32$salt$hash`
  string, which the registry verifies once and replaces with Argon2id at the
  person's next sign-in (ADR 0141 §4). vaultwarden's salts are 64 bytes,
  longer than generic PHC parsers accept, so the verify-only scheme reads that
  form itself. Nobody resets a password; each device signs in once more.
- **A live account** (`import account --from <server> --email <address>`),
  for bitwarden.com, bitwarden.eu, a self-hosted Bitwarden server or a
  vaultwarden whose database is out of reach: the person runs the CLI and
  types their master password. It derives the login hash locally with the
  account's own KDF, signs in to the old server as any Bitwarden client would
  (answering a two-factor challenge if one comes), reads the encrypted vault
  and writes it to the Host unchanged. The Host stores an Argon2id hash of the
  same login hash, so the same master password opens the same vault.
- **Nothing merges.** A vault is encrypted under its account's key, so an
  import never adds ciphers to an account that already exists on the Host;
  it skips that address and says so, or replaces the account when told to
  (`--replace`).
- **Every cipher is checked as a client's own write.** An item passes the
  same parser a client's `POST /api/ciphers` does (ciphertext where ciphertext
  belongs); vaultwarden's older `PascalCase` payloads are re-spelled in the
  lower camel case clients write today, never re-encrypted.
- **Nothing is dropped silently.** What the Host does not yet serve, and any
  item or folder the parser refuses, is counted and reported per account;
  invited-but-unregistered and disabled vaultwarden accounts are listed with
  the reason; `--dry-run` reports it all without writing.
- **Proven by the oracle.** `pnpm test:bitwarden-oracle` has the official `bw`
  write a vault on one server, moves it with the importer, and has a fresh
  `bw` read every item back from the Host with the same password; and it signs
  `bw` in to an account moved from a vaultwarden database with its old
  password. The oracle also found that clients look up another account's
  public key (`GET /api/users/{id}/public-key`), which the server now answers.

### 3. Sign-in methods beside the master password

The Host serves what a Bitwarden account uses beside its master password, so
nobody moving over has to give one up:

- **The personal API key** (`client_credentials`, `client_id` `user.<id>`):
  signs in without a second step and gets no refresh token, as on Bitwarden;
  unlocking still takes the master password. `/accounts/api-key` shows it
  (after the master password), `/accounts/rotate-api-key` replaces it.
- **An authenticator app** (provider 0): RFC 6238, computed by
  `crates/authenticator-core`, the product's one OTP implementation. Turning it
  on proves the master password (or a setup token bound to the offered key)
  and a code; each code is spent once by a compare-and-set on its time step;
  a wrong code counts against the address like a wrong password.
- **"Remember this device"** (provider 5): a token stored as a digest on the
  device record, bound to the security stamp and 30 days.
- **The recovery code** (provider 8 at sign-in, or the signed-out recovery
  route with the master password): spent by compare-and-set, it turns two-step
  login off and is replaced.

Email, Duo, `YubiKey` and security-key providers are not served; an account
that uses them in its old server is told so by the importer. The server keeps
the authenticator key, recovery code and API key where it can check or show
them, as Bitwarden's and vaultwarden's do. The importer carries all three:
from vaultwarden's columns, and from a live account through the same
password-proving calls the web vault makes. The official `bw` answers the
challenge (`--method 0 --code`) and signs in with an API key under the oracle.

## Consequences

- A default Host build contains no Bitwarden code. Operators who serve
  Bitwarden clients build with the feature, as they do for any bridge.
- A vaultwarden operator can move a whole server in one command, and its
  people keep their apps, their master passwords and their vaults.
- The importer holds the master password of a live account for the length of
  one sign-in, in the person's own terminal, zeroized after use; it is the same
  exposure as signing in with `bw`.
- The Bitwarden consume-client (`crates/provider-bitwarden`) now names the
  two-step providers a server offers and a new-device challenge, and signs in
  with an answer; its own vault reads still decline both (ADR 0052).
