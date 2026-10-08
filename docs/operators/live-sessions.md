# Live sessions across networks

A live session ([ADR 0150](../adr/0150-live-sessions-browser-to-browser.md))
connects the owner's open tab to each joiner's browser over WebRTC. With
nothing configured, the two browsers pair by two codes the people pass each
other and connect directly, with no server of anyone's. That works when both
are on the same network.

Everything on this page is optional, and everything is yours: the product
ships no relay, carrier, STUN or TURN server, and uses none unless the owner names
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
| WireGuard | the interface address in `[Interface] Address`, without the `/prefix` |
| Pangolin (Newt / Olm clients) | the device's address on the Pangolin network |
| Cloudflare WARP (Zero Trust private network) | the device's WARP virtual IP |
| NetBird, ZeroTier | the device's overlay address |
| Same LAN, mDNS blocked by a managed network | the device's LAN address |

The joiner must be on the same tunnel, or able to route to that address.
Addresses stay with the owner and are never in the link.

On managed Chrome you can instead stop the browser from hiding addresses on
your deployment's origin with the enterprise policy
[`WebRtcLocalIpsAllowedUrls`](https://chromeenterprise.google/policies/web-rtc-local-ips-allowed-urls/).
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
  Newt, on a port opened on the Pangolin server (raw resources do not share
  443); name the Pangolin host and that port in the `turns:` URL.
- **Behind Tailscale Funnel.** `tailscale funnel --tcp 443 tcp://localhost:443`
  exposes `turns:` to joiners outside the tailnet. Funnel carries TLS over TCP
  only, no UDP, and it is reached at the node's
  `<machine>.<tailnet>.ts.net` name, so the TURN certificate must be valid for
  that name and the `turns:` URL must use it.
- **Not behind a Cloudflare Tunnel's public hostname.** A public hostname
  proxies HTTP(S) and WebSocket, not raw TCP or UDP, and a browser reaches a
  tunnel only through such a public hostname, so TURN does not pass.
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
| `ntfy` | [ntfy](https://ntfy.sh) | `ntfy serve`; keep its message cache on (the default is 12 hours; do not set `cache-duration: 0`), so a code posted during a reconnect is kept; topics are created on first use. A token or user/password goes in the file. |
| `nostr` | any NIP-01 relay ([strfry](https://github.com/hoytech/strfry), [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay)) | Must pass ephemeral kind 25050 events and index the `t` tag. |
| `mqtt` | Mosquitto, EMQX, NanoMQ, HiveMQ | Mosquitto: `listener 9001` + `protocol websockets`, and a `password_file` or `allow_anonymous true`, since Mosquitto 2 refuses anonymous clients by default. Topic `opensesame/live/<topic>`, QoS 1. |
| `nats` | [nats-server](https://nats.io) | `pnpm dev:live-nats` writes a server in operator mode whose credentials each session mints ([below](#nats-a-credential-per-session-and-the-session-itself)). Or `websocket { port: 8443, tls { … } }` with a user or token granted `opensesame.live.>`. Subject `opensesame.live.<topic>`. |
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
with nothing else to lose. MQTT and NATS can restrict a user to the
live-session prefix (`opensesame/live/#`, `opensesame.live.>`); ntfy and Nostr
topics have no prefix to restrict to, so give them a token or account used for
nothing else.

### NATS: a credential per session, and the session itself

A NATS server can do two things the other carriers cannot
([ADR 0167](../adr/0167-nats-live-session-route.md)):

- **Mint a credential per session.** In operator mode the server trusts any
  user an account signing key issues. Give Routes that key and each session
  mints two user credentials from it: one for the link, one the owner's tab
  keeps. Both reach only that session's subjects and stop working when it
  ends; the signing key stays in the sealed profile and never travels.
- **Carry the session when the browsers cannot meet.** *Session over this
  server* is **If direct fails** by default: if the peer connection fails,
  or has not connected after eight seconds, the joiner's seat moves onto the
  server. **Always** skips the peer connection; **Codes only** keeps the
  server to pairing codes. Every frame is sealed end
  to end with the pairing's keys; the server sees ciphertext and its size,
  as a TURN relay does.

While a session runs, the owner's tab also answers as a NATS service,
`opensesame-live` (`nats micro ls`, `$SRV.PING`), and on
`opensesame.live.<topic>.info` says only that it is live.

```bash
# One server, once: operator mode, a WebSocket listener with TLS.
pnpm dev:live-nats -- --websocket 0.0.0.0:8443 \
  --tls-cert /etc/nats/live.crt --tls-key /etc/nats/live.key \
  --out ~/live-nats
nats-server -c ~/live-nats/live-sessions.conf
# → Routes › NATS server: wss://nats.example.com:8443,
#   Sign-in "Per session",
#   the account public key and signing key from live-sessions.mint.json.
```

`operator.nk` is the operator's seed: keep it offline. To revoke every link
at once, generate a new account and replace the server's configuration; a
single session's credentials expire with it.

Browsers may ask the person before a public page reaches a carrier on a
tailnet or LAN address. Chrome calls this Local Network Access, and the
prompt reads "Look for and connect to any device on your local network".
Allowing it is the browser's consent, on top of the join screen's.

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
- **The shipped page's own `<meta>` policy allows every `http:`, `https:`,
  `ws:` and `wss:` connection** (`connect-src` in `apps/pages/index.html`), so
  on GitHub Pages the plan and allowlist are the gate. The policy
  `apps/pages/scripts/security-headers.mjs` generates from a profile (the
  header, or its `metaCsp` on a host that cannot send headers) is stricter,
  and lists each `wss://` origin in `connect-src` only while external services
  are allowed.

## Checking a setup

`pnpm --filter @opensesame/pages verify:live-join` runs every road in real
browsers over real WebRTC. Build the app first, and also the dedicated build,
`pnpm --filter @opensesame/pages build:live-dedicated` (it writes
`apps/pages/dist-live-dedicated`, stamped `dedicated_origin` for
`https://opensesame.example.test`). The carrier and declined walks run on it:
their servers are on loopback, which is local operator authority the shared
GitHub Pages origin may not reach, so the run fails without that build.
The roads:

- direct pairing;
- a simulated tailnet, which never connects without the address and connects
  at it with one;
- each carrier, with nothing pasted:
  - Nostr (a relay in the test process);
  - MQTT (aedes);
  - NATS: a real nats-server, set by `LIVE_NATS_SERVER` or the mTLS fixture pin
    (`pnpm test:mtls:fixtures`);
  - ntfy: a real ntfy server, set by `LIVE_NTFY_SERVER`;
  - BroadcastChannel;
- relay-only through a real TURN server, once for each way to reach one, each
  with both browsers relay-only and meeting relay to relay:
  - `turn:host:port?transport=udp` (node-turn);
  - `turn:host:port?transport=tcp`, the road through a firewall that lets only
    TCP out;
  - `turns:host:port?transport=tcp` (TLS), the road through Pangolin, Tailscale
    Funnel or port 443. The certificate is a throwaway self-signed one, and
    Chromium is told to trust its public key alone
    (`--ignore-certificate-errors-spki-list`), not certificate errors in
    general.

  TCP and TLS run on `live-turn`, a pion/turn server (`scripts/test/live-turn`)
  that speaks UDP, TCP and TLS at once and counts what each transport saw. The
  walk asks it, not the browser: the transport named must have authenticated
  and allocated for both peers, and no client traffic may have reached the
  others.

- NATS in operator mode (`pnpm dev:live-nats`), named through the Form with
  its signing key: `nats-always` reveals a value over the server with no
  peer connection up, and `nats-fallback` does the same for a joiner whose
  browser has no route at all. Both check the link carries a minted
  credential and never the signing key, that the owner's tab answers
  `$SRV.PING` and `info`, and that the server passed no plaintext.

`LIVE_CARRIERS=nostr,mqtt` limits which carriers run, and
`LIVE_SCENARIOS=relayed,relayed-tcp,relayed-tls` (from `direct`, `carriers`,
`declined`, `relayed`, `relayed-tcp`, `relayed-tls`, `relayed-rest`,
`relayed-rest-wrong`, `nats-always`, `nats-fallback`, `tunnel`) limits which walks. `LIVE_TURN_SERVER` names the `live-turn` binary; `pnpm
test:live-fixtures` builds it (Go is needed) to `.cache/live-fixtures/bin`. A
missing server fails the run; it is never skipped silently.

- relay-only through a TURN server that authenticates with a REST secret
  (coturn's `use-auth-secret`): the owner types the profile file
  (`settings/live/transport.json`, opened from the command bar; the Routes
  Form has no secret field) with the server's `"secret"`, saves it and reads it
  back, and the app mints each session's credential. `live-turn` runs with
  `-rest-secret`, and the walk asserts both peers authenticated with zero
  failures, the link carries a `<expiry>:osl` username and its HMAC-SHA1
  credential and never the secret, and no peer connection holds the secret.
  A negative control, `relayed-rest-wrong`, gives the server another secret:
  every authentication is refused, nothing is allocated, and the browsers
  never meet (it waits 10 seconds, not the full connection timeout).

`pnpm --filter @opensesame/pages verify:live-netns` checks the address hint on
a network it builds rather than one it simulates. The no-address and address
walks run on the GitHub Pages build; the Nostr relay and TURN walks put their
servers on a private address, so they run on the dedicated build
(`build:live-dedicated`, as above), which the run needs:

- two Linux network namespaces, each with its own Chromium (mDNS candidate
  hiding on, nothing filtered in the page), joined by a veth pair with
  multicast off, as a tailnet interface is, and a harness namespace that hosts
  the carrier and the TURN server and forwards nothing;
- with no address named the browsers never connect; with the address named
  they connect over a pair at it, with no ICE server; the same with a
  `wss://` Nostr relay carrying the codes; and, with the veth taken down,
  relay-only through TURN, relay to relay.

It needs Linux with unprivileged user namespaces (no root, no sudo), `unshare`,
`nsenter`, `setpriv`, `openssl` and python3, and fails, never skips, where it cannot
build the network. Everything runs in a PID namespace, so nothing outlives
the run. What it proves about a real tailnet: the candidate copy at the named
address reaches the other browser over real UDP and real routing, and mDNS
names do not resolve across such a link. What it does not: Tailscale's own
path selection, NAT traversal, or a physical network's MTU and loss.
