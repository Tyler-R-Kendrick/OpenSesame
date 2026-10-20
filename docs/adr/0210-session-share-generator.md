# ADR 0210 — The share key opens a session generator, not a one-press session

- Status: Accepted
- Date: 2026-10-20
- Amends: [ADR 0150](0150-live-sessions-browser-to-browser.md) (the share
  sheet's default surface and the joiner's local identity)
- Builds on: [ADR 0160](0160-the-device-identity-plane-is-declared.md) (the
  device is the Identity plane), [ADR 0179](0179-credentials-are-entries-bound-to-accounts.md),
  [ADR 0187](0187-trusted-circle-quorum-sharing.md) (identity-scoped access)
- Related: [ADR 0209](0209-deadman-switch.md) (device-local release)

## Context

The Share key beside the vault name used to start a live session immediately,
with its fields folded under Advanced. That is fast for a person who has read
the ADR, and opaque for everyone else: the link appeared before the person said
who it was for, what it may show, or how someone joins. The same screen had no
QR, so a phone had to receive the link another way.

A live session also did not leave a local identity behind. A joiner was a
transient seat with a claimed name; the owner's directory could not later
answer "who was in that session?" and no standing share existed for the person
who joined.

## Decision

### 1. The Share key opens the generator

The sheet opens on a form, not a button:

- **Session name** (prefilled with the vault label);
- **Share** (whole vault, chosen items, or nothing);
- **Values** (show, copy only, or edit);
- **Share with** (anyone with the link, the built-in **All users** group, or
  selected people);
- **Who gets in** (anyone with the link, or link and code);
- **For** (15 minutes to 8 hours).

Defaults are **anyone with the link** and **chosen items**. The form is not
ready until a title and at least one item (or an allowed device request) are
present, so a blank share cannot be started by accident. Routes remain under
Advanced.

The link is shown after the form commits, with a **QR code** and a copy key.
The QR carries the same link, in the fragment, so it never reaches the hosting
server.

### 2. Joining claims a local identity and seals a local vault

On a device with no vault, the join form adds **Seal this device**: a PIN,
confirmation, and the same recovery acknowledgement the first-run vault shows.
Submitting creates the joiner's own vault and an owner identity for the claimed
name, then sends the live request. On a device with a locked vault the form
asks the person to unlock first; on an unlocked vault it joins with the
existing identity.

The owner's vault creates a person for the claimed name when the seat is
admitted. If the name already exists, that person is reused. The person gets a
membership in the vault's organization when one exists.

The claimed name is a claim, not an authenticated assertion. Selected-people
sessions match the claim; they do not prove it. A future identity proof can
tighten that without changing the share record.

### 3. Scope becomes standing shares

Admission writes the session's scope as local shares:

- whole vault → a `vault` share for the owner/group;
- chosen items → an `item` share for each item;
- nothing → no share.

The share policy follows the live policy: show → `open`/`read`, copy or edit →
`items`/`use`. Shares carry the host session id and the session's expiry, so a
later `revokeSharesForSession` can remove them. The live catalog remains the
session's source of values; the shares are the durable answer outside it.

`All users` is a built-in local Identity group, `local_group_all_users`. It is
not a directory row and has no membership file: every enabled person is in it.
It appears as a share target in Access and as **Share with → All users** in the
session form. A share to it is read beside the person's own shares.

### 4. The link and the codes are separate

An open session auto-admits a request, but the request and reply still have to
cross to the owner's browser. The link alone carries the owner's public key and
the session secret, not a rendezvous service. The two routes are unchanged:

- by hand, with the request and reply codes;
- through a carrier or relay the owner names under Routes.

The QR makes the first route easier on a phone; it does not pretend a static
browser can receive an inbound request on a public address.

## Consequences

- `LiveHostForm` is the share sheet's primary surface. The one-press start is
  removed; the form's own commit is the start.
- `LiveHostSession` draws a QR beside the hidden link.
- `LiveHost` gains an optional `provisionSeat` callback. `buildLiveHost`
  supplies one that calls `provisionLiveSessionGuest` with the open vault's
  scope and policy. A provisioning failure refuses the seat rather than
  admitting a person with no identity or share record.
- `grantIdentities` includes the built-in All users group; `shareAllows` reads
  group shares beside the person's own; the Access share form can choose it.
- The live link is kept in the fragment across the optional capability's
  consent reload, then removed by the join screen. A `sessionStorage` copy is
  the fallback for a reload that loses the fragment.
- The join screen can create a local vault with a PIN and an owner identity
  before sending the request.
- Tests cover group sharing, the actual open-vault provisioning path, the
  generator form, QR, the lock-screen join road and the join/seal flow at phone
  width.

## Limits

- A claimed name is not authentication. Selected people and All users are
  audience policy, not a proof of who is at the keyboard.
- The owner must still exchange request and reply codes, or name a carrier,
  because the static app has no default rendezvous service.
- The joiner's local vault is their own vault. It is not a copy of the owner's
  vault, and its identity is not a cryptographic claim about the owner.
- Shares created by a session expire with the session; an operator who wants a
  standing grant makes one in Access.
- A QR code is a bearer in a picture. Anyone who can photograph the screen can
  ask to join; admission policy and the request/reply codes still apply.
