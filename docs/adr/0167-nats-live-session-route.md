# ADR 0167 — A NATS server as a live session's route, served from the owner's tab

- Status: Accepted
- Date: 2026-10-05
- Amends: [ADR 0150](0150-live-sessions-browser-to-browser.md) §3 (what a
  link carries), §5 (what crosses the peer channel) and §6 (carriers pass
  codes only)
- Builds on: [ADR 0145](0145-nats-feature-usage.md) (how OpenSesame uses
  NATS), [ADR 0134](0134-item-type-marketplaces-and-settings-files.md)
  (Settings is files), [ADR 0158](0158-settings-rows-act-or-are-absent.md)
  (a row acts or is absent)

## Context

A NATS server named in Routes carried the two pairing codes and nothing
else. Two people who could exchange codes through it still could not meet
when WebRTC found no route between their browsers — a symmetric NAT on both
sides, a network that blocks UDP, no TURN server — even though both browsers
were already connected to a server that could carry the session. And it
signed in with a static user, password or token that travelled in the link
to every joiner, valid for as long as the server honoured it.

No backend is needed to close either gap. The owner's open tab is already
the session's server (ADR 0150 §2); over NATS it can be one in the protocol's
own sense, and a NATS server in operator mode trusts any user an account
signing key issued, which the tab can do itself.

## Decision

### 1. A session mints its own NATS credentials

A NATS carrier in the owner's profile may name `mint: { account, signingKey }`
— the account's public key (`A…`) and an account signing key's seed (`SA…`).
It lives only in the sealed profile (`settings/live/transport.json`); a link
that names `mint` is refused whole. When a session starts, the tab mints two
NATS user JWTs (v2, Ed25519, `@nats-io/nkeys`; `lib/live/nats-jwt.ts`), each
for a fresh user key, each expiring with the session, each allowed only
WebSocket connections:

- **the joiner's**, carried in the link: publish and subscribe on
  `opensesame.live.<topic>` and below, nothing else;
- **the owner's**, kept in the tab: the same, plus `$SRV.>` and one reply per
  request it receives, so it can answer as a service (§3).

The topic is the carrier topic ADR 0150 §6 already derives from the link
secret, so a minted credential reaches one session's subjects and no other's,
and stops working when the session would have ended. A carrier may still name
a static `jwt` and `seed` (a `.creds` file's halves), or a user, password or
token; those travel in the link as before, and the Routes panel says so. A
signing key and a static credential are not named together.

`pnpm dev:live-nats` (`scripts/dev/live-nats-operator.ts`, over
`lib/live/nats-operator.ts`) writes a server configuration in operator mode
with the operator, system and live accounts preloaded (`resolver: MEMORY`), a
WebSocket listener (`wss://` when given a certificate), the mint pair for
Routes (0600), and the operator's seed (0600, to keep offline). The account
signing key is not in the server's configuration.

### 2. The session may cross the server, sealed end to end

A NATS carrier says whether the session itself may cross it: `session:
"fallback"` (the default), `"always"` or `"off"` (codes only, as before). It
travels in the link, since the joiner acts on it. When a seat may cross, the
owner's reply says `relay: "nats"` and the owner listens on
`opensesame.live.<topic>.seat.<request id>`:

- under `fallback`, the joiner moves onto that subject when its peer
  connection fails, or has not connected after eight seconds;
- under `always`, it moves at once and makes no peer connection;
- the joiner opens with `hello`, and the owner adopts the seat on the first
  frame that opens, closing its own peer connection.
- a seat offered over the relay that has connected neither way after a
  minute is let go, as a failed peer route lets one go without a relay.

Every frame is sealed (`seat-channel.ts`, purpose `channel`) with the key
material the pairing already established: the ECDH secret the owner and that
joiner share, the link secret and, in an invite session, the out-of-band code.
A frame is bound to the seat (owner key, joiner key, request id), its
direction and its sequence number; a frame from another seat, the other
direction or an earlier moment does not open, and one that did is never
accepted twice. The same messages cross as over the data channel (ADR 0150
§5), under the same 250 kB frame limit and the same per-request checks of
scope, policy and expiry. The server, and anyone else holding the link, see
ciphertext and its length — what a TURN relay sees.

### 3. The owner's tab is a NATS service

On its own connection the owner's tab registers `opensesame-live` with the
NATS service API (`@nats-io/services`): it answers `$SRV.PING`, `$SRV.INFO`
and `$SRV.STATS` discovery, and `opensesame.live.<topic>.info` with
`{"live":true}` while the session runs. It says nothing else: no title, no
item, no count. A server that does not allow the registration costs the
service, never the carrier.

### 4. Routes asks for it

Settings › Live sessions › Routes asks, beside a NATS server's URL, how it
signs in (none, minted per session, a user JWT) with the fields each
needs, and the session route (if direct fails, always, codes only). Each NATS row carries its session route as a
choice that changes in place. Anything else a carrier needs is written in the
file, as before.

## Consequences

- Two people who can both reach the owner's NATS server always meet, without
  TURN, and the owner's server sees only sealed frames.
- A minted link stops working when its session would have ended, and reaches
  only its own session's subjects; the signing key never leaves the owner's
  sealed profile. A leaked link is worth one session.
- Joining over NATS discloses to the server operator what any carrier did
  (that a session ran, its frames' sizes and times), and now also the
  session's traffic volume.
- `verify:live-join` gains `nats-always` and `nats-fallback`: a real
  nats-server in operator mode configured by `pnpm dev:live-nats`, the
  signing key typed into the Routes Form, a value revealed with no peer
  connection up, the service answering `$SRV.PING` and `info`, and no
  plaintext in anything the server passed.
- MQTT, Nostr and ntfy still carry codes only; none has a per-session
  credential the tab can mint.
