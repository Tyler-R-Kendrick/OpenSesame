# ADR 0150 — Live sessions: joining someone's vault browser to browser

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

### 3. The browsers pair by two codes

The handshake is two sealed codes. By default the two people pass them to
each other over the channel they already talk on (that is how the link
reached the joiner); an owner may name a carrier that passes them instead
(§6). Either way, what protects them is the same:

1. The **link** carries the session's ECDH P-256 public key and a 32-byte
   link secret, in the fragment only, on the app's own root — and, only when
   the owner named routes (§6), a fifth segment with them:

   ```
   …/#live=v1.<i|o>.<owner-pubkey-b64url>.<link-secret-b64url>[.<routes-b64url>]
   ```

   The root, not a path of its own: a fresh load there always meets the
   unlock screen, whose join road takes the link (boot has already removed
   it from the address bar and history), and a deep path is a 404 on GitHub
   Pages. `i` is an invite session, `o` an open one.
2. The joiner's page makes its WebRTC offer and a fresh ECDH key, and seals
   the offer, with the person's name and note, into a **request code**
   (`osl-request.…`) in two layers. The inner layer is AES-256-GCM under
   HKDF-SHA256(ECDH(joiner, owner) ‖ link secret, salt = the code, info =
   purpose), with both keys as additional data: only the owner can read it.
   The outer layer is keyed by the link secret alone and carries the
   joiner's public key.
3. The owner's page opens it. What the link secret does not open was never
   a request — a stranger on a carrier, a stray paste — and is dropped
   uncounted. What opens outside but not inside came from a link holder with
   the wrong code: a **miss**, and the fifth ends the session (the ADR 0044
   rule). A request that opens waits for the owner — or, in an open session,
   is let in at once.
4. Letting someone in answers their offer, and the answer is sealed into a
   **reply code** (`osl-reply.…`) under the secret the owner shares with that
   request's key, bound to its id. Only that joiner can read it, and only the
   owner could have made it.
5. The joiner's page accepts only a reply that opens under its own request's
   key and answers its own request; the browsers then connect.

Codes forgive what chat apps wrap around them (whitespace, quotes) and are
refused whole otherwise. Another joiner holding the same link and code can
read neither someone else's request nor the reply to it.

### 4. No address before admission, and no third party by default

The joiner's request carries the joiner's own addresses to the owner, sealed
to the owner. The owner's addresses leave only in a reply sealed to the one
joiner let in, so nobody the owner turned away, never let in, or who merely
watches a carrier learns where the owner is. With no routes named, every
`RTCPeerConnection` is made with **no ICE server**: each browser offers only
its own host candidates (browsers hide local addresses behind mDNS names),
and the two reach each other directly — on the same network — or through
what §6 adds. When no route exists the joiner's page says so instead of
waiting. The DTLS fingerprints travel inside the sealed codes, so nobody who
carries a code can put themselves in the middle of the connection.

### 5. What crosses the peer channel

The owner's key never leaves its device. Over the data channel the owner
sends the shared items' names, types and non-concealed fields, and answers a
`reveal` or `copy` request for one concealed field at a time, re-checking
scope, policy and expiry on every request and recording each in the
session's on-screen log. The joiner keeps everything in memory, drops it the
moment the channel closes, and never writes it to storage. `use` is a
display policy: a browser that receives a value to copy can keep it, and the
page says nothing to the contrary.

### 6. Routes: every one optional, every one the owner's

Direct pairing needs nothing, and stays the default. What bridges two people
who are not on one network is the owner's to name, in Settings › Live
sessions › Routes, whose file is `settings/live/transport.json` (sealed in
the vault, ADR 0134). None is ever a default, and none is ours:

- **Addresses** — IP literals where this device is reachable through a
  tunnel: its Tailscale address, a WireGuard, Pangolin (Newt/Olm), Cloudflare
  WARP, ZeroTier or NetBird address, a LAN address. A browser hides its
  addresses behind mDNS names the far side of a tunnel cannot resolve, so the
  owner's answer adds, beside each host candidate, a copy at each address on
  the same port (the socket is bound to every interface). One side's hint is
  enough: the other side's address is learned from its checks (a
  peer-reflexive candidate). Addresses stay with the owner; the link does not
  carry them.
- **ICE servers** — STUN, and TURN over UDP, TCP or TLS on 443 (which passes a
  Pangolin raw TCP resource, a Tailscale Funnel TCP forward, or any TCP
  proxy). A TURN REST secret (coturn's `use-auth-secret`) mints credentials
  that expire with the session, so the link carries nothing that outlives it.
- **Relay only** — `iceTransportPolicy: "relay"` on both sides: neither
  browser learns the other's address; everything crosses the owner's TURN
  server.
- **Carriers** — relays that pass the two codes so nobody has to: a Nostr
  relay, an MQTT broker or a NATS server over WebSocket, an ntfy server, or
  this browser's own tabs (BroadcastChannel). Each carrier gets a topic
  derived from the link secret by HKDF — only link holders can name it — and
  frames of sealed codes small enough for ntfy's 4 KB message. What anyone
  else posts there fails the outer seal (§3) and is never counted. The
  joiner reposts an unanswered request, and the owner answers a repeated
  request with the same reply, so a carrier that drops one costs a retry.
  Pasting by hand works beside any carrier, always.

A Cloudflare Tunnel publishes HTTP(S) and WebSocket, not UDP: it carries a
carrier (every kind above is WebSocket or HTTPS), not the peer connection.
The peer connection itself crosses a tunnel that routes IP (Tailscale, WARP,
WireGuard, Pangolin's clients) through an address hint, or anything at all
through TURN.

The link carries what the joiner needs — the ICE servers, relay only, and the
carriers — and the joiner's page lists every host it names before anything
is contacted. The person keeps them or pairs directly by hand; declining
leaves no trace on any of them. A browser may also ask the person before a
public page reaches a carrier on a tailnet or LAN address (Chrome's Local
Network Access prompt); that is the browser's consent, on top of ours.

### 7. An optional capability, consented where it is used

Live sessions are `sharing.live` under the **Sharing** feature. Its egress is
the peer connection to the other browser, the codes a person copies, and —
only when the owner names them, and only for joiners who keep them — the
ICE servers and carriers of §6, each carrier's client loaded only then. The
join road opens on the capability's review, and Apply is the consent,
recorded as a `ConsentReceipt` for the capability's exposure digest before
the module loads; an owner switches it on the same way in Settings ›
Capabilities.

The module contributes the `/live` join screen (`gate: "any"`: it holds no
vault key) and the Settings › Live sessions tab (the session panel and
Routes). The sessions themselves live in app-core (`lib/live/session.ts`), so
re-planning the page — every lock, unlock and consent commit — never drops a
joiner.

## Consequences

- An invited person can join from github.io, from a phone, with no account,
  no Host and no third-party service; the owner only has to keep the tab
  open.
- With no routes, pairing takes one more step than a link: the joiner sends
  a request code and pastes back a reply code. With a carrier, it takes
  none: the owner is asked, and the joiner is in.
- Two browsers on different networks meet through what the owner runs: a
  tailnet address, a TURN server, or both. Nothing is anyone else's unless
  the owner chose it.
- The owner's IP address reaches admitted joiners only, and none at all
  under relay only.
- `verify:live-join` proves each road in real browser contexts over real
  WebRTC: direct by hand, with no WebSocket, no request off the origin and
  no ICE server; a simulated tailnet (mDNS on, only the tunnel address
  routes) that never connects without the address and connects at it with
  one; each carrier — an in-process Nostr relay, an aedes MQTT broker, a real
  nats-server and a real ntfy server, and BroadcastChannel — pairing with
  nothing pasted, and none of them seeing a name, value, SDP or the link
  secret; a joiner who declines the routes, unheard of on them; and relay
  only through a real TURN server, relay to relay, once for each way to reach
  one: `turn:` over UDP (node-turn), `turn:…?transport=tcp` and `turns:` (TLS)
  on a real pion/turn server (`scripts/test/live-turn`), which reports the
  transport each allocation arrived on — so the walk asserts the browsers used
  TCP and TLS, and that no client traffic reached the other listeners. The
  self-signed certificate is trusted by public key alone
  (`--ignore-certificate-errors-spki-list`), never by a blanket override.
- The Host-based ceremony of ADR 0136 remains for sessions a Host runs; the
  door's road opens the live join, and a Host invite link still opens the
  Host ceremony.
- Rejected: any default relay, carrier, STUN or TURN server, ours or a
  public one — each would make joining depend on someone else's service.
  They are the owner's to name, or absent.
- Operator guide: [`docs/operators/live-sessions.md`](../operators/live-sessions.md).
