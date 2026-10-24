# Live sessions admit only the ICE candidates a session names

## Scope

`packages/app-core/src/lib/live`: how a browser in a live session (ADR 0150)
reads the offer or answer the other browser sends, before handing it to
`setRemoteDescription`. It follows the 2026-10-23 security remediation
(97d68ee57), which added the filter this audit narrows.

## Invariant

A peer must not be able to steer this browser's ICE connectivity checks at a
host on its loopback, private, link-local or otherwise non-public network,
beyond what the session itself names. A check is a STUN binding request to an
address and port the remote description lists; it can reach a host the page
itself could never fetch.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium (availability) | The 2026-10-23 filter (`filterDataChannelSdp`) dropped every candidate at a non-public literal from every received offer and answer. That closed the probe, but also dropped the address hints ADR 0150 §6 adds on purpose: the address an owner names in Routes (a tailnet, VPN or LAN address), and the same-machine hints 127.0.0.1 and ::1 a session offers when it names none. Two browsers then met only where mDNS names resolve, so joining across a tunnel, and joining on one machine, stopped working (`verify:live-join` direct and tunnel walks, `verify:live-local-pair`). | The filter takes an explicit allowlist: exactly the addresses the session names, compared as canonical IP literals. Every other non-public literal is still dropped, and mDNS names are handled as before. |

## The rule

- **Exact addresses only.** An IPv4 literal is compared as written (the reader
  admits no leading zeros), an IPv6 literal in the canonical form the URL
  parser prints. No prefix, no range or CIDR, and no name resolution: a host
  name is never an allowlist entry and never matches one.
- **The owner, answering a joiner's offer,** admits the addresses it named in
  Routes and the same-machine hints. These are the same addresses
  `withAddressHints` adds to the owner's own answer.
- **The owner's reply** names its Routes addresses in a new `addresses` field:
  at most eight canonical IP literals, sealed to the one joiner let in, the
  only place ADR 0150 §4 lets the owner's address go. A relay seat names none.
- **The joiner, taking that reply,** admits the addresses it names and the
  same-machine hints. A reply whose `addresses` is not an array of at most
  eight canonical, usable IP literals is refused whole. A reply without the
  field, from an owner on an earlier build, admits only the same-machine
  hints.

## Residual risk

- An owner the joiner chose to join can make the joiner's browser send ICE
  checks to at most eight literal addresses that the owner names, in a reply
  sealed to that joiner. That is no wider than before 97d68ee57, when every
  candidate in the reply was used, and much narrower than an unfiltered
  description.
- A joiner holding the link can make the owner's browser check only the
  owner's own named addresses and the loopback defaults.
- Both sides always admit 127.0.0.1 and ::1, so a peer can make a browser send
  STUN binding requests to ports on its own loopback interface. They stay
  because ADR 0150 offers same-machine sessions: two browsers on one machine
  meet over loopback, which mDNS names cannot give them. A binding request
  carries no payload a non-ICE service would act on, and the port a check
  reaches is one the peer names, not one it can learn from this browser.
- No new prompt: the owner's address is the peer's own candidate, not a third
  party the link names. The joiner's listing of hosts before contact (ADR 0150
  §6) covers the link's STUN/TURN servers and carriers, and is unchanged.

## Tests

`packages/app-core/src/lib/live/named-addresses.test.ts`: a named Routes
address is kept and the same description with nothing named drops it (the
negative control: without the allowlist the named-address test fails); the
loopback defaults are kept; unnamed RFC 1918, link-local, other-loopback
(127.0.0.2) and IPv4-mapped private addresses are dropped; an address one octet
off is dropped; IPv6 is compared canonically; a host name is not resolved; a
reply carries canonical Routes addresses and none on a relay seat; a reply
with malformed `addresses` is refused; a reply without them admits only
loopback. `sdp.test.ts` keeps its filter test, now against an empty
allowlist.
