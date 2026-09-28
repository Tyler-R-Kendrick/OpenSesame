# Serving Bitwarden clients from the Host

The Host can stand in for a Bitwarden server. Bitwarden's own apps — the `bw`
CLI, the browser extension, the desktop and mobile apps — sign in, unlock, sync
and edit a personal vault against it, and never learn the difference beyond a
"not Bitwarden's server" notice. Decision and scope:
[ADR 0141](../adr/0141-bitwarden-compatible-server.md).

## Turn it on

The server is a password-manager bridge, so a default build leaves it out
([ADR 0148](../adr/0148-bitwarden-bridge-and-importer.md)). Build the Host with
it, then switch it on:

```bash
cargo build --release -p opensesame-cli --features bitwarden-compat
# or the image: docker build --build-arg OPENSESAME_FEATURES=bitwarden-compat …
export OPENSESAME_BITWARDEN_COMPAT=on
export OPENSESAME_BITWARDEN_SIGNUPS=open          # closed (default) | open | example.com,corp.example
# A domain list limits which addresses can be claimed; no mail is sent, so it
# does not prove the person registering receives that address's mail.
export OPENSESAME_BITWARDEN_REQUIRE_ARGON2ID=true  # optional: refuse PBKDF2 for new accounts
# optional; defaults to "$OPENSESAME_RESOURCE/bitwarden"
export OPENSESAME_BITWARDEN_URL=https://vault.example.com/bitwarden
opensesame host run
```

A Host built without the feature refuses to start while
`OPENSESAME_BITWARDEN_COMPAT` is on, rather than come up without the surface.

Bitwarden clients refuse plain HTTP, so the URL they are given must be HTTPS:
the Host's own TLS listener ([mTLS guide](mtls.md)) or a TLS-terminating
ingress in front of it.

## Point a client at it

```bash
bw config server https://vault.example.com/bitwarden
bw login you@example.com
```

In the apps, choose **Self-hosted** and enter the same URL. Accounts are created
from the web vault or any client that offers registration while signups are
open; close them again afterwards.

## Move people over from vaultwarden or Bitwarden

The importer moves accounts with their master passwords, keys and vaults
unchanged ([ADR 0148](../adr/0148-bitwarden-bridge-and-importer.md)). The Host
never sees a password or a decrypted value on the way. Each device signs in
once more afterwards; nobody picks a new password.

**A whole vaultwarden server.** Stop vaultwarden (so the file is consistent),
then point the importer at its SQLite database:

```bash
opensesame bridge bitwarden import vaultwarden --from /srv/vaultwarden/data/db.sqlite3 --dry-run
opensesame bridge bitwarden import vaultwarden --from /srv/vaultwarden/data/db.sqlite3
```

Every registered account moves with its folders, favourites, trash and items.
Its vaultwarden password hash moves too and is replaced with Argon2id at the
person's first sign-in. Invited accounts that never registered, and disabled
ones, are listed and skipped.

**One account from a live server** (bitwarden.com, bitwarden.eu, self-hosted
Bitwarden, or a vaultwarden whose database you cannot reach). The person runs
it and types their master password, and a two-step or new-device code if the
old server asks:

```bash
opensesame bridge bitwarden import account --from https://vault.bitwarden.com --email you@example.com
```

Both write to the Host database (`--db`, default `$OPENSESAME_DB`). An email
that already has an account on the Host is left alone unless you pass
`--replace`, which deletes that account and everything it holds first. Each run
prints, per account, what moved and what stayed behind (attachments, Sends,
organization items, two-step methods, emergency contacts), so nothing is lost
quietly.

## What people get

- Argon2id by default. An account can move from PBKDF2 to Argon2id from its
  client's security settings; the user key is re-wrapped, nothing is
  re-encrypted, and every other session is signed out.
- A server that cannot read the vault: ciphers, folder names, keys and the
  master password never reach it in the clear. The stored credential is an
  Argon2id hash of the client's own hash.
- Folders, logins, secure notes, cards and identities; trash and restore;
  import. SSH-key items are stored and returned as sent, but the oracle does
  not cover them yet.

## What is not served

Organizations and collections, Sends, attachments, emergency access, two-factor
providers, live-sync notifications, API-key sign-in (`bw login --apikey`) and
key rotation. Clients hide or fail those features as they do against a server
that has them turned off.

## Operating notes

- Access tokens last an hour. Unless `OPENSESAME_BITWARDEN_TOKEN_KEY` is set
  they are signed with a per-process key, so after a restart clients refresh
  once and carry on.
- "Log out all sessions", a password change and a KDF change rotate the
  account's security stamp: every token it held stops working at once.
- Sign-in hashing is bounded to four concurrent Argon2id computations (about
  76 MiB). An unknown email costs the same work as a known one.
- Server hashes in PBKDF2-SHA256 form, which the vaultwarden importer writes,
  are accepted and replaced with Argon2id at the account's next sign-in.
- A refresh token lapses after 30 days unused, and dies at once on a password
  change, a KDF change or "log out all sessions".
- An address that fails to sign in ten times in fifteen minutes is refused
  until its window passes, known and unknown addresses alike; a full hashing
  queue answers 429 rather than waiting.
- Set `OPENSESAME_BITWARDEN_TOKEN_KEY` (32+ hex-encoded bytes) when more than
  one replica serves the same URL, so an access token minted on one verifies
  on another.

## Verify

```bash
pnpm test:bitwarden-oracle   # drives the pinned official bw CLI against the surface
```
