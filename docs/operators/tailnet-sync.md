# Tailnet vault sync

Keep one vault in step across a laptop, a phone and anything else on your
tailnet, with no vendor cloud in the path
([ADR 0140](../adr/0140-tailnet-vault-sync.md); the model is Enpass's, see
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
slot's only key and is not shown again. Pass `--url` if Serve is not running
yet, and `--pages-url` (or `OPENSESAME_PAGES_URL`) for your own Pages origin.

```bash
opensesame daemon drive ls              # label, generation, size — never keys
opensesame daemon drive rm <slot>       # close it; paired devices stop syncing
```

## 3. Pair devices

Turn on **Networking** in Settings › Capabilities on each device; the
**Tailnet sync** panel then appears under Settings › Vaults.

- **The device that has the vault:** unlock it, paste the code (or open the
  link), press the pair key. The first pass fills the drive.
- **A new device:** continue as a guest (or open the app with no vault),
  turn on Networking, paste the code in Settings › Vaults. The vault is
  written into this device and the unlock screen asks for its **master
  password** or a **synced passkey**. Enrol a PIN afterwards if you want one;
  PINs never leave the device that set them, so a vault that only a PIN opens
  must get a password or passkey on its first device before it can be set up
  anywhere else.

After that each device syncs on unlock, 1.5 s after a change, and once a
minute while the vault is open. The panel's status glyph says when it was last
in step, or why it failed.

## What the drive sees

| The drive holds | The drive never holds |
|-----------------|-----------------------|
| The vault body, sealed under the vault key (AES-GCM, bound to its tomb path) | The vault key, a password, a PIN, a PRF output |
| A portable header: the master-password wrap, passkey wraps, second steps already sealed under the vault key, `createdAt` | The PIN wrap, the password hint, the device's protection manifest |
| A generation counter and a SHA-256 of each slot key | A slot key |

A compromised drive can refuse, lose or replay a snapshot. A replay merges as
a no-op; it cannot bring back a purged item (tombstones) or overwrite a newer
edit (newest copy wins).

## Limits in this version

- Only the personal vault can be set up on a new device from the drive.
- Each device keeps its own header: change the master password on each.
- Items stored outside the vault body (large attachments) are not synced.
- Snapshots are capped at 16 MiB; a drive holds at most 64 slots.
