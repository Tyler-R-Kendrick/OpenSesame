# ADR 0189 — Password reset: mailboxes are vault items, read in the browser, bound by id

- **Status:** Accepted (mailboxes, binding and the in-browser JMAP reader built and tested; the Host-side reset ceremony is not built — see *What this does not do*)
- **Date:** 2026-10-11
- **Uses:** [ADR 0076](0076-autonomous-web-login-rotation.md) (the agent orchestrates, deterministic tools hold secrets), [ADR 0087](0087-vault-item-type-plugins.md) (item types are manifests), [ADR 0130](0130-operator-controlled-capability-composition.md) (optional capabilities), [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing stored in the clear), [ADR 0157](0157-logs-and-events-carry-no-secrets.md) (no secrets in logs or events), [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a row acts or is absent), [ADR 0163](0163-failures-live-in-the-tray.md) (failures live in the tray), [ADR 0187](0187-trusted-circle-quorum-sharing.md) (a capability that keeps records as typed items)
- **Related:** the `ai.password-reset` capability and the model plane ([ADR 0083](0083-browser-plane-inference-fallback.md))

## Context

`ai.password-reset` first shipped as a list of bare addresses in a device
key (`password-reset-mail.v1`), a per-login `resetEmailId` pointing into that
list, and a once-a-minute scan whose message reader was a seam nothing
installed. Three things were wrong with it, and a person asking for "smart
password reset" would have met all three:

1. **A mailbox was only an address.** There was nowhere to say where the mail
   is or how to log in to it, so nothing could ever read it. The list was also
   outside the vault: not synced, not shared, not trashed, not sealed with the
   vault, and invisible to the item editor's own conventions.
2. **Nothing read mail.** The repository has no mail client in either plane.
3. **The hand-off did not start anything.** The scan posted
   `POST /api/v1/rotations {web_login_origin, execute_now}`. For a web login
   that route queues a job and answers `202`; `execute_now` is honoured only
   for a connection target (`crates/gateway/src/routes/rotation.rs`), and no
   consumer runs the queued job. The only route that starts a web-login run now
   is the attended one, which refuses a browser grant.

The item type for a mailbox already exists: `email-account`, in the
item-type marketplace, with an address, a username, a password, an incoming
server with a protocol and a security choice, and an outgoing server.

## Decision

### 1. A reset mailbox is an `email-account` vault item

Zero, one or many per vault. The address is all a mailbox needs. The server and
the login (the type's own fields) are the *advanced* part, drawn only when
asked for and needed only to have the app read the mailbox. The password is the
item's concealed field; it appears in no list, label, notice or error
(`ResetMailbox` has no field to hold it), and an edit that leaves it blank
keeps the one saved.

The capability brings the type the way Trusted contacts brings its two
(ADR 0187): `marketplace/item-types/optional/email-account.json` stays the one
source, `scripts/emit-reset-mail-types.mjs` embeds it as
`password-reset/mail-type.generated.ts`, a freshness test holds the two
together, and `ensureResetMailType` installs it into the open vault on first
write. The capability declares no egress for item types, so the marketplace
road is not available to it, and a vault that already has the type is not
rewritten.

A mailbox is therefore an ordinary item: it syncs end to end encrypted, goes
to the trash, is covered by the at-rest seal, and can be edited in the vault
like any other. The old key list is adopted once into items **under the same
ids** (`adoptLegacyResetEmails`), so a login already bound to one stays bound,
and is then dropped.

### 2. A login binds one by its item id

`AccountItem.resetEmailId` is unchanged in shape and now holds the mailbox
item's id. The account editor's *Reset email* field lists the vault's mailboxes
and is drawn only while the capability is approved and the vault has one (or
the login names one that is gone, so it can be cleared). Renaming a mailbox or
changing its server leaves a login bound; a mailbox in the trash simply reads
as *None*. A shared copy of a login still leaves the binding behind.

The Settings row for a mailbox offers *Remove* only while no login is bound to
it (ADR 0158: a control whose precondition is unmet is absent).

### 3. The capability depends on the item types, and is its own section

`ai.password-reset` keeps `dependencies: ["vault.derived-records"]` — the
login item type the binding is made on — so choosing Password reset turns on
Derived item types with it. It is its own section of Settings › Capabilities,
off until chosen, and its panel and background job load only after consent
(ADR 0130).

### 4. Mail is read in the browser, over JMAP, from the one server a person named

A page cannot open an IMAP or POP3 socket, so the reader speaks the one mail
protocol that is HTTPS: JMAP (RFC 8620, RFC 8621). A mailbox is *readable* when
it names a JMAP server, a password, and TLS; any other protocol is kept as the
person wrote it and is not read here. The capability declares one egress
(`external-service`, automatic, `PASSWORD_RESET_MAIL_PURPOSE`) and every
request goes through `ctx.egress.fetch`, so it is held while the plan denies
external services and refused before a socket opens if it strays.

The reader keeps a login on the server named: the session document's `apiUrl`
must be on the same origin as the server, no redirect is followed, a username
sends Basic and none sends a bearer token, and an error carries a code
(`unauthorized`, `unreachable`, `unsupported`, `malformed`) and nothing the
server said.

### 5. A reset message is announced once; the Host is asked with an origin only

Each minute, for each readable mailbox that some login names, the scan reads
the last two hours, matches reset messages to logins (`matchResetMail`), tells
the person once in the tray, and — when the website password-reset ceremony is
reachable — asks the Host to rotate that origin. What leaves for the Host is
the https origin; the link, which carries the token, never does. A ledger
(`password-reset-handled.v1`) of digests keeps a message from being announced or
handed on twice, across reloads and tabs. A mailbox that cannot be read raises
one notice that names it and the reason in a word; reading it again clears it.

## What this does not do

- **It does not reset a forgotten password.** The design for the ceremony that
  would is [ADR 0190](0190-forgot-password-ceremony-remote-browser.md) (proposed). The Host's web-login runner
  replays a *change* of password for a person who is logged in
  (`run_change_password_hooked`); there is no forgot-password run kind, no step
  that waits for a message, and no verb that follows an emailed link. A real
  one is a new run kind and recipe schema, new steps through the extension and
  the Host, and a way for the driver — not the Host, and not a model — to hold
  the mailbox login. That is its own ADR (mail access is account-takeover
  capable for every site the address resets).
- **It does not start a run today.** The hand-off keeps the one route that
  exists (`POST /api/v1/rotations`), which queues a job for the origin. Until
  the Host consumes it, what a person gets is the notice.
- **It does not read IMAP or POP3 mail.** That needs a reader in the authority
  plane, which then sees message content; the daemon's dependency budget and
  ADR 0076's value-blindness both argue for deciding that deliberately.

## Consequences

- A mailbox can be recorded with the server it really has (IMAP included) and
  starts being read the day a reader for it exists.
- The reset list no longer lives outside the vault; there is one place a
  mailbox is configured, shown, shared and deleted.
- The scan polls a person's own mail server once a minute per bound mailbox,
  only while the capability is approved and the vault is open.
- `ResetMailMatch` carries a message id, so a second reset message for the same
  login and site is acted on rather than swallowed by the first.
