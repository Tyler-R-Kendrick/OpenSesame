# Live sessions across networks

A live session ([ADR 0150](../adr/0150-live-sessions-browser-to-browser.md))
connects the owner's open tab to each joiner's browser over WebRTC. With
nothing configured, the two browsers pair by two codes the people pass each
other and connect directly, with no server of anyone's. That works when both
are on the same network.

Everything on this page is optional, and everything is yours: the product
ships no relay, carrier, STUN or TURN server, and uses none unless you name
it. You name routes in **Settings › Live sessions › Routes**. The same
profile is the file `settings/live/transport.json`, sealed in the vault, so
it can hold credentials:

```json
{
  "addresses": ["100.101.102.103"],
  "ice": [
    { "urls": ["turns:turn.example.com:443?transport=tcp"], "secret": "coturn-static-auth-secret" }
  ],
  "relay": false,
  "carriers": [
    { "kind": "ntfy", "url": "https://ntfy.owner.tailnet.ts.net" },
    { "kind": "mqtt", "url": "wss://mqtt.example.com/mqtt", "username": "live", "password": "…" }
  ]
}
```

Two different problems are solved here, and they have different answers:

| Problem | What solves it |
|---|---|
| The **codes** have to reach the other person | By hand (always works), or a **carrier** that passes them |
| The **peer connection** has to reach the other browser | Same network, a **tunnel address**, or a **TURN** server |

## Addresses: a tailnet or VPN you already run

Browsers hide their local addresses behind mDNS names (`<uuid>.local`), which
resolve only on the same link. Across a tunnel, the other side cannot
resolve them, so neither browser has anywhere to send its checks. Name the
address where **this device** is reachable, and the owner's answer adds a
candidate at that address beside each hidden one. One side is enough: the
joiner's checks reach the owner through the tunnel, and ICE learns the
joiner's address from them.

| Tunnel | Address to add |
|---|---|
| Tailscale | `tailscale ip -4` (a `100.x.y.z`), or `-6` |
| WireGuard | the interface address in `[Interface] Address` |
| Pangolin (Newt / Olm clients) | the device's address on the Pangolin network |
| Cloudflare WARP (Zero Trust private network) | the device's WARP virtual IP |
| NetBird, ZeroTier | the device's overlay address |
| Same LAN, mDNS blocked by a managed network | the device's LAN address |

The joiner must be on the same tunnel, or able to route to that address.
Addresses stay with the owner and are never in the link.

On managed Chrome you can instead stop the browser from hiding addresses on
your deployment's origin with the enterprise policy
[`WebRtcLocalIpsAllowedUrls`](https://chromeenterprise.google/policies/#WebRtcLocalIpsAllowedUrls).
The browser then offers its tunnel address itself.

## TURN: when nothing routes between the two

TURN relays the connection through a server both browsers can reach. Run your
own, for example [coturn](https://github.com/coturn/coturn), and use a shared
secret so each session mints credentials that expire with it:

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=443
use-auth-secret
static-auth-secret=coturn-static-auth-secret
realm=turn.example.com
cert=/etc/ssl/turn.pem
pkey=/etc/ssl/turn.key
```

In Routes, add `turn:turn.example.com:3478` (UDP) and
`turns:turn.example.com:443?transport=tcp` (TLS over TCP, which passes most
firewalls). Put the `static-auth-secret` in the file as `"secret"`, not in the
Form's credential field. The link then carries only a credential minted for
this session (`<expiry>:osl`, HMAC-SHA1), never the secret.

Where the TURN server can live:

- **On a tailnet node.** Joiners on the tailnet reach it at its `100.x`
  address. Pair it with the owner's address above if joiners can route to the
  owner directly.
- **Behind Pangolin.** Publish it as a raw TCP (and UDP) resource through
  Newt; name the Pangolin host in the `turns:` URL.
- **Behind Tailscale Funnel.** `tailscale funnel --tcp 443 tcp://localhost:443`
  exposes `turns:` to joiners outside the tailnet.
- **Not behind a Cloudflare Tunnel's public hostname.** A public hostname
  proxies HTTP(S) and WebSocket, not raw TCP or UDP, so TURN does not pass.
  Use Cloudflare Tunnel for the carriers below; for TURN, use WARP-connected
  devices (addresses above), another route, or Cloudflare's own TURN service.
  Cloudflare's TURN is a third party; its credentials are minted by an API
  call you make, and you paste them in with an expiry that suits you.

**Relay only** makes both browsers use TURN alone
(`iceTransportPolicy: "relay"`): neither learns the other's address. It needs
at least one TURN server.

## Carriers: so nobody pastes codes

A carrier passes the two codes. It sees only a topic derived from the link
secret, which only link holders can name, and sealed codes on it:

- A request can be read only by the owner.
- A reply can be read only by its joiner.
- Anything else posted to the topic fails the outer seal and never counts as
  a guess.

Pasting by hand keeps working beside any carrier.

A page served over https can open only `wss://` and `https://` connections,
except to the device itself (`ws://127.0.0.1`), so a carrier needs a TLS name.
`tailscale serve`, a Cloudflare Tunnel public hostname and a Pangolin resource
all give it one.

| Kind | Server | Minimal setup |
|---|---|---|
| `ntfy` | [ntfy](https://ntfy.sh) | `ntfy serve` with a `cache-duration` (so a code posted during a reconnect is kept); topics are created on first use. A token or user/password goes in the file. |
| `nostr` | any NIP-01 relay ([strfry](https://github.com/hoytech/strfry), [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay)) | Must pass ephemeral kind 25050 events and index the `t` tag. |
| `mqtt` | Mosquitto, EMQX, NanoMQ, HiveMQ | Mosquitto: `listener 9001` + `protocol websockets`. Topic `opensesame/live/<topic>`, QoS 1. |
| `nats` | [nats-server](https://nats.io) | `websocket { port: 8443, tls { … } }`. Subject `opensesame.live.<topic>`; grant `opensesame.live.>` to the user or token you name. |
| `broadcast` | this browser | Owner and joiner in two tabs of one browser profile. Nothing leaves the device. |

Publishing a carrier:

```yaml
# cloudflared config.yml: WebSocket and HTTPS pass a Cloudflare Tunnel
ingress:
  - hostname: ntfy.example.com
    service: http://localhost:8080
  - hostname: relay.example.com
    service: http://localhost:7777
  - service: http_status:404
```

```bash
# Tailscale: a TLS name on the tailnet for a carrier on this machine
tailscale serve --bg --https=443 http://localhost:8080
# → https://<machine>.<tailnet>.ts.net
```

A carrier's credentials travel in the link to every joiner, so give it a user
that may only publish and subscribe under the live-session topic prefix.

Browsers may ask the person before a public page reaches a carrier on a
tailnet or LAN address. Chrome calls this Local Network Access, and the
prompt reads "Allow access to devices on your local network". Allowing it is
the browser's consent, on top of the join screen's.

## What the joiner sees

When a link names routes, the join screen lists every host the joiner's
browser would contact, as **Through turn.example.com, ntfy.example.com**,
checked. They can keep them, or clear the box and pair directly by hand.
Nothing is contacted before they ask, and declining leaves no trace on any
carrier.

While a request is out, each carrier shows as **Connecting**, **Carrying
codes**, **Unreachable** or **Blocked by this installation**. A session that
could not connect ends with **No route to the owner's browser**.

## Under a hardened deployment

An instance policy
([capability composition](capability-composition.md)) governs Live sessions
like any optional capability, and a carrier is external service egress:

- **The operator can prohibit `sharing.live`.** Nothing of it loads; the join
  road and the Settings tab are absent. If the plan stops approving it while a
  session is running — the operator withdrew it, or the person switched Live
  sessions off in Settings › Capabilities — the session ends at once, hosted
  or joined: the peer connection, the carriers and ntfy's stream are closed.
  A lock, an unlock or a consent commit re-plans the page but still approves
  it, and drops nobody.
- **Carriers must be listed.** With `externalServices: allow` and a non-empty
  `allowedServiceOrigins`, list each carrier's own origin: `https://` for
  ntfy, `wss://` for Nostr, MQTT and NATS (`wss://relay.example.com`, with the
  port if it is not 443). `https://relay.example.com` does not cover
  `wss://relay.example.com`: a Content-Security-Policy `https:` source does
  not admit a WebSocket, so a deployment that sends headers needs the `wss://`
  entry to open one at all. Plain `ws://` and `http://` are only for the
  device itself (loopback).
- **What the person sees.** A carrier the plan does not allow is refused
  before any socket opens or request leaves, and it shows as **Blocked by this
  installation: relay.example.com**, apart from **Unreachable**, which means
  the server did not answer. The other carriers, and pasting codes by hand,
  carry on. ntfy's requests go through the same egress gate as every other
  optional module: no redirects, no cookies, checked against the current plan
  on each request.
- **STUN and TURN are not covered.** They are WebRTC, which `connect-src` and
  `allowedServiceOrigins` do not govern. The joiner still sees every host
  before any is contacted, but a policy cannot narrow them; to keep them out,
  prohibit `sharing.live`, or leave Routes without ICE servers.
- **The shipped page's own `<meta>` policy allows every `https:` and `wss:`
  connection** (`index.html`), so on GitHub Pages the plan and allowlist are
  the gate. The policy `scripts/security-headers.mjs` generates from a profile
  (the header, or its `metaCsp` on a host that cannot send headers) is
  stricter, and lists each `wss://` origin in `connect-src` only while
  external services are allowed.

## Checking a setup

`pnpm --filter @opensesame/pages verify:live-join` runs every road in real
browsers over real WebRTC:

- direct pairing;
- a simulated tailnet, which never connects without the address and connects
  at it with one;
- each carrier, with nothing pasted:
  - Nostr (a relay in the test process);
  - MQTT (aedes);
  - NATS: a real nats-server, set by `LIVE_NATS_SERVER` or the mTLS fixture pin;
  - ntfy: a real ntfy server, set by `LIVE_NTFY_SERVER`;
  - BroadcastChannel;
- relay-only through a real TURN server.

`LIVE_CARRIERS=nostr,mqtt` limits which carriers run. A missing server fails
the run; it is never skipped silently.
