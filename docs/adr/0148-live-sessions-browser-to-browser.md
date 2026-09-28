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

Two browsers can talk directly over WebRTC, but only after each has the
other's session description. The usual way to carry them is a signalling
server, and the usual way to find an address is a STUN server. Both are
somebody else's service, and this product may not depend on one: a static
front end is complete without a backend (ADR 0090), and joining must not be
the exception. ADR 0079 rejected WebRTC because a naive design exchanges
network addresses before the owner has admitted anybody: a stranger asking to
join would learn the owner's IP address.

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
**open** (anyone holding the link is let in as they ask). The tab hosts the
session: closing it, locking the vault, or the time running out ends it for
everyone. Nothing about a session is written to storage on either side.

### 3. The browsers pair by two codes the people pass each other

There is no signalling server, relay or STUN/TURN server — ours or anyone's.
The two people already talk (that is how the link reached the joiner), and
the handshake rides that same channel as two sealed codes:

1. The **link** carries the session's ECDSA P-256 public key and a 32-byte
   link secret, in the fragment only, on the app's own root:

   ```
   …/#live=v1.<i|o>.<owner-pubkey-b64url>.<link-secret-b64url>
   ```

   The root, not a path of its own: a fresh load there always meets the
   unlock screen, whose join road takes the link (boot has already removed
   it from the address bar and history), and a deep path is a 404 on GitHub
   Pages. `i` is an invite session, `o` an open one. The link names no
   server.
2. The joiner's page makes its WebRTC offer and seals it, with the person's
   name and note, into a **request code** (`osl-request.…`): AES-256-GCM
   under HKDF-SHA256(link secret, salt = the code, info = purpose), with the
   purpose and owner key as additional data. The person sends it to the
   owner.
3. The owner pastes it. A code that does not open with this link and code is
   a **miss**; the fifth ends the session (the ADR 0044 rule). Text that is
   not a well-formed code at all is not counted. A request that opens waits
   for the owner — or, in an open session, is let in at once.
4. Letting someone in answers their offer, and the answer is sealed into a
   **reply code** (`osl-reply.…`), bound to that request's id and **signed
   by the owner key**. The owner sends it back.
5. The joiner pastes the reply. Its page accepts only one the owner key
   signed, that opens with this link and code, and that answers its own
   request; the browsers then connect directly.

Codes forgive what chat apps wrap around them (whitespace, quotes) and are
refused whole otherwise.

### 4. No address before admission, and no third party at all

The joiner's request carries the joiner's own addresses to the owner it
chose to contact, sealed. The owner's addresses leave only in a reply, so
nobody the owner turned away — or never let in — learns where the owner is.
Every `RTCPeerConnection` is made with **no ICE server**: each browser offers
only its own host candidates (Chromium hides local addresses behind mDNS
names), and the two reach each other directly — on the same network, or
wherever a route between them exists — or not at all. When no route exists
the joiner's page says so instead of waiting. The DTLS fingerprints travel
inside the sealed, signed codes, so nobody who carries a code can put
themselves in the middle of the connection.

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

Live sessions are `sharing.live` under the **Sharing** feature. Its only
egress is the peer connection to the other browser and the codes a person
copies. The join road opens on the capability's review, and Apply is the
consent, recorded as a `ConsentReceipt` for the capability's exposure digest
before the module loads; an owner switches it on the same way in Settings ›
Capabilities.

The module contributes the `/live` join screen (`gate: "any"`: it holds no
vault key) and the Live session panel under Settings › Vaults. The sessions
themselves live in app-core (`lib/live/session.ts`), so re-planning the page
— every lock, unlock and consent commit — never drops a joiner.

## Consequences

- An invited person can join from github.io, from a phone, with no account,
  no Host and no third-party service; the owner only has to keep the tab
  open.
- Pairing takes one more step than a link: the joiner sends a request code
  and pastes back a reply code.
- Two browsers with no direct route between them — behind separate NATs that
  do not allow it — cannot pair. A STUN or TURN server would fix that at the
  cost of a third party; if one is ever added it is an operator's own,
  configured and consented, never a default.
- The owner's IP address reaches admitted joiners only.
- `verify:live-join` proves the whole road in two real browser contexts over
  real WebRTC: codes passed through each context's clipboard, no WebSocket
  opened, no request off the origin, no ICE server on either peer.
- The Host-based ceremony of ADR 0136 remains for sessions a Host runs; the
  door's road opens the live join, and a Host invite link still opens the
  Host ceremony.
- Rejected: signalling over public relays (Nostr, a BitTorrent tracker) or
  any hosted signalling server, and public STUN servers — each makes joining
  depend on someone else's service.
