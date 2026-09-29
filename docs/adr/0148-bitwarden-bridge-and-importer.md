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
  Once the accounts are in, every organization follows in one transaction
  each — members with the key each held, collections, who reaches which, its
  ciphers and files, each member's own folder and favourite — and every
  emergency contact. A member or contact keeps a key only when its own
  account came across; one at an address that has a different account here
  is accepted and waits to be confirmed again, and one at an address with no
  account waits as an invitation. Policies move with their organization
  (§9); groups are counted, not moved.
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

### 4. Attachments and Sends

- **Attachments.** A client announces a file (`/ciphers/{id}/attachment/v2`:
  its encrypted name and key, and its size), then uploads the ciphertext to
  the URL it is given; the one-step multipart form older clients use is served
  too. A download is a link carrying a token that opens that one file for an
  hour, so a client can hand it to its file fetcher without its bearer token.
- **Sends**, text and file, with a password, an access limit, an expiry, a
  deletion date no more than 31 days out, and "hide my email". Current clients
  prove a Send's password once, at `/identity/connect/token` with
  `grant_type=send_access`, and spend the five-minute token at
  `/sends/access`; the older `/sends/access/{accessId}` form with the password
  in the body is served beside it. The last access is taken by a
  compare-and-set, so two readers never both get it; a Send's password is
  stored as a registry hash of the client's own hash of it, and wrong attempts
  are limited per Send.
- **Bytes** sit in their own table, apart from the metadata, so a sync never
  reads them; they go with their owner by trigger. One upload is capped
  (`OPENSESAME_BITWARDEN_MAX_FILE_MB`, 100 by default) and an account's files
  together (`OPENSESAME_BITWARDEN_STORAGE_MB`, 1024).
- **The importer** carries both. From vaultwarden: attachments from
  `attachments/<cipher>/<id>` and Sends with their files from
  `sends/<send>/<file>` in its data folder, a Send's password moved as a PBKDF2
  record like an account's. From a live account: each attachment through a
  fresh download link, and text Sends without a password. A file Send's bytes
  can only be fetched by spending one of its accesses, and a Send's password
  is held by the old server in a form of its own, so those are counted and
  left behind.
- **A Send link names the web vault's origin.** The official `bw` trusts a
  Send link, when it cannot ask, only from the exact origin of the server it is
  configured for, so on a Host mounted at `/bitwarden` it asks the person
  first. Operators who share Sends give the server a host name of its own (an
  ingress that maps it to `/bitwarden`, with `OPENSESAME_BITWARDEN_URL` set to
  that origin). The oracle drives `send receive` against a server at an
  origin's root.

### 5. Organizations and collections

An organization is served as Bitwarden's is, and the server holds none of its
keys: its creator's device makes the organization key and sends it wrapped
under their own public key (`EncString` type 4, RSA-OAEP), with the
organization's RSA private key wrapped under the organization key. Collection
names and every organization cipher are encrypted under that key. The
organization's name and billing address are the only plaintext, as on
Bitwarden.

- **Joining takes two people.** This server sends no mail, so an invitation
  carries no token: an address that already has an account is *accepted* at
  once, and one that has none waits and is claimed when that address
  registers (vaultwarden's behaviour with mail off). Either way the member
  holds nothing — no organization in their profile, no cipher, no keys —
  until an administrator *confirms* them, wrapping the organization key under
  the member's public key on the administrator's own device. That is the step
  where Bitwarden's clients show the member's fingerprint phrase; since
  registration verifies no address, it is the step that decides who is in.
- **One rule decides who reaches a cipher** (`routes/vault_view.rs`), and
  every read and write goes through it: owners, admins, members with access to
  everything and custom roles allowed to edit any collection reach every
  cipher of the organization; anyone else reaches a cipher through the
  collections they are assigned — editing it if one is not read-only, seeing
  its password if one does not hide it, changing its collections if one says
  *manage*. A member names only collections they can see, adds a cipher only
  to collections they can write to, and collections they cannot see stay on a
  cipher whatever they send. A folder and a favourite on an organization
  cipher are each member's own.
- **Roles bound roles.** An owner may grant anything; an admin anything but
  owner, and cannot act on an owner; a custom role allowed to manage users may
  add plain users only. The last confirmed owner can neither leave nor be
  demoted or removed. Deleting an organization, and purging its vault, take its
  owner's master password; `purge` with an `organizationId` never touches the
  caller's personal vault.
- **Served:** creating an organization with a first collection; reading,
  renaming and deleting it; leaving it; its keys; members (invite, accept,
  confirm singly and in bulk, public keys for confirmation, change role and
  collections, revoke, restore, remove); collections (list, details, create,
  rename, reassign, delete); sharing a personal cipher in, its attachments
  re-encrypted first; putting a cipher in collections; the administrators'
  `…-admin` forms; `organization-details`; and importing into an
  organization. Groups, single sign-on, account recovery and directory sync
  are not: groups list empty, and clients hide the rest as they do against
  a server without them. Policies arrived with §9.
- **Files** on an organization's ciphers count against the organization, not
  against whoever uploaded them, under the same per-account quota.

The official `bw` lists an organization, its collections and members,
confirms a member itself (fetching their public key and wrapping the key),
creates a collection, moves a personal item in, and — signed in as the
member — decrypts it, under the oracle.

### 6. Emergency access, key rotation, and the rest of an account

- **Emergency access** is Bitwarden's: invite → accept → the grantor
  confirms, wrapping their user key under the contact's public key on their
  own device → the contact initiates recovery → the grantor approves or
  rejects, or the wait (one to ninety days) runs out → the contact *views*
  the grantor's own ciphers and files, or *takes over* by setting a new
  master password that re-wraps the same user key. With no mail, an
  invitation to an existing account is accepted at once and one to an
  unknown address is claimed when it registers; nothing is usable before the
  grantor confirms. The wait is settled when a record is read, by a
  compare-and-set — nothing runs on a timer. A takeover drops every session
  and second step and leaves every organization the grantor does not own,
  as Bitwarden's does.
- **Key rotation** (`/accounts/key-management/rotate-user-account-keys`)
  replaces the user key. The client re-encrypts every personal cipher,
  folder, Send, emergency contact's key and account-recovery key and sends
  them with the master password; the server refuses a rotation that leaves
  any of them behind (what it left would be unreadable), refuses a change of
  KDF, address or key pair there, and writes it all in one transaction. Every
  session ends.
- **The rest of an account:** its name and avatar colour; equivalent domains
  (the global list Bitwarden ships is not served); its devices, listed and
  signed out one by one; a change of address, which is a change of KDF salt,
  so the client sends master-password material derived under the new one;
  and deleting it, after the master password, unless it is the only owner of
  an organization.
- **Plain refusals** for what the server does not do: a password hint or a
  deletion link (both go by mail), trusted-device encryption, and a breach
  report on an address (that would disclose it to a
  third party; the Host checks passwords by k-anonymity instead, ADR 0080 §5).

### 7. Live sync and the web vault

- **The notifications hub.** Bitwarden's apps hold `/notifications/hub` open
  with Microsoft's SignalR client — WebSockets, negotiation skipped, the
  MessagePack hub protocol — and the server speaks exactly that: the
  handshake, pings, and `ReceiveMessage` invocations. It says two things:
  *sync now* (`SyncVault`) whenever an account's revision moves — its own
  change, an organization it belongs to, an emergency contact's step — and
  *sign out* (`LogOut`) when its security stamp changes, after which the
  connection closes. It carries no vault data, only the account id and a
  time, so a client learns from it what polling its revision date would tell
  it, sooner. A connection needs a current access token (a stale stamp is
  refused); an account holds at most 32; a slow one's queue is bounded and a
  dropped "sync now" is caught by the client's next sync. No
  mobile push relay is used: nothing leaves the Host.
- **The web vault.** The Host ships none. An operator who wants the browser
  app points `OPENSESAME_BITWARDEN_WEB_VAULT` at a build of
  `bitwarden/clients`' web app (vaultwarden's `bw_web_builds` is one), and
  it is served beside the API: a path with no file answers with the app's
  `index.html`, an unknown `/api` or `/identity` path stays a 404, and every
  page carries a content security policy, `X-Frame-Options`, `nosniff` and a
  same-origin referrer policy. A configured directory without the app
  refuses to start rather than serving nothing. Like Sends, the web vault
  wants the server on an origin of its own.

The pinned SignalR client (10.0.0, as `bitwarden/clients` pins it) hears
"sync" and "log out" and is refused with a stale token, under the oracle.

### 8. Log in with device

A device that does not hold the master password asks to sign in
(`POST /auth-requests`, unauthenticated, with a public key and an access code
it keeps); the account's signed-in devices hear it on the hub and show the
request's fingerprint phrase; one approves by wrapping the user key under
the asking device's public key. The asking device hears the answer on the
anonymous hub (`/notifications/anonymous-hub?Token=`), fetches the wrap with
its access code, and signs in with the same code on the password grant
(`authRequest`) — standing in for both steps, as on Bitwarden.

- The server keeps the wrap and a SHA-256 digest of the access code, never
  the code or the key. A request is open for fifteen minutes and is spent by
  the one sign-in it allows; a denial deletes it.
- An account has at most five unanswered requests at once; wrong codes are
  limited per request, and requests per address by the sign-in limiter.
- An address with no account gets a well-formed request that nothing will
  ever answer, so asking reveals nothing about who has an account.
- The pinned SignalR client, connected as `AnonymousHubService` connects,
  hears the answer (`AuthRequestResponseRecieved`, Bitwarden's spelling)
  under the oracle; the signed-in client hears the request and its answer.

### 9. Organization policies

Owners, admins and custom roles allowed to manage policies set an
organization's policies (`/organizations/{id}/policies/{type}`, in both the
flat and the `{policy: {…}}` body clients send); a sync carries the enabled
ones of every organization an account is a confirmed member of, and clients
enforce the password, generator, timeout, export, PIN and item-type ones
from there, as they do against Bitwarden's server.

The server enforces the ones that guard what it stores, on members who are
neither owners nor admins, as Bitwarden's does:

- **Two-step login:** enabling it revokes members without it; turning one's
  own off revokes one from such organizations; a member without it is
  neither confirmed nor restored.
- **Single organization:** enabling it revokes members who belong to
  another organization; such a member is neither confirmed nor restored into
  another, and creates none.
- **Personal ownership:** no new items in the personal vault (items go to an
  organization's collections instead).
- **Disable Send**, and **Send options**' "hide my email": no new or changed
  Sends, or none hiding the address.

Policies move with an organization from vaultwarden. `/plans` answers with
the one plan this server has, so the web vault can create an organization.

## Consequences

- A default Host build contains no Bitwarden code. Operators who serve
  Bitwarden clients build with the feature, as they do for any bridge.
- A vaultwarden operator can move a whole server in one command, and its
  people keep their apps, their master passwords and their vaults.
- The importer holds the master password of a live account for the length of
  one sign-in, in the person's own terminal, zeroized after use; it is the same
  exposure as signing in with `bw`.
- A self-hosted team can move onto the Host with its shared vaults, not just
  its personal ones: the vaultwarden importer carries organizations and
  emergency contacts with the accounts. A live-account import is one
  person's, so what they reach through an organization stays with the
  organization; it is counted, and moves when the organization's server is
  imported.
- The Bitwarden consume-client (`crates/provider-bitwarden`) now names the
  two-step providers a server offers and a new-device challenge, and signs in
  with an answer; its own vault reads still decline both (ADR 0052).
