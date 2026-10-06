# Tailnet vault sync

Keep one vault in step across a laptop, a phone and anything else on your
tailnet, with no vendor cloud in the path
([ADR 0144](../adr/0144-tailnet-vault-sync.md); the model is Enpass's, see
[docs/research/competitors/enpass.md](../research/competitors/enpass.md)).

One machine runs the `opensesame` daemon and acts as the **drive**: it stores
one sealed snapshot per slot and never holds a key. Every device merges on its
own side, under its own copy of the vault key.

## 1. Run the drive

On the machine that will hold the drive (a desktop or home server that stays
on):

```bash
export OPENSESAME_OPERATOR_TOKEN="$(openssl rand -hex 32)"   # keep it; the CLI needs it
# The Pages origin(s) that will sync, exactly:
export OPENSESAME_CORS_ORIGINS="https://tyler-r-kendrick.github.io"
# Optional: where slots live (default: $XDG_STATE_HOME/opensesame/vault-drive,
# else ~/.local/state/opensesame/vault-drive, or %LOCALAPPDATA% on Windows).
export OPENSESAME_VAULT_DRIVE_DIR="$HOME/.local/state/opensesame/vault-drive"
opensesame daemon run --listen 127.0.0.1:18790
```

Expose it to the tailnet with Tailscale Serve (tailnet only; do not use
Funnel):

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18790
tailscale serve status        # https://<machine>.<tailnet>.ts.net
```

`OPENSESAME_DAEMON_NETWORK_BRIDGE=1` does the same from the daemon itself.
Serve's certificate is publicly trusted, so there is no fingerprint or code
to compare when a device pairs.

Native devices can also reach the drive on the whois-gated tailnet listener
(`--features tailscale`, `OPENSESAME_TAILSCALE_ALLOW_USERS` /
`OPENSESAME_TAILSCALE_ALLOW_TAGS`), which requires both an allowed tailnet
identity and the slot key.

## 2. Open a slot

```bash
opensesame daemon drive create --label "Personal vault"
```

This prints the slot id, the drive URL, a **pairing code**
(`opensesame-drive:v1:…`), a **link**
(`…/settings/vaults#pair-drive=…`) and a QR of the link. The code carries the
slot's only key and is not shown again. Pages takes the code out of the
address bar as soon as the link opens, so it is not left in history. Pass `--url` if Serve is not running
yet, and `--pages-url` (or `OPENSESAME_PAGES_URL`) for your own Pages origin.

```bash
opensesame daemon drive ls              # label, generation, size — never keys
opensesame daemon drive rm <slot>       # close it; paired devices stop syncing
```

## 3. Pair devices

Turn on **Networking** in Settings › Capabilities on each device; the
**Tailnet sync** panel then appears under Settings › Vaults.

- **The device that has the vault:** unlock it, press the row's
  **Pair with a drive** key in Settings › Vaults, paste the code in the sheet
  that opens (or open the link, which opens the sheet with the code filled
  in), and press **Pair with this drive**. The first pass fills the drive.
- **A new device:** continue as a guest (or open the app with no vault),
  turn on Networking, press the row's **Set this device up from the drive**
  key in Settings › Vaults and paste the code in the sheet (or open the
  link). The vault is written into this device and the unlock screen asks
  for a **synced passkey** (or, on a vault made before ADR 0180, its **master
  password**). Enrol a PIN afterwards if you want one; PINs never leave the
  device that set them, so a vault that only a PIN opens must get a passkey on
  its first device before it can be set up anywhere else.

After that each device syncs on unlock, 1.5 s after a change, once a minute
while the vault is open, when the app is looked at again, and when the device
comes back online. Nothing syncs while the app is closed: the key it would
need is sealed until a person opens the vault, and the next open catches up.
The panel's status glyph says when it was last in step, or why it did not.

**Project vaults** pair the same way: open the project vault, pair it with
its own slot. On another device, pairing with that slot sets the project up
beside the vaults already there and opens its unlock screen.

**A terminal** syncs too: `opensesame-id vault sync --pair <code>` the first
time (on a machine with no vault it sets one up from the drive and asks for
the master password), then `opensesame-id vault sync`.

### Chrome asks once

A page on the public web reaching an address on your tailnet is what
Chrome's Local Network Access permission is for. The first time a device
syncs, Chrome asks whether the site may reach devices on your local network.

- Press **Sync now** (or pair), and allow it when Chrome asks. A sync that
  starts by itself never raises the question; until you have answered it, the
  panel's glyph says sync is waiting for local network access.
- If you refused: open the site's settings (the icon left of the address),
  set **Local network access** to Allow, and press Sync now.

## Checking it end to end

```bash
cargo build -p opensesame-cli
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:tailnet-sync
```

Runs a real drive behind a TLS proxy at a `*.ts.net` name and two isolated
browser devices with Chrome's Local Network Access check on: A seals and
pairs, B adopts from the link and unlocks with A's password, B's edit reaches
A, a file A attaches downloads byte for byte on B, and a device left at the
prompt or refused is told what to do.

`pnpm test:tailnet-sync:real` runs the same walk over a real tailnet (pinned
headscale and two `tailscaled` nodes, one on a kernel TUN, `tailscale serve`
in front of the drive). It needs `/dev/net/tun` and `CAP_NET_ADMIN`.

## What the drive sees

| The drive holds | The drive never holds |
|-----------------|-----------------------|
| The vault body, sealed under the vault key (AES-GCM, bound to its tomb path) | The vault key, a password, a PIN, a PRF output |
| A portable header: the master-password wrap, passkey wraps, second steps already sealed under the vault key, `createdAt` | The PIN wrap, the password hint, the device's protection manifest |
| A generation counter and a SHA-256 of each slot key | A slot key |
| Attachments' encrypted parts, under the keys their manifests name | The key that opens a part (it lives in the manifest, inside the sealed body) |

A compromised drive can refuse, lose or replay a snapshot. A replay merges as
a no-op; it cannot bring back a purged item (tombstones) or overwrite a newer
edit (each field keeps the copy that changed it later). It cannot change a
master password either: a password change travels inside the sealed body,
and a wrap the drive writes into the header it stores is ignored.

## Limits

- Snapshots are capped at 16 MiB; a drive holds at most 64 slots; a slot's
  attachment parts at most 4 GiB. Parts are removed only with the slot.
- A PIN never leaves its device: enrol one on each device that wants it.
- A device away through more than 10,000 purges of one kind may see the
  oldest come back; purge them again.
- After rotating the vault key (Settings › Security, after a compromise),
  every other device must remove the vault and set it up from the drive
  again; their panels say so.
