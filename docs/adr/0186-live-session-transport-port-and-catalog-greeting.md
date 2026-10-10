# ADR 0186 — Live sessions run over a transport port, and the catalog answers a greeting

- **Status:** Accepted
- **Date:** 2026-10-10
- **Amends:** [ADR 0150](0150-live-sessions-browser-to-browser.md) (§3 what a
  request carries, §5 what crosses the peer channel)
- **Builds on:** [ADR 0167](0167-nats-live-session-route.md) (the NATS seat
  channel, whose first frame was already a greeting)

## Context

**The stall.** `verify:live-join`'s direct walk failed now and then: both
peer connections reported `connected`, the owner's view said *In the
session*, and the joiner sat on *Connecting to the owner's browser* until the
walk gave up. Instrumented, the joiner's data channel had opened and received
no frame at all; the owner had sent the catalog once, the instant its end of
the channel appeared (already `open` at the `datachannel` event), and the
send had succeeded.

A two-context repro in the pinned Chromium, with no app in it, made the
owner's side of the same handshake (no ICE server, no trickle) and sent one
frame: it was never delivered in 2 of 240 pairings when sent at the
`datachannel` event, and in 1 of 240 when sent from the `open` event. In
every loss, a second frame on the same channel arrived, and so did a frame
the other way. The browser can drop a side's first frame while the
connection stays up.

The protocol rested on exactly that frame. The joiner's connect timeout was
cleared when the channel opened, so the wait never ended; and the owner
counted the guest in on a successful `send`, which is not delivery.

**The retry.** The connect timeout's *Try connecting again* made a new offer
and applied the owner's old answer to it. That answer belongs to the old
offer — its ICE credentials and DTLS fingerprint — so the retry could never
connect.

**The coupling.** WebRTC ran through the joiner, the owner and the session:
an `RTCPeerConnection` factory, ICE settings typed as the browser's, SDP
validation inside the wire readers, and connection-state listeners. Another
transport — Trystero, say, which meets peers in a room over public signalling
relays — would have meant rewriting the session.

## Decision

### 1. A transport port

`lib/live/p2p.ts` states what a session asks of the link between two
browsers, and nothing more:

- `PeerTransport` — `readsOffer`/`readsAnswer` (read a handshake strictly,
  before anything else sees it), `dial()` (the joiner's side) and
  `answer(offer)` (the owner's, for one joiner let in);
- `PeerLink` — the opaque `handshake` sealed into the pairing code, the
  `channel` once the two meet, `onFailed` and `close`; the joiner's
  `DialLink` also `accept`s the owner's answer;
- `TransportFactory` — one transport per session, over the `PeerRouting` its
  link names (servers, relay only, address hints);
- `LiveChannel`, `FRAME_BYTES`, `PAIRING_MS` and `Inbox`, the frame-holding
  every channel shares.

The joiner, the owner and the session import only the port. The wire readers
take the transport's reader for a handshake instead of naming SDP. WebRTC is
one adapter (`webrtc.ts`, `webRtc(peers)`), and Pages composes it in
`live-hooks.ts`. A test double with no WebRTC in it (`p2p-fakes.ts`) runs a
session end to end and can lose frames on demand.

Whatever the transport, it keeps ADR 0150 §4: the owner's side starts only in
`answer`, which the owner calls after admission, and it reaches no server the
owner did not name. A Trystero adapter would dial by joining a fresh room
(the handshake naming it), answer by joining that room once the joiner is let
in, carry frames on one action and report a peer leaving as `onFailed`. Its
signalling relays are someone else's servers, so such a transport is an
owner's choice in Routes, never a default (ADR 0150 §6).

### 2. The catalog answers a greeting

- The joiner sends `hello` as soon as its channel opens, and again after
  200, 400, 800 and 1600 ms and then every 3.2 s, until the catalog arrives.
- The owner answers every greeting with the catalog, at most 32 a seat, and
  counts the guest in at the first greeting: the first word from the guest's
  end.
- The joiner's connect timeout, 60 s from the reply, now holds until the
  catalog rather than until the channel opens. When it passes, the link
  closes, so the owner sees the seat go, and the person may **ask again**: a
  fresh request, which the owner lets in like any other.
- The request carries `greets: true`. An owner from before reads past the
  field; a request without it is a joiner from before, which is sent the
  catalog unasked and counted in at once, as it was. `hello` was already in
  the vocabulary, as a relayed seat's first frame (ADR 0167).

### 3. A failure says what the channels did

On a failure, `verify:live-join` records each data channel's events and the
kind of every frame it sent and heard (never a body), and probes each open
channel both ways, so a lost frame on a live link reads differently from a
dead link.

## Consequences

- A lost frame costs a greeting interval, not the session.
- *In the session* on the owner's side means the guest was heard from.
- Joining takes one round trip more: the catalog follows a greeting.
- Two builds of different ages degrade to the old behaviour, never worse.
- An admitted guest can make the owner send the catalog at most 32 times.
- Another transport is a new adapter and one line in the shell; the session
  does not change.
- Rejected: a timing workaround in the WebRTC adapter (waiting for `open`, or
  a delay) — the repro lost a frame either way — and acknowledgement inside
  each transport, which every adapter would have to write again.
- `verify:live-join` still runs in no CI job (`scripts/lib/ci-gate-drivers.mjs`).
