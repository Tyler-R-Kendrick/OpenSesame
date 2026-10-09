# ADR 0150 — Live sessions: joining someone's vault browser to browser

- Status: Accepted
- Date: 2026-09-28
- Amended by: [ADR 0167](0167-nats-live-session-route.md) (§3 what a link
  carries, §5 what crosses the peer channel, §6 carriers pass codes only)
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
(the whole vault or chosen items), how (`read` shows values, `use` — Copy
only — keeps a concealed value off the joiner's screen and clipboard, `edit`
lets the joiner replace a shared field in the open vault), for how long (at
most eight hours), and who gets in — **invite** (a link plus an out-of-band
code, the ADR 0044 shape) or
**open** (anyone holding the link is let in as they ask). The tab hosts the
session: closing it, locking the vault, or the time running out ends it for
everyone. The session itself is not written to storage on either side. An
authorized edit writes that one shared field back into the open vault.

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
   Pages. `i` is an invite session, `o` an open one. Each key has one
   spelling: a link whose owner key or secret is not the canonical base64url
   of its bytes is refused, because the owner's seal binds the key's text and
   an alias would parse and then be dropped without a word.

   **The link is a bearer, and its routes segment is encoded, not
   encrypted.** Every holder of the link reads it. A carrier's username,
   password or token, and a TURN or STUN server's *static* username and
   credential, are in it in the clear, for every joiner, and they stay valid
   for as long as the owner's server honours them — not just for the session.
   Only a TURN REST secret (§6) never travels: the link carries the
   credential minted from it, which expires with the session. An owner who
   names a static credential is handing it to everyone the link reaches, and
   should name one made for this (a topic-scoped carrier token, a TURN user
   with a quota) and rotate it after.
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
   the wrong code: a **miss**, a guess at the out-of-band code (the ADR 0044
   rule), so only an **invite** session counts them, and the same wrong code
   again is one miss, not two. An open session has no code to guess: a
   request that does not open there is not a request and is never a miss.

   The fifth miss **locks** an invite session; it does not end it. A locked
   session takes no new request — right code or wrong — but everyone already
   asking or in stays: a pending asker can still be let in, a guest in still
   asks for values, and a request already seated is still answered with the
   same reply. Ending the session on the fifth miss, as ADR 0044's claim link
   does, would let anyone holding the link, who need not know the code, throw
   out every guest already in; the lock leaves them the session and leaves
   the owner the end key. The owner's view shows the lock as a single mark.
   The lock does not lift: the owner ends the session and starts another.

   A request that opens waits for the owner — or, in an open session, is let
   in at once. It does not wait for ever: a seat that is asking or was let in
   but never connects expires after the pairing window (15 minutes), so
   requests that never finish cannot fill the eight seats; a seat that has
   ended is forgotten a minute later, and its request is not seated again if
   a carrier reposts it. Letting in is one admission per seat: a second press
   while the browser is still answering does nothing, and a seat turned away
   or ended in that window leaves no connection open.
4. Letting someone in answers their offer, and the answer is sealed into a
   **reply code** (`osl-reply.…`) under the same key material as the request
   (ECDH of the two session keys and the link secret, salt = the code) with
   the purpose `reply`, and the joiner's key and the request's id as
   additional data. Only that joiner can read it, and only the owner could
   have made it.
5. The joiner's page accepts only a reply that opens under its own request's
   key and answers its own request; the browsers then connect.

The catalog the owner then sends — names, types and unconcealed fields — is one
data-channel message, and Chromium refuses one over 256 KiB (`send` throws).
A vault at the limits (200 items of 32 fields with 16 KiB of text) is well
past that, so the catalog is cut to 200 000 bytes before it is sent (bytes,
not characters): unconcealed text is clipped shorter, in steps, and marked
with an ellipsis where it was cut so a copy of it is not taken for the whole
value, and only if names alone still do not fit are the last items left out.
Every check the owner makes on a request uses this same catalog, so an item
the joiner was not shown cannot be revealed from, and a vault is fitted once
for as long as its items are the same. A frame that still cannot go out, or
that the browser refuses, ends the seat; the guest is not counted as joined.

Codes forgive what chat apps wrap around them (whitespace, quotes) and are
refused whole otherwise. Another joiner holding the same link and code can
read neither someone else's request nor the reply to it.

What is inside a request is read strictly, because it comes from someone the
owner has not yet let in. The **name and note** are shown to the owner, so
control, format (zero-width, bidi override and isolate, tags, soft hyphen),
private-use and blank-filler characters and line breaks are removed or read
as a space, runs of space collapse, and only then are the length caps
applied: nobody can be shown a name that hides, reorders or imitates the text
around it (look-alike letters from other scripts remain, and the owner
should be told who to expect out of band). The **session description** must
be exactly one SCTP data-channel section: no other media section, candidates
with an IP or an mDNS name and a real port, a bounded number of them, and
only attributes shaped like the ones browsers send — an attribute nobody has
met is let through if it is shaped like one, because refusing a real
browser's offer costs a person their join. The real offers and answers of
Chromium (mDNS on and off, with STUN and TURN, relay only) are the test
vectors; Firefox's and Safari's shapes are written from their published
output and not captured here.

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
session's on-screen log. Under `use` (Copy only) both are refused: the
concealed plaintext does not cross, and the joiner's page does not write it
to the clipboard. Under `read` or `edit`, a copy the joiner asks for may be
written to their clipboard. Under `edit`, an `edit` request replaces one
shared field in the open vault. The session itself is still not stored. The
joiner keeps received values in memory, drops them the moment the channel
closes, and never writes them to storage.

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
  that expire with the session, so a REST secret never travels in the link. (A
  static TURN credential and a carrier's password do; see §3.)
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
carrier (every network kind above is WebSocket or HTTPS), not the peer connection.
The peer connection itself crosses a tunnel that routes IP (Tailscale, WARP,
WireGuard, Pangolin's clients) through an address hint, or anything at all
through TURN.

The link carries what the joiner needs — the ICE servers, relay only, and the
carriers — and a link that asks for relay only without naming a TURN server is
refused whole, as the owner's profile refuses it, since a relay-only peer with
nowhere to relay would only hang. The joiner's page lists every host it names before anything
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

Optional does not mean ungoverned. A carrier is external-service egress: ntfy
fetches through the module's `EgressPort` (declared purpose, current plan,
`allowedServiceOrigins`, redirects refused, credentials omitted; the port is
http(s)-only but hands the streaming response back untouched), and the three
WebSocket kinds are asked of the same plan and allowlist before a socket
opens, against their own `wss://host` origin, because a CSP `https:` source
does not admit a WebSocket and the origin grammar now lists `wss://`. A
refusal is shown as blocked by this installation, not unreachable. STUN and
TURN are WebRTC and remain outside `connect-src`. Sessions are not tied to the
module's activation, but they are tied to its approval: when a resolved plan
stops approving `sharing.live` — an operator's withdrawal, or the person's
switch — `session.ts` ends the hosted session and leaves the joined one, and
closes their carriers; a re-plan that still approves it ends nothing.

A re-plan that still approves it can still change the network policy, and a
WebSocket stays open until something shuts it. So on every re-plan the
session asks the plan again about each carrier it holds (`carrier-policy.ts`,
the one rule the shell also asks before opening): a Nostr, MQTT or NATS
carrier that external services being denied, or its `wss://` origin leaving
the operator's list, no longer allows is closed and shown as blocked, and one
still opening is closed when it arrives. The session itself goes on, over the
carriers that remain and by hand. A carrier the policy allows again is not
reopened: the session names its carriers once. ntfy is held to the same plan
by the rule egress applies to it (its stream is one long request that egress
is not asked about again, though it also stops the loop at the first refusal),
and BroadcastChannel never leaves the browser.

A socket carrier at an address on this device or a LAN is also refused where
the deployment may not pair local authority (the shared GitHub Pages origin
may not): egress already says so for http, and a socket asks the same
question (`planRefusal`), so a public page cannot reach a local relay through
a WebSocket that it could not reach through a fetch.

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
- Whatever the owner puts in the routes reaches every joiner who keeps them,
  in the clear inside the link (§3): carrier usernames, passwords and tokens
  and static TURN credentials are shared with the whole audience of the link
  and outlive the session. Only a TURN REST secret does not travel. §6's
  "the link carries nothing that outlives it" holds for that case alone.
- A link holder without the code cannot end an invite session by guessing: the
  fifth wrong code locks it against new requests, and those already in are
  untouched. In an open session nothing is guessed, so nothing locks; the
  link alone admits, and the owner ends the session or refuses a seat to
  shut a joiner out. Anyone holding the link can still fill the eight seats
  with requests until they expire (15 minutes), and in an open session can
  occupy them; that is the price of a link that admits by itself.
- Starting a session is all-or-nothing and watches the vault from its first
  step: a vault that locks while the session is being built comes back ended
  and never current, and a start that fails — routes too long for a link,
  carriers that cannot be opened — leaves no host, no carrier and no lock
  watch behind.
- A carrier topic can be flooded by anyone who holds the link: frames are
  reassembled in a bounded table that drops the oldest partial code when it
  is full, so a flood costs a message a repost (each has a fresh id) and can
  no longer keep messages out for the length of the window.
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
  (`--ignore-certificate-errors-spki-list`), never by a blanket override; and
  through a server that authenticates with a TURN REST secret, where the owner
  types the secret into the profile file (the Form has no field for it), the
  app mints the credential, the link carries it and never the secret, and a
  server holding a different secret refuses every authentication.
- The Host-based ceremony of ADR 0136 remains for sessions a Host runs; the
  door's road opens the live join, and a Host invite link still opens the
  Host ceremony.
- Rejected: any default relay, carrier, STUN or TURN server, ours or a
  public one — each would make joining depend on someone else's service.
  They are the owner's to name, or absent.
- Operator guide: [`docs/operators/live-sessions.md`](../operators/live-sessions.md).
