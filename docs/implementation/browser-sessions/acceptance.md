# Browser-session acceptance

Status: local proof against the shipped Pages build. Physical-device, live-provider, native window-hide, and `pageshow.persisted=true` bfcache restoration are not claimed.

## What this proves

`pnpm test:browser-sessions` builds the rich Pages app and drives three isolated Chromium processes against that build:

- Startup Join on a device with no vault (ADR 0150).
- The always-on drop claim ceremony (`/claim`, "Accept a claim") on that same empty device.
- A strict-direct live session (`iceServers: []`) between the other two processes. The runner only carries the sealed codes. The vault field moves on the browsers' real `RTCPeerConnection`.
- Scoped projection: the joiner can reveal the shared login and is not offered the login the owner left unchecked.
- Lifecycle: ending the session removes the revealed value and closes the peer connection.

Authorized item edit is not part of this proof. ADR 0150 shares a field as `read` or `use`. The earlier divergent editor was not added: its extra chunks do not fit the recorded Pages JavaScript ceiling, and this record does not raise that ceiling.

## Measurements

Filled from the passing `pnpm test:browser-sessions` and `pnpm quality:bundle` runs. Until those runs finish, the cells below stay blank rather than inventing a hash or a size.

| Check | Result |
| --- | --- |
| Rich Pages `dist/index.html` SHA-256 | `bbd9d4187f091585135ebb59ebba03b28a69932f9e5c4b5c0f9438c6e7a04a7e` |
| `minimal-local-hardened` total / javascript / javascriptGzip / css / largestAsset (KiB) | 4737 / 4130 / 1256 / 152 / 793 (ceilings 4830 / 4211 / 1272 / 171 / 793) |
| `family-local-hardened` total / javascript / javascriptGzip / css / largestAsset (KiB) | 4737 / 4130 / 1256 / 152 / 793 (ceilings 4830 / 4211 / 1272 / 171 / 793) |
| `apps/pages` inside recorded ceilings | 6095 / 5369 / 1638 / 154 / 803 (ceilings 17900 / 5460 / 1650 / 168 / 12800) |
| `apps/console` | No `apps/console` package and no console ceiling in `tools/quality/bundle-budgets.json` on this tree |

Ceilings are the numbers already in `tools/quality/bundle-budgets.json` on this branch. None were raised.
