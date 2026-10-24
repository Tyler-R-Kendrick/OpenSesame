# Live sessions admit only the ICE candidates a person authorized

## Scope

`packages/app-core/src/lib/live`, and the join screen in
`apps/pages/src/modules/sharing.live`. It covers how a browser in a live
session (ADR 0150) reads the offer or answer the other browser sends, before
handing it to `setRemoteDescription`. It follows the 2026-10-23 security
remediation (97d68ee57), which added the filter this audit narrows.

## Invariant

A peer must not be able to steer this browser's ICE connectivity checks at a
host on its loopback, private, link-local or otherwise non-public network,
unless this browser's person authorized that address. A check is a STUN
binding request to an address and port the remote description lists. It can
reach a host the page itself could never fetch, and it carries ICE
credentials the peer chose.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium (availability) | The 2026-10-23 filter (`filterDataChannelSdp`) dropped every candidate at a non-public literal from every received offer and answer. That closed the probe, but it also dropped the routes ADR 0150 §6 offers on purpose: the address an owner names in Routes (a tailnet, VPN or LAN address), the same-machine hints, and the relay candidates of a TURN server a person runs on their own network. Two browsers then met only where mDNS names resolve. | The filter takes an explicit allowlist of what this side authorized, below. |
| Medium (security) | The first version of this fix admitted, on the joiner's side, every address the owner's sealed reply named, and admitted 127.0.0.1 and ::1 on both sides by default. A malicious owner could make a joiner's browser check up to eight internal hosts, at ports and with ICE credentials of its choosing. A link holder in an open session could make the owner's browser check its loopback interface. | The joiner is asked before the reply's addresses are admitted. Loopback is a route only when named. |

## The rule

Only an exact address is compared. An IPv4 literal is compared as written,
since the reader admits no leading zeros. An IPv6 literal is compared in the
canonical form the URL parser prints. There is no prefix, no range or CIDR,
and no name resolution: a host name is never an allowlist entry and never
matches one.

A received description keeps a non-public candidate only at:

- **an address this side named itself in Routes.** For the owner answering
  a joiner's offer, this is the only source.
- **on the joiner's side, an address the owner's reply names that the joiner
  allowed.** The reply's `addresses` field holds at most eight canonical IP
  literals, sealed to the one joiner let in. A reply whose `addresses` is
  anything else is refused whole.
  - The joiner sees the addresses and decides before the owner's
    description is applied, so before any check.
  - Declining applies the description without them; the join goes on.
  - A reply without the field, from an owner on an earlier build, asks
    nothing and admits nothing.
- **loopback, only when named.** 127.0.0.1 and ::1 are admitted on neither
  side by default. The owner admits them when its Routes name this machine.
  The joiner admits them only by allowing a reply that names them.
- **for a relay candidate only, the literal host of a TURN server this side
  already reviewed.** For the owner, that is its own Routes. For the joiner,
  it is the link's servers it was shown before anything was contacted. A
  host candidate at the same address is still dropped.

## Why approving a peer is not authorizing its targets

The joiner chose this owner. The reply's seal proves the owner wrote the
addresses, and nothing more: it does not show the addresses are the owner's,
or that this browser may probe them. Treating the seal as authorization
would let anyone who can get a joiner to open their link aim that joiner's
browser at its own network.

ADR 0150 §6 already shows a joiner every host its browser would contact
before any is contacted. The reply's addresses are hosts like those, so they
are shown and allowed the same way. Letting a joiner in does not authorize
its offer's targets either: the owner admits only what its own Routes name.

## Residual risk

- A joiner who allows the reply's addresses lets the owner's browser be
  checked at up to eight literal addresses, at the ports and with the ICE
  credentials the owner chose. The joiner saw each address first.
- A TURN server a joiner kept from the link can relay from any address the
  server allocates. A relay candidate is admitted only at the server's own
  literal host, so a relay elsewhere on a private network is dropped. That
  deployment still works only when the relay and the host match.
- An owner whose Routes name this machine lets any joiner holding the link
  make the owner's browser send STUN binding requests to loopback ports the
  joiner names. A binding request carries no payload a non-ICE service acts
  on. The owner turns this on only for a same-machine session.

## Tests

- `packages/app-core/src/lib/live/named-addresses.test.ts` covers:
  - a named address is kept, and the same one dropped when nothing names it;
  - loopback is dropped unless named;
  - every named address is admitted, however many;
  - unnamed RFC 1918, link-local, other-loopback and IPv4-mapped addresses
    are dropped, and so is an address one octet off;
  - IPv6 is compared canonically, and a host name is never resolved;
  - a relay candidate is admitted only at a named TURN host, never as a host
    candidate there, and never through a STUN URL or a TURN host name;
  - reply parsing: strict `addresses`, at most eight named, and a reply
    without them admits nothing.
- `guest-addresses.test.ts` covers the joiner's hold: a reply that names
  addresses hands nothing to the transport until the person answers, Allow
  passes them, declining passes none and still joins, and only one answer
  counts.
- `webrtc.test.ts` drives the WebRTC transport:
  - a reply-named address reaches `setRemoteDescription` only once allowed;
  - the owner admits loopback only when its Routes name it;
  - a relay candidate at its own TURN host is kept on both sides, and
    dropped where that side names no TURN server.
- Negative controls: each of these checks fails when its rule is removed
  from the source.
- `apps/pages/src/modules/sharing.live/LiveJoinAddresses.test.tsx` covers
  the step's two keys.
- The browser walks (`verify:live-join`, `verify:live-local-pair`, the
  keyboard contract, `verify:live-netns`) name this machine in Routes where
  their browsers share one, and take the Allow step.
