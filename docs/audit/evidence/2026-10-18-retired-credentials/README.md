# Retired credentials: actual browser evidence

This directory preserves actual Chromium 151.0.7922.173 evidence from the
reconstructed Client-vault feature. It is bounded evidence, not a replacement
for aggregate verification or required CI.

## Before and after

The before build uses immutable source `a896cae479c849f5188546e08eb2b86c0fa44b26`.
The after build uses the final official complete artifact, including the push
worker, on the default `shared_origin_demo` profile. Both use `/OpenSesame/`,
actual browser storage and genuine local owner authentication. No screenshots
use a mocked management result. Desktop is 1280×900; phone viewport emulation
is 390×844. The twelve after captures report zero page errors.

| View | Before | After |
| --- | --- | --- |
| Desktop Security | [before](before-desktop-security.png) | [after](after-desktop-security.png) |
| Phone Security | [before](before-phone-security.png) | [after](after-phone-security.png) |
| Fresh owner | — | [desktop](after-desktop-fresh-primary.png), [phone](after-phone-fresh-primary.png) |
| Management | — | [desktop](after-desktop-management.png), [phone](after-phone-management.png) |
| Synthetic consent | — | [desktop](after-desktop-synthetic-consent.png), [phone](after-phone-synthetic-consent.png) |
| Enrolled trap | — | [desktop](after-desktop-enrolled.png), [phone](after-phone-enrolled.png) |
| Controlled receiver | — | [desktop](after-desktop-canary-receiver.png), [phone](after-phone-canary-receiver.png) |

The before application source is immutable; its recovery build normalized
external dependency resolution to the installed recovery tree and resolved the
connector bridge source explicitly. It is not a stock installation of the
historical lockfile. The two before PNGs retain their original bytes; report
JSON whitespace is normalized for repository formatting.

## Native browser controls

`native-browser-report.json` records 18/18 actual browser controls and
`sourceUnchanged: true`. The tracked runner is
`apps/pages/test/original-browser-physical/runner.mjs`; run it with the source
checkout and an empty evidence output directory. It exercises native OPFS,
IndexedDB nonextractable keys, Web Locks, actual cryptography, configured TOTP,
retired enrollment/classification, synthetic denial and exit, collision
exclusions, and fresh genuine-owner management. Read the report for each
asserted boundary. This is not an installed extension or native mobile test.

## Live controlled canary flow

`canary-browser-report.json` records the actual production PWA pairing,
enrollment, inspection, export and removal flow against the existing Node
loopback receiver. Six fresh-owner signed commands completed through real
browser fetch, OPTIONS preflight, exact-origin CORS, receiver nonces and ES256
verification. The exported detection-only artifact connected and invoked its
tool; the owner then saw both detection events in the actual
[inspection panel](canary-inspection.png). Removing the artifact revoked its
bearer; replayed signed commands and a foreign origin were refused.

The existing encrypted receiver store reopened with zero records and two real
detection events. The receipt contains no bearer, private key, PIN, cookie or
receiver state bytes. One preceding successful run emitted four `ERR_ABORTED`
browser request notifications; its six commands still completed with receiver
HTTP 200 and verified state effects. The final preserved driver repeated the
full flow successfully on final5. This is not a zero-network-error claim.

Run the preserved driver against the same built artifact, using a fresh private
output directory:

```sh
node docs/audit/evidence/2026-10-18-retired-credentials/capture-canary-browser.mjs apps/pages/dist /tmp/retired-canary-live-proof
```

It loads the existing receiver TypeScript through Vite's pinned `tsx` dependency,
generates an ephemeral local owner and receiver service identity, and makes real
loopback requests. It uses ordinary Chromium without LNA or other browser
security overrides. Receiver private files stay in that output directory; only
the sanitized receipt and inspection screenshot belong in repository evidence.

## Shipped artifact qualification

The screenshots exercise the exact official final5 259-file artifact, including
all workers. `build-receipt.json` records every artifact file hash and both
8,577-row build source witnesses. Whole source-file equality is false: one
explicit generic annotation and a non-emitted test fixture changed during the
build, with further generic/return-type annotations completed afterward.
The receipt embeds the exact two-file proof: both staged preimages match the
normal build pre-witness and their type-erased JavaScript is byte-identical.
The native report records unchanged source throughout that run. Later
verification fixture corrections change test inputs without altering emitted
runtime or this preserved artifact.

The complete artifact measures 21,457,948 total bytes, 7,528,247 JavaScript
bytes, and 2,291,536 gzip bytes (level 9 per file): 7,351.804/2,237.828 KiB
against reviewed normal budgets of 7,355/2,240 KiB. The raw-only adjustment
accounts for the measured upstream integration growth. Hardened, total, CSS,
largest-asset and ownership limits are unchanged. The normal ownership check
passes; hardened builds and aggregate verification are reported separately.

## Reproduce

Use the repository's pinned dependencies and pnpm 9.15.0, with Chromium at
`/usr/bin/chromium`. From the repository root, use fresh `/tmp` output paths:

```sh
node docs/audit/evidence/2026-10-18-retired-credentials/capture-build-witness.mjs "$PWD" - /tmp/retired-build-before.json
VITE_BASE=/OpenSesame/ node scripts/lib/ci-pages-build.mjs
node docs/audit/evidence/2026-10-18-retired-credentials/capture-build-witness.mjs "$PWD" apps/pages/dist /tmp/retired-build-after.json
node docs/audit/evidence/2026-10-18-retired-credentials/capture-ui.mjs apps/pages/dist after /tmp/retired-ui-proof
node apps/pages/test/original-browser-physical/runner.mjs "$PWD" /tmp/retired-native-proof
```

The UI driver creates a real local owner with a fresh PIN, inspects and enrolls
through fresh owner verification, verifies synthetic consent is required, and
opens the canary receiver form. The receiver screenshot establishes that form's
actual controls; it does not claim network delivery. Service workers are
blocked during UI capture and external networking is denied. The native runner
uses original browser OPFS, IndexedDB, Web Locks and actual cryptography; its
source closure includes Core, the vault kernel, fixtures, manifests and lockfile,
not every installed external package byte.

`SHA256SUMS.json` covers the preserved images and reports. The managed
Chromium extension policy blocks unpacked extensions; there is no extension
runtime screenshot claim. The separate Rust Host sealed-store and native
wallet products are outside this Client-vault format; see ADR 0207.
