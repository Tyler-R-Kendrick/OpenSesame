# @opensesame/qr

QR encoding to SVG and to compact Unicode for terminals, on top of `uqr`
with error correction M. It also encodes cross-device interaction links, and
for those it refuses a URL that names credential material before any module
is drawn: a QR is photographed, printed and screenshotted, so the check runs
first.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (`components/QrCode.tsx`), [`packages/app-core`](../app-core) (duress peer export), [`packages/sdk-cli`](../sdk-cli) (device-flow terminal handoff).
- **Builds on:** `uqr`; [`@opensesame/ceremony-kit`](../ceremony-kit) for `assertNoForbiddenParams` and `parseInteractionUrl`.
- Dependency direction is one way: `qr` depends on `ceremony-kit`, never the reverse, so the kit stays free of an encoder. There is one definition of a forbidden link, in the kit.

## Surface

| Export | What it does |
|---|---|
| `encodeQrSvg(value, { pixelSize, border, dark, light })` | SVG string; defaults 4px modules, border 2 |
| `encodeQrTerminal(value, { border })` | Two modules per character row, for a TTY |
| `encodeQrSize(value)` | Matrix size, for tests and diagnostics |
| `encodeInteractionQr(url, options)` | Refuses forbidden params, then refuses a URL `parseInteractionUrl` does not recognise, then encodes |
| `encodeInteractionQrTerminal(url, options)` | The same refusals, terminal output |
| `QrEncodeError` | Thrown for an empty or whitespace-only payload |

```ts
import { encodeQrSvg } from "@opensesame/qr";

const svg = encodeQrSvg("https://example.test/device?user_code=ABCD-EFGH");
```

## Develop

```bash
pnpm --filter @opensesame/qr test
pnpm --filter @opensesame/qr typecheck
```

## Related

- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — interaction links and their presentation adapters
- [ADR 0045](../../docs/adr/0045-hosted-ceremony-pages.md) — hosted ceremony pages
- [ADR 0062](../../docs/adr/0062-secret-drop.md) — secret drop, which hands off by QR
