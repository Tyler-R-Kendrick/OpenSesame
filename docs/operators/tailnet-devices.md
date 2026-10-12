# Tailnet device management

Manage the machines on a Tailscale tailnet from Identity › Devices in the
web app, or from a terminal: see what Tailscale reports for each one, approve
the ones waiting, rename and tag them, turn key expiry on or off, expire a
key, approve subnet routes and exit nodes, remove a machine, and add one by
minting an auth key
([ADR 0169](../adr/0169-tailnet-device-management.md)).

The `opensesame` daemon on one machine holds the Tailscale credential and
makes every call to the Tailscale API. A page never sees that credential: it
holds a bearer bound to its own origin and a role, and the daemon checks both
on every request and writes each change to an audit log.

## What you need

- A machine on the tailnet that runs the daemon and stays on.
- A Tailscale credential for the daemon. Use one of these:
  - **An OAuth client (preferred).** In the Tailscale admin console, under
    Settings › OAuth clients, create a client with the scopes the daemon
    needs:
    - `devices:core` for the device list, approval, names, tags, key expiry
      and removal;
    - `devices:routes` for subnet routes and exit nodes;
    - `auth_keys` to add devices.

    Use the `:read` forms for a daemon that only reads. Tailscale requires
    every auth key minted through an OAuth client to carry a tag. The page
    says so, and does not mint a key until a tag is given.
  - **An API access token** (`tskey-api-…`). Any key it mints may be
    untagged. It expires on Tailscale's schedule, so plan to replace it.
- A deployment of the web app at its own address. The shared demo at
  `tyler-r-kendrick.github.io` cannot hold tailnet authority and says so. A
  dedicated or loopback deployment can
  ([pages-origin.md](pages-origin.md)).

## 1. Connect the daemon to the tailnet

On the daemon's machine, give it the credential once. The secret is read
from a file or from one line of stdin, and is never taken as an argument:

```bash
# OAuth client
opensesame daemon tailnet connect --tailnet example.com \
  --oauth-client-id k123ABC4CNTRL --secret-file ./tailscale-oauth-secret
# or an API access token
opensesame daemon tailnet connect --tailnet example.com --api-token < ./token

opensesame daemon tailnet status
```

The credential is stored in `tailnet-admin.secret` with mode 0600, in a
directory with mode 0700: the platform config directory (`config/tailnet`),
or `OPENSESAME_TAILNET_ADMIN_DIR`. `opensesame daemon tailnet disconnect`
deletes it.

Run the daemon and make it reachable on the tailnet only, with Tailscale
Serve, not Funnel:

```bash
opensesame daemon run --listen 127.0.0.1:18790
tailscale serve --bg --https=443 http://127.0.0.1:18790
```

## 2. Pair the web app

Print a one-time code for the page's exact origin, with the role it gets:

```bash
opensesame daemon tailnet pair \
  --origin https://vault.example.com \
  --role manage \
  --url https://desk.tail4c2e.ts.net \
  --label "Ops laptop" \
  --pages-url https://vault.example.com/
```

| Role | Allows |
| --- | --- |
| `read` | the device list, auth keys (never their secrets), the audit log |
| `manage` | everything `read` allows, plus every change |

Then open the printed link (or scan its QR code) in a browser where a vault
you own is unlocked. A guest vault cannot pair. Identity › Devices opens the
pairing sheet with the code already filled in; press the pair key. Instead
of opening the link, you can open the sheet from the panel's pair key and
paste the code.

The code:

- works once, for five minutes, and only from the origin it names;
- is accepted from any other origin only to be spent and refused.

The bearer the page receives is sealed inside the vault. Locking the vault
puts it out of reach, and another vault on the same device never sees it.

## 3. Manage devices

In **Identity › Devices**, the Tailnet devices panel lists every machine
Tailscale reports. Machines that need attention are listed first:

- waiting for approval;
- a key that has expired or is about to;
- routes waiting for approval;
- a client update available;
- a tailnet lock error.

The filters show *Needs attention*, *Online* and *Offline*.

| Key | What reaches Tailscale |
| --- | --- |
| ✓ Approve | `POST /device/{id}/authorized` |
| ✎ Settings | name, tags, approval, key expiry, subnet routes, exit node; only what changed is sent |
| ⏱ Expire key (press twice) | `POST /device/{id}/expire`: the machine must sign in again |
| 🗑 Remove (press twice) | `DELETE /device/{id}` |
| + Add a device | mints an auth key |

**Add a device** mints an auth key with the options you choose:

- a description;
- how long the key lasts (one hour to 90 days);
- whether it is reusable;
- whether the device it adds is ephemeral;
- whether that device is pre-approved;
- its tags.

The sheet then shows the key and the `tailscale up --auth-key=…` command
once, each with a copy key; the copy clears the clipboard afterwards. The key
is kept nowhere: not in the page, and not on the daemon. To revoke an unused
key, use the Auth keys panel.

The Activity panel lists the newest changes. Each entry names the change,
the device or key it touched, the pairing that made it, and whether
Tailscale accepted it.

The same changes are available from the terminal. Each is logged as
`terminal`:

```bash
opensesame daemon tailnet devices
opensesame daemon tailnet device <id>
opensesame daemon tailnet approve <id>
opensesame daemon tailnet deauthorize <id>
opensesame daemon tailnet rename <id> web-01
opensesame daemon tailnet tag <id> tag:web tag:ci
opensesame daemon tailnet key-expiry <id> off
opensesame daemon tailnet routes <id> 10.0.0.0/16 0.0.0.0/0 ::/0
opensesame daemon tailnet expire <id>
opensesame daemon tailnet remove <id>
opensesame daemon tailnet mint --description "lab runners" --reusable \
  --preauthorized --tag tag:ci --expiry-hours 168
opensesame daemon tailnet keys
opensesame daemon tailnet revoke <key-id>
opensesame daemon tailnet audit
```

## 4. Revoke a page

```bash
opensesame daemon tailnet unpair --origin https://vault.example.com  # every bearer that origin holds
opensesame daemon tailnet unpair --id tp_…                            # one pairing
opensesame daemon tailnet unpair --all
```

The page's next request is refused, and its panel says the daemon no longer
knows its key. A person can also press *Forget this daemon's pairing* on the
page; this drops the bearer on both sides.

## Verify it

`pnpm --filter @opensesame/pages verify:tailnet-devices` runs the whole flow
against a real daemon, a stand-in for the Tailscale API, and a
dedicated-origin build. It covers:

- pairing by the printed link;
- approving, renaming, tagging and approving an exit node;
- minting a key that a machine then joins with;
- expiring, revoking and removing;
- the audit log;
- read-only pairing;
- `unpair --all`.

It also checks that no credential or auth key is in the daemon's files, in
its log, or in the page's storage. To run it:

```bash
cargo build -p opensesame-cli --features tailnet-admin-test-upstream
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build:live-dedicated
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:tailnet-devices
```

A shipped build ignores `OPENSESAME_TAILSCALE_API_BASE`. Only a debug build
with the `tailnet-admin-test-upstream` feature reads it, and only for a
loopback address.
