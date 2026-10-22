# Local Peer-to-Peer

Status: adapter implemented; not yet a live-session transport.

[Local Peer-to-Peer](https://wicg.github.io/local-peer-to-peer/) is a WICG draft
for browser-to-browser communication on a local medium without a signalling
server. The user agent discovers peers, authenticates them and asks the person
to grant access. An origin never sees the local topology or an IP address.

It is **not** a raw socket API and it is not a replacement for the vault's
WebRTC, Tailscale or Direct Sockets paths. It is a browser-managed transport
for the same kind of direct session the Live sharing flow already supports.

## What the draft provides

| Piece | Meaning |
|---|---|
| `LP2PRequest` | Ask for a local peer; the browser shows its native peer picker |
| `LP2PReceiver` | Advertise and accept incoming peers after explicit consent |
| `LP2PConnection` | An authenticated QUIC-backed connection |
| `LP2PDataChannel` | Ordered data channel, deliberately close to `RTCDataChannel` |
| `LP2PQuicTransport` | WebTransport-style streams over the same connection |
| `local-peer-to-peer` Permission Policy | Default allowlist `self` |

The user agent owns discovery, authentication and grants. The origin sees a
connection only after a person chooses a peer. The draft is still evolving and
was not a shipped stable Chrome feature at the time of this review, so every
use is feature-detected and optional.

## Implemented adapter

`packages/app-core/src/lib/local-p2p.ts`:

- `localP2PAvailable()` — secure context plus both constructors
- `startLocalPeerReceiver()` — advertising, with a stop hook
- `requestLocalPeer()` — the browser's peer picker and grant prompt
- `LocalPeerChannel` — the existing live-session frame protocol over an
  `LP2PDataChannel`
- `openLocalPeerChannel()` — create the named `osm-live-v1` channel

The channel bridge uses the same `ChannelMessage` reader, `FRAME_BYTES` limit
and `Inbox` backlog as the WebRTC transport. A message that is not the live
protocol is dropped. The adapter does not discover, rank or auto-connect.

The IWA manifest declares `local-peer-to-peer` and the Vercel header declares
it for a normal PWA. The default is already `self`; the explicit entries stop a
future embedding policy from removing it.

## Where it belongs

### Planned: Live sharing `Nearby` mode

The current Live sharing flow uses WebRTC with sealed pairing codes and
optional carriers. A Local P2P transport would replace the **meeting** step,
not the session protocol:

1. The owner starts an `LP2PReceiver` only after choosing “Nearby”.
2. The joiner chooses `LP2PRequest` and the browser shows the peer picker.
3. Once granted, both open `osm-live-v1` and use the existing messages.
4. The WebRTC transport remains the default and the fallback.

This needs a new transport mode in the session UI and a session-level
authorization step; the adapter alone must not start a session. The current
pairing codes still matter because a person must know which owner they are
joining.

### Not for vault sync

Vault sync needs an addressable store, conflict handling and an update path
that survives the peer leaving. Local P2P is a transient connection. Tailscale
drive and the PWA/native sync remain the vault transport.

### Not raw TCP/UDP

Printer, SSH, RDP, mDNS or arbitrary protocol work belongs in the IWA Direct
Sockets path. Local P2P is browser-managed QUIC with a peer grant.

## Security rules

- No discovery result is exposed to the origin; only the selected peer is.
- The person grants once; no automatic peer connection at boot.
- A peer is untrusted after connection. The live protocol still seals its
  payload and validates every message.
- The origin receives no IP address, network topology or SSID.
- The adapter never retries a refused grant silently.
- A page that cannot use the Permission Policy cannot construct the API.
- IWA and PWA manifests do not grant anything by declaring the feature.

## Phases

1. Adapter and tests (done).
2. Add a feature-detected “Nearby” choice to Live sharing, off by default;
   preserve the WebRTC/code path.
3. Map `LP2PQuicTransport` to the session's stream needs only if the message
   protocol outgrows data channels.
4. Add a Chrome flag/dev build verification path; no production promise until
   the API ships.
5. Keep IWA Direct Sockets for raw device and local protocol work.

## Acceptance

- The adapter is unavailable without a secure context and both constructors.
- A receiver starts only when a person asks, and can be stopped.
- A request returns only the browser-selected peer.
- A channel uses the exact live-session reader, frame limit and backlog.
- Non-protocol messages are dropped.
- The live WebRTC path is unchanged.
- No IP, network name or peer list reaches the origin.
