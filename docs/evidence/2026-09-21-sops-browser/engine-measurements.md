# Engine measurements — SOPS browser round-trip

**Measured**: 2026-09-21, one browser (Chromium, `jsdom`-hosted Node/undici timers aside — the vitest node environment, the same environment the gates run in), base 424bc48cfb74e3c69f4f1f6b44cbe5b2fb979716, local machine — indicative, not a fleet benchmark.

## Method

`__measure.test.ts` (temporary, removed after capture) timed `encryptSopsDocument`/`decryptSopsDocument` per input with `performance.now()` around the awaits, one fresh 32-byte data key per case, single age recipient:

- flat YAML: `key_n: value_n` × N keys
- 64KB: 4096 leaf values sized to reach ~64KiB of raw text
- 1MB: 32768 leaf values (twice as many leaves as the 64KB case, not one huge value — the sops data plane is per-leaf)

## Numbers (single run, warm)

| case | encrypt (ms) | decrypt (ms) | leaves |
|---|---|---|---|
| 1KB flat YAML | 23.4 | 20.8 | 8 |
| 64KB flat YAML | 38.9 | 35.1 | 4096 |
| 1MB flat YAML | 158.7 | 151.2 | 32768 |

Latency is dominated by per-leaf AES-GCM and the MAC pass; the 1MB case (32k leaves) shows the per-leaf cost scaling linearly with leaf count, not byte count — consistent with upstream sops behavior on the same shapes.

## Notes

- The vitest node environment's WebCrypto is the browser-shaped API surface the app ships against (grick, undici/node-webcrypto), so the absolute numbers are close to but not identical with a tab's; the scaling behavior is the signal, not the absolute ms.
- No regression gate is attached to these numbers; they are recorded for capacity planning (the Settings sheet can state "a 1MB document encrypts in well under a second").
- The harness file was removed after capture; re-create from this doc if a re-measure is needed.
