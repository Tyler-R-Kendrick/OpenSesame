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

The importer (`opensesame bridge bitwarden import`, in the same
`--features bitwarden-compat` build) moves accounts with their master
passwords, keys and vaults unchanged
([ADR 0148](../adr/0148-bitwarden-bridge-and-importer.md)). The Host
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
prints, per account, what moved (folders, items, attachments, Sends) and what
stayed behind (organization items, other two-step methods, emergency contacts,
a live account's file Sends and password-protected Sends), so nothing is lost
quietly. vaultwarden's attachments and Send files are read from its data
folder, next to `db.sqlite3` unless you name it with `--data`.

## What people get

- Argon2id by default. An account can move from PBKDF2 to Argon2id from its
  client's security settings; the user key is re-wrapped, nothing is
  re-encrypted, and every other session is signed out.
- A server that cannot read the vault: ciphers, folder names, keys and the
  master password never reach it in the clear. The stored credential is an
  Argon2id hash of the client's own hash.
- Folders, logins, secure notes, cards and identities; trash and restore;
  import; attachments and Sends. SSH-key items are stored and returned as
  sent, but the oracle does not cover them yet.

## Two-step login and API keys

People manage both from the security settings of Bitwarden's web vault, and
the importer carries them over from vaultwarden or a live account.

- **Authenticator app.** Turning it on takes the master password and a code
  from the app, so nobody enables a step they cannot pass. Each code works
  once; codes from one step either side of the server's clock are accepted.
  "Remember this device" skips the step on that device for 30 days, or until
  the account's security stamp changes.
- **Recovery code.** Shown on request; typing it at sign-in, or on the
  signed-out recovery page with the master password, turns two-step login off
  and issues a new one. Wrong attempts count against the address like wrong
  passwords.
- **Personal API key** (`bw login --apikey`). Signs in without the second step
  and without a refresh token, as on Bitwarden; `bw unlock` still needs the
  master password. Rotating it retires the old key at once.

Like Bitwarden's own server, the Host keeps the authenticator key, recovery
code and API key where it can check or show them again. None of them opens a
vault.

## Attachments and Sends

Files on items and Sends (text or a file, shared by link) are served. Both are
ciphertext the client encrypted; the Host cannot open them.

```bash
export OPENSESAME_BITWARDEN_MAX_FILE_MB=100    # largest single file (default 100)
export OPENSESAME_BITWARDEN_STORAGE_MB=1024    # all of one account's files (default 1024)
```

Files are kept in the Host database. A Send can have a password, an access
limit and an expiry; it is deleted at its deletion date, at most 31 days out.

**Give the server a host name of its own if people share Sends.** A Send link
names the web vault's origin, and Bitwarden's clients trust one from the exact
origin they are configured for. Under `/bitwarden` on a shared host, `bw send
receive` asks before it opens a link (and refuses when it cannot ask). Point a
dedicated name at the Host with an ingress that maps it to `/bitwarden`, and
set `OPENSESAME_BITWARDEN_URL` to that name.

## Organizations

Any account can create an organization from the web vault or a desktop
client; its creator is its owner. The server sends no mail, so an invitation
for an address that already has an account is accepted at once, and one for
an address without an account waits until that address registers. Nobody
reaches an organization's items until an owner or admin **confirms** them
(`bw confirm org-member <member-id> --organizationid <org-id>`, or the web
vault's Members page). Check the fingerprint phrase the client shows against
the person before confirming: registration verifies no address, so
confirmation is what decides who is in.

Policies are set from the web vault's Admin Console. Clients enforce most of
them; the Host itself enforces two-step login, single organization, personal
ownership and the Send policies on members who are neither owners nor
admins. The membership ones are decided as the membership changes, so a
member is never confirmed, restored or demoted into an organization whose
policy excludes them, and enabling one revokes the members it excludes at
once; an owner or admin is held to a single-organization policy that binds
them in another organization. Turning off an account's last two-step
provider removes it, as revoked, from the organizations that require one.
Groups, single sign-on and account recovery are not served.

An organization imported from vaultwarden is held to its enabled policies as
it arrives: members they exclude — an account whose authenticator did not
come across, for instance — arrive revoked, and the importer says how many,
and when no owner is left standing (restore one before anyone can run it).
Restore them once they meet the policy.

## Emergency access and key rotation

Emergency contacts work as on Bitwarden: the grantor names a contact, the
contact is accepted at once if they have an account (or when they register),
and nothing is usable until the grantor confirms them. A contact's recovery
is approved by the grantor or when the wait the grantor chose runs out.
Rotating the user key (the web vault's *Rotate account encryption key*) signs
every device out.

The server sends no mail, so password hints and account-deletion links are
refused rather than reported as sent.

## Live sync and the web vault

Clients that stay signed in — the desktop app, browser extension and web
vault — hold `/notifications/hub` open and sync as soon as a change is made
elsewhere; nothing needs configuring. Put a WebSocket-capable proxy in front
if there is one (Caddy and nginx pass upgrades with their defaults for this
path).

To serve the web vault, unpack a build of Bitwarden's web app and name its
directory:

```bash
export OPENSESAME_BITWARDEN_WEB_VAULT=/srv/bitwarden-web-vault   # holds index.html
```

The Host refuses to start if the directory has no `index.html`. Give the
server a host name of its own for the web vault, as for Sends.

## Log in with device

A new device can sign in by asking one already signed in, with no master
password typed: approve the request on the signed-in device after checking
that both show the same fingerprint phrase. Requests expire after fifteen
minutes, and the waiting device is let go then, or as soon as the request is
answered or denied. An address can ask five times in a window, whether or not
it has an account; an account can have five waiting at once.

## What is not served

Other two-step providers (email, Duo, `YubiKey`, security keys), organization
groups, trusted-device encryption, breach reports by address, and
mobile push notifications through Bitwarden's relay. Clients hide or fail those
features as they do against a server that has them turned off.

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
pnpm test:bitwarden-oracle   # drives the pinned official bw CLI and SignalR client against the surface
```
