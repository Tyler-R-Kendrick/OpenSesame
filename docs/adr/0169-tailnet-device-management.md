# ADR 0169 — Tailnet device management through the paired daemon

- Status: Accepted
- Date: 2026-10-05
- Amends: [ADR 0128](0128-pages-without-host.md) and
  [ADR 0144](0144-tailnet-vault-sync.md) (the daemon surfaces Pages may
  speak to gain a fourth: the tailnet device routes a person paired)
- Builds on: [ADR 0005](0005-authority-handle-connectionref.md) (no raw
  secret leaves the authority), [ADR 0048](0048-capability-moded-connector-discovery.md)
  D6/D7 (invoke-through: exact egress, no redirects, memory-resident token),
  [ADR 0130](0130-operator-controlled-capability-composition.md) (an optional
  capability loads only after consent), [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md)
  §7 (an origin-bound pairing code traded once for a bearer)
- Replaces: the hand-typed device registrations Identity › Devices offered
  (#538), which named devices nothing knew about

## Context

Identity › Devices listed the browsers that had opened a vault and let a
person "register" more by typing a name and a platform. Those records were
inventory only: they reached no network, no device knew about them, and
removing one revoked nothing. An organisation that runs its devices on a
Tailscale tailnet needs the opposite — the real machines on the tailnet, and
the authority to admit, rename, tag, re-key, route and remove them, from the
same PWA that holds its vaults.

Tailscale's control-plane API (`https://api.tailscale.com/api/v2`) is what
does this. It cannot be called from a page: it sends no
`Access-Control-Allow-Origin` on a preflight or a response (checked
2026-10-05 against `/tailnet/-/devices` and `/oauth/token`), so a browser
may send a request but never read what comes back. It would also be wrong to
try. The credential that drives it — an OAuth client or an API access token —
can approve a stranger's laptop onto the network, and a static page on a
shared origin is the last place to hold it.

The person already runs the `opensesame` daemon on the tailnet (ADR 0144
syncs vaults through it), and the daemon already links an egress broker built
for exactly this shape of call (ADR 0048 D6/D7).

## Decision

**The daemon holds the Tailscale credential and is the only thing that calls
Tailscale. Pages manages devices through a small set of daemon routes, with a
bearer bound to its origin and a role, traded once for a code the operator
prints.**

### 1. The credential stays on the daemon's machine

`opensesame tailnet connect` records which tailnet to manage and one
credential, copied into the daemon's own state:

- an **OAuth client** (`--oauth-client-id` and its secret on stdin or from a
  file) — preferred, because Tailscale lets it be scoped
  (`devices:core`, `devices:routes`, `auth_keys`, or their `:read` forms) and
  it never expires on its own; the daemon trades it for an hour's access token
  at `/api/v2/oauth/token` and keeps that token in memory only; or
- an **API access token** (`tskey-api-…`), which carries its owner's full
  rights and expires within 90 days.

Custody, stated truthfully: the secret is a `0600` file in a `0700`
directory owned by the daemon's OS user (`$OPENSESAME_TAILNET_ADMIN_DIR`,
default the user's config directory). It is readable by that user, it is
never sent to a browser, never logged, never in an error or a receipt, and
`opensesame tailnet disconnect` deletes it. Nothing calls it hardware-bound.

### 2. Every upstream call goes through invoke-through

The daemon reaches Tailscale through `opensesame-invoke-through` with its own
one-row allowlist — `https://api.tailscale.com`, exact host — so the fences
hold as they do for GitHub: no redirect is followed, the token sits in one
sensitive header and is zeroized with the request, request and response
bodies are capped, only allowlisted headers travel, and a response that
echoes the credential is scrubbed. The row is restated from
`spec/connectors/catalog.json` and a drift test fails if they disagree. The
access-token mint is one fixed `POST` to `/api/v2/oauth/token` on the same
host, with redirects off. Device answers may be up to 32 MiB (a few KiB a
machine, so about ten thousand machines); every other fence is the broker's
default. A loopback upstream exists only in a debug build with the
`upstream-override` feature: a workspace test run can unify the feature into
a binary it builds, so a release build never reads the base whatever its
features.

### 3. Pairing: one origin, one role, one code, once

`opensesame tailnet pair --origin <origin> --role read|manage` prints a code
(`opensesame-tailnet:v1:` + base64url of url, one-time secret, origin, role,
label) and a link that carries it in the fragment. The page at that origin
posts the secret to `POST /v1/tailnet/pairing` and receives a bearer bound to
that origin and role; the daemon keeps a SHA-256 of each code and bearer,
never either. A code lives five minutes, and a code presented from another
origin is spent on the spot. The page seals the bearer in the open vault's
tomb (`config/tailnet-admin`); a guest has nowhere to seal it and cannot pair.
`opensesame tailnet unpair` and the page's own forget revoke bearers, and
the next request that presents one is refused.

The roles are the whole permission model:

| Role | May |
| --- | --- |
| `read` | the status, the device list and one device, its routes, the auth-key list, the audit trail |
| `manage` | all of `read`, and authorize or deauthorize, rename, set tags, enable or disable key expiry, expire a key, set enabled routes, remove a device, create and revoke auth keys |

A pairing link is something a person may be sent, and any `*.ts.net` host can
be public through Funnel, so a link must not quietly re-point a page at
someone else's tailnet: before anything is pressed, the pairing sheet names
the daemon the code points at, the role and the name it carries, and the
pairing it would replace, and its commit then reads *Replace the paired
daemon*. Once a new bearer is sealed, the one it replaced is revoked at the
daemon that issued it, best effort, so it does not stay live until an
operator unpairs it.

### 4. The routes

All under `/v1/tailnet/`, answered only to a bearer presented from its bound
origin. CORS echoes exactly that origin, never `*`, never with credentials,
and varies on `Origin`; every other daemon route still refuses a browser.
An origin whose pairing an operator removed (`opensesame daemon tailnet
unpair`) is still echoed for 30 days, at most 64 of them, newest kept: its
next request then reads `tailnet_pairing_required` and the page says it was
unpaired, where a CORS failure would read as the daemon having vanished.
Being answered grants nothing; every route still wants a bearer.

| Route | Role |
| --- | --- |
| `POST /pairing`, `DELETE /pairing` | trade a code / forget this bearer |
| `GET /status` | `read` |
| `GET /devices`, `GET /devices/{id}` | `read` |
| `POST /devices/{id}/authorized` `{authorized}` | `manage` |
| `POST /devices/{id}/name` `{name}` | `manage` |
| `POST /devices/{id}/tags` `{tags}` | `manage` |
| `POST /devices/{id}/key-expiry` `{disabled}` | `manage` |
| `POST /devices/{id}/expire` | `manage` |
| `POST /devices/{id}/routes` `{enabled_routes}` | `manage` |
| `DELETE /devices/{id}` | `manage` |
| `GET /keys`, `POST /keys`, `DELETE /keys/{id}` | `read` / `manage` / `manage` |
| `GET /audit` | `read` |

The daemon validates before it calls anything: a device or key id is
`[A-Za-z0-9]{1,64}`; a name is one DNS label (or empty, which resets it to
the hostname); a tag is `tag:` and a lowercase label, at most 50; a route is
an IPv4 or IPv6 prefix in canonical form, at most 256; an auth key's
description is at most 50 letters, digits, spaces and hyphens, and its expiry
between one hour and 90 days. A key minted through an OAuth client must carry
tags, as Tailscale requires; the daemon says so before it asks.

It answers in its own shape, not Tailscale's: a device is
`{id, name, hostname, os, client_version, update_available, user,
addresses, tags, authorized, external, ephemeral, key_expiry_disabled,
expires, created, last_seen, connected, blocks_incoming, ssh_enabled,
multiple_connections, advertised_routes, enabled_routes, tailnet_lock_error}`,
with `id` the stable `nodeId`. Keys never carry `key` except in the one
response that created it. `spec/conformance/tailnet-admin-protocol.json`
records each route as a literal exchange — the page's request, the upstream
call the daemon must make, Tailscale's answer, and the daemon's — and both
the daemon and the Pages client replay it, so neither side can drift alone.

### 5. Every change is on the record

Each mutating call appends one line to `tailnet-admin-audit.jsonl`
(`0600`): when, which pairing (id, label, origin), the action, the device or
key id, and the outcome status. No value is recorded: not a key, not a tag
list's secret-looking content, not a token. Each line rests sealed (the
`osl1.` sealed-log format, XChaCha20-Poly1305) under a key in its own `0600`
file beside the trail, as ADR 0157 requires of anything the authority plane
writes about itself; without that key the trail reads as nothing. The file
keeps its newest 2,000 lines. `GET /v1/tailnet/audit` returns the newest 200
to a `read` bearer, and Identity › Devices shows them.

The pairings file and the audit trail are each written under an exclusive
lock file that the daemon and the CLI beside it share, so `unpair` at a
terminal never races a page's exchange into bringing a revoked bearer back,
and an append never lands between a trim's read and its rename.

### 6. In Pages: one optional capability, one panel

`networking.tailnet-devices` is an optional capability that depends on
`networking.tailnet` and `identity.local-iam` (whose section it is drawn in)
and is off until a person turns it on (ADR 0130). Its
module puts the device manager into Identity › Devices through a slot, so the
always-on section carries none of its code. With nothing paired the panel
shows its pair key and nothing else; paired, it lists the tailnet's devices
with what they are (online, waiting for approval, key expired or expiring,
an update, routes waiting, several connections at once) and the keys a role
allows. **Add device** mints a Tailscale auth key with the options the person
chose and shows it once, with the command that joins a machine with it.
Removing a device, expiring its key and revoking an auth key are armed keys.
Every request goes through the capability's egress port to the paired
address alone.

The browser list Identity › Devices showed before stays, as what it always
was: the browsers that opened this vault. Its hand-typed registrations are
gone; a record made by one is shown and may be removed.

## Consequences

- An administrator approves, tags, re-keys, routes and removes the tailnet's
  real machines, and adds new ones, from the PWA on a laptop or a phone,
  without the Tailscale credential ever reaching a browser.
- A stolen bearer is worth its role, from its origin, until it is unpaired;
  it never yields the credential, and the audit trail shows what it did.
- Device management needs the daemon running on the tailnet and reachable
  through Tailscale Serve; with neither, the panel offers pairing and says
  nothing else. The static core is unchanged (ADR 0090).
- Device invites, posture attributes, tailnet lock signing and IP
  reassignment are not offered in this version.
- Agents do not reach these routes: the MCP and WebMCP surfaces are excluded
  in the capability registry, citing this ADR. Device administration is a
  human-plane act.
