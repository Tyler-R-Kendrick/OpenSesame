# mDNS Device Discovery

Status: explored; not a runtime transport yet.

The question is whether mDNS can replace Tailscale as the default way this PWA
finds a vault drive or another OpenSesame device. The short answer is **not for
the vault drive**, and **yes as a supplemental discovery path** for a native
daemon on the same LAN.

## Why the browser cannot do this alone

`fetch("http://device.local")` can resolve a name through the operating
system's mDNS resolver, and Local Network Access handles the permission and
mixed-content side. But the browser exposes no DNS-SD browse API:

- there is no `navigator.mdns` or query API;
- WebRTC's `.local` ICE candidates are per-connection, obfuscated and not a
  service directory;
- a PWA cannot send or receive multicast UDP;
- probing every address on a subnet would be a network scan, is slow, is
  blocked by many networks, and is the opposite of a privacy-preserving
  default.

So discovery has to live in a native process. That process is the existing
`opensesame daemon` (or a small discovery helper beside it), and the PWA talks
to it over loopback with the existing LNA loopback permission.

## Proposed service

The native daemon advertises one DNS-SD service:

```text
_opensesame._tcp.local
```

Suggested TXT record, all public metadata:

```text
v=1
name=Kitchen Mac
api=https://kitchen-mac.tailnet.ts.net
caps=pair,drive,plugin
```

No key, slot secret, vault name, account name or token goes in the TXT record.
mDNS is unauthenticated and visible to the LAN. The record says only “an
OpenSesame daemon is here and can be asked to pair”; it never grants anything.

The PWA contract is a loopback-only read:

```http
GET /v1/lan/peers
```

with the same operator/same-user rule as the rest of the daemon. The answer is
a bounded list of verified records:

```json
{
  "peers": [
    {
      "id": "sha256:...",
      "name": "Kitchen Mac",
      "api": "https://kitchen-mac.tailnet.ts.net",
      "capabilities": ["pair", "drive", "plugin"],
      "addresses": ["192.168.1.20"],
      "lastSeenAt": "2026-10-21T12:00:00Z"
    }
  ]
}
```

`api` is chosen from a record the daemon can reach; `addresses` are display and
diagnostic hints, never automatically trusted. The PWA still performs its own
endpoint validation and pairing proof.

## Why this does not replace Tailscale for vault sync

Tailscale currently supplies three things mDNS does not:

1. **Encrypted transport.** The vault drive sends a slot key as a bearer over
   HTTPS through Tailscale Serve. LAN mDNS would advertise a plain HTTP target
   by default; sending that bearer over Wi-Fi exposes it to the LAN until a
   native TLS or Noise listener exists.
2. **Identity and reachability.** A Tailscale name is bound to a node identity
   and works across networks and NAT. mDNS is link-local and fails on guest
   Wi-Fi, client isolation, many corporate networks, and most VPNs.
3. **Stable naming.** `.local` collisions and multicast blocking make mDNS a
   poor default for “my vault is on that machine”.

The existing slot protocol is already transport-agnostic: a slot is one opaque
snapshot plus parts and a compare-and-set generation. LAN can carry exactly the
same protocol later, but only behind a secure listener and a pinned identity.
That is a separate native-transport project, not a discovery change.

## Decision

- **Tailscale remains the default vault-drive transport.**
- **mDNS is a supplemental discovery path** for a native daemon on the same
  LAN, opt-in and visible as “Nearby devices”.
- **No automatic pairing from discovery.** A discovered peer becomes a row with
  a Pair key; the person still approves, and the existing code/DPoP/session
  proof is still required.
- **Tailscale stays installed.** Its providers, drive, device management and
  tutorials are unchanged. mDNS does not replace the `networking.tailnet`
  capability.

If a future native listener has TLS/Noise, certificate or key pinning, and a
bounded LAN exposure policy, the same discovery record can make LAN the default
for same-network drives. Tailscale then remains the remote and fallback path.
That decision needs its own ADR and threat model.

## Native implementation plan

1. New `crates/lan-discovery` module using the platform's existing multicast
   support. It advertises and browses `_opensesame._tcp.local`, parses bounded
   DNS-SD records, and expires stale entries. No browser or vault dependency.
2. Daemon route `GET /v1/lan/peers`, loopback/operator only, returning the
   schema above. Advertise only when `--lan-advertise` (or a Settings switch)
   names the API URL; default off.
3. PWA client contract in app-core: bounded JSON parse, endpoint validation,
   a 5-second timeout, and no secret in the request. Wire a “Nearby devices”
   list into Settings › Integrations › Networking when the daemon is paired.
4. Pairing handoff fills the daemon address only; it never fills a slot key.
   The person still pastes/approves the existing code.
5. Tests: packet fixtures for PTR/SRV/TXT/A/AAAA and compression pointers;
   stale-record expiry; a malformed TXT has no effect; no key-shaped field is
   accepted; endpoint validation rejects public URLs and HTTP off loopback.
6. Optional follow-up: a local-only TLS listener with a pinned daemon key.
   Without that, no LAN vault-drive bearer.

## Operational limits

- mDNS is LAN-only and multicast; AP isolation, guest networks and many
  corporate Wi-Fi networks block it.
- It does not cross Tailscale, WireGuard or the public internet.
- Record spoofing is expected. Name, TXT and address are untrusted display
  hints; authorization never depends on them.
- The daemon's existing dependency budget stays a hard gate. Discovery must
  not pull in a WebSocket, TLS or database stack.
- No discovery record may contain a secret, a vault name or a user identity.

## Acceptance

- The browser performs no multicast and no subnet scan.
- A discovered peer is a hint, not a trust decision.
- A discovered peer with a public or malformed `api` is rejected.
- Tailscale remains available with its existing capabilities and tests.
- Turning discovery off leaves all existing Tailscale and loopback paths
  unchanged.
