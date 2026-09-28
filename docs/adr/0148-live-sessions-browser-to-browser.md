# ADR 0148 — Live sessions: joining someone's vault browser to browser

- Status: Accepted
- Date: 2026-09-28
- Amends: [ADR 0090](0090-static-frontend-complete-without-backend.md) and
  [ADR 0115](0115-front-door-and-connector-directory.md) (the first-run door:
  two roads, sign-in behind a vault), [ADR 0136](0136-join-a-session-restored.md)
  (the join road on every deployment, the shared GitHub Pages origin
  included)
- Revisits: [ADR 0079](0079-shared-sessions-and-scoped-grants.md) §Rejected
  ("WebRTC mesh as the admission path")
- Builds on: [ADR 0044](0044-claimable-connection-delegation.md) (a bearer link
  plus an out-of-band code), [ADR 0130](0130-operator-controlled-capability-composition.md)
  (an optional capability loads only after consent), [ADR 0063](0063-encrypted-vfs-tombs.md)
  (every vault is a tomb)

## Context

A vault in the Pages PWA lives in its owner's browser. "Join a vault as an
approved user" therefore means reaching *that browser*: the owner is the
server. ADR 0136 restored the join ceremony against a Host's HTTP routes, and
the Host deliberately refuses to pair a browser on the shared
`tyler-r-kendrick.github.io` origin, where every one of the owner's GitHub
Pages sites runs. On the deployment people actually use, the road was hidden
and an invited person had nowhere to go.

Two browsers can talk directly over WebRTC, but only after something has
carried each one's connection offer to the other. A static site has no
server to do that. ADR 0079 rejected WebRTC because a naive design exchanges
network addresses before the owner has admitted anybody: a stranger asking
to join a public session would learn the owner's IP address.

The first-run door also offered sign-in — Google, guest, a local-only seal —
beside "Set up your own", on a device that has no vault to sign in to. The
two things a first visitor actually arrives to do are start a vault or join
someone else's.

## Decision

### 1. The door is two roads

On a device with no vault and no setup record, the door offers **Set up your
own** and **Join a session**, on every deployment. Sign-in is a question for
a device that holds a vault; the door does not ask it. The guest road stays
one press away in the card's corner (**Skip**), which is the first-run guest
placement ADR 0135's switch still governs; "Continue as guest" stays on the
sign-in panel beside an existing vault and on the unlock form, unchanged.

### 2. A live session is hosted by the owner's open tab

The owner, with the vault unlocked, opens a **live session**: what it shares
(the whole vault or chosen items), how (`read` shows values, `use` copies
them without drawing them), for how long (at most eight hours), and who gets
in — **invite** (a link plus an out-of-band code, the ADR 0044 shape) or
**open** (anyone holding the link is admitted as they ask). The tab hosts the
session: closing it, locking the vault, or the time running out ends it for
everyone. Nothing about a session is written to storage on either side.

### 3. Nostr relays introduce the browsers; they never see the session

Signalling rides a few public Nostr relays (`nostr-tools`, NIP-44 v2
encryption, ephemeral kind 25548 so relays do not store it). The owner mints
a fresh secp256k1 key per session; the **link** carries that public key, a
32-byte link secret and the relay list, in the fragment only, on the app's
own root:

```
…/#live=v1.<i|o>.<owner-pubkey-hex>.<link-secret-b64url>[.<relays>]
```

The root, not a path of its own: a fresh load there always meets the unlock
screen, whose join road takes the link (boot has already removed it from
the address bar and history), and a deep path is a 404 on GitHub Pages.
`i` is an invite session, `o` an open one.

- Every message is a NIP-44 conversation between two ephemeral keys — the
  owner's and one joiner's — so a relay sees two public keys and ciphertext,
  and one invitee cannot read another's signalling.
- A joiner's first message proves it holds the link:
  `HMAC-SHA256(HKDF(link-secret), "osm-live-v1" ‖ owner ‖ joiner)`. In invite
  mode the key also mixes in the code, so the link alone is not enough.
  The owner counts misses; the fifth ends the session (the ADR 0044 rule).
- Messages the joiner accepts are signed by the owner key the link named, so
  nobody holding the link can impersonate the owner.

### 4. No address is exchanged before admission

The joiner asks (a name and a note, each bounded); the owner — or, in open
mode, the owner's policy — admits or refuses. **Only after admission** does
the owner send a WebRTC offer, and only then does either side gather ICE
candidates. A refused or pending asker never learns where the owner is. The
DTLS fingerprints travel inside the owner-signed, encrypted signalling, so a
relay cannot put itself in the middle of the peer connection. STUN servers
default to two public ones. The session API takes other ICE servers and a
**relay-only** mode (TURN only: no direct address at all, even after
admission); neither is exposed as a setting yet, because relay-only needs a
TURN server and its credentials, which belong in the sealed vault rather
than a plaintext file.

### 5. What crosses the peer channel

The owner's key never leaves its device. Over the data channel the owner
sends the shared items' names, types and non-concealed fields, and answers a
`reveal` or `copy` request for one concealed field at a time, re-checking
scope, policy and expiry on every request and recording each in the
session's on-screen log. The joiner keeps everything in memory, drops it the
moment the channel closes, and never writes it to storage. `use` is a
display policy: a browser that receives a value to copy can keep it, and the
page says nothing to the contrary.

### 6. An optional capability, consented where it is used

Live sessions are `sharing.live` under the **Sharing** feature. The join
road opens on the capability's review — the relays, STUN and the peer
connection among its egress — and Apply is the consent, recorded as a
`ConsentReceipt` for the capability's exposure digest before the module
loads; an owner switches it on the same way in Settings › Capabilities.
The relays an owner hosts on are `liveRelays` in Settings › Capabilities'
`config.yaml` (ADR 0134): `wss://` addresses, at most five, empty for the
built-in public three. A joiner always uses the relays the link names.

The module contributes the `/live` join screen (`gate: "any"`: it holds no
vault key) and the Live session panel under Settings › Vaults. The sessions
themselves live in app-core (`lib/live/session.ts`), so re-planning the page
— every lock, unlock and consent commit — never drops a joiner.

## Consequences

- An invited person can join from github.io, from a phone, with no account
  and no Host; the owner only has to keep the tab open.
- The owner's IP address reaches admitted joiners (not askers) unless the
  owner sets relay-only mode with a TURN server; the setting says so.
- Public relays can see that two ephemeral keys exchanged a few messages, and
  when. They cannot read them or join the session.
- The Host-based ceremony of ADR 0136 remains for sessions a Host runs; the
  door's road opens the live join, and a Host invite link still opens the
  Host ceremony.
- `verify:live-join` proves the whole road in two real browser contexts over
  real WebRTC, with a relay in the test process that records every frame.
- Rejected: BitTorrent-tracker signalling through a library that connects
  peers before the application can admit anyone (ADR 0079's objection
  stands); copy/paste signalling (kept possible, not the default).
