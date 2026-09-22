# Engine measurements — browser-local SOPS

Regenerate with a fresh `apps/pages` build, then:

```bash
SOPS_MEASURE=1 pnpm --filter @opensesame/pages exec vitest run \
  src/lib/sops/engine.measure.test.ts
```

These are measurements, not thresholds, and nothing gates on them. They run
in Node against the same modules the browser worker imports, so they show
the **shape** of the cost — one AES-GCM record per encrypted leaf — not any
particular device's speed. A phone is slower.

The measured growth is somewhat worse than linear at the top of the range
(5x the pairs costs roughly 8.6x the time between the last two rows), so a
document near the 8 MiB input ceiling is a visibly slow operation rather
than an instant one. That is why the work runs in a worker and why the
ceiling exists; it is a disclosed cost, not a tuned one.

## Cost by document size

One age recipient, YAML, 5 runs per size, median reported. "encrypt"
is `encryptNew` (parse, per-leaf encrypt, MAC, emit). "open+decrypt" is
`open` (parse, unwrap the data key, verify the MAC) plus `plaintext`.

| pairs | plaintext bytes | ciphertext bytes | encrypt ms (median of 5) | open+decrypt ms (median of 5) |
| --- | --- | --- | --- | --- |
| 10 | 400 | 2516 | 5.4 | 9.5 |
| 100 | 4180 | 16916 | 23.6 | 30.2 |
| 1000 | 43780 | 165416 | 116.8 | 150.4 |
| 5000 | 227780 | 829416 | 869.9 | 1378.0 |

Ciphertext is several times the plaintext because every encrypted leaf
carries a 32-byte nonce and a 16-byte tag in base64 — that is the SOPS wire
format, not an engine choice.

## What ships

| artifact | bytes | gzipped |
| --- | --- | --- |
| `sops.worker-CqvxXeyP.js` | 318320 | 106740 |

The worker chunk is loaded only when a SOPS document is opened; it is not on
the boot path. It carries `age-encryption` and the engine.

## Declared bounds

The engine refuses rather than degrades past the limits in
`src/lib/sops/limits.ts`: 8 MiB of input, 64 levels of nesting, 100,000
tree nodes, 32 documents in a stream, 32 key groups, 128 recipient entries.
The regex engine is an NFA simulation with a 4,000-instruction program cap
and a 2,000,000-step execution cap, so a selector cannot backtrack.

Measured on Node v22.22.2, linux-x64.
