# Browser-local SOPS — 2026-09-21

Supersedes the SOPS row in `docs/evidence/2026-09-20-vault-key-protection/`. That earlier row stays a historical native-client result (`OPENSESAME_SOPS_BIN`); this note records what this checkout actually ran: the browser engine, with no native binary in the app path.

## Gates that ran (all exit 0, base `424bc48c`)

```sh
pnpm verify:sops-browser        # 12/12 unit tests (incl. conformance skips when oracle absent)
pnpm verify:sops-conformance    # 12 assertions vs pinned oracle, YAML + JSON, both directions
pnpm verify:sops-cloud-live     # blocked-external (no disposable cloud credentials; local age unaffected)
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
pnpm --filter @opensesame/pages exec vitest run src/lib/sops   # 9 passed / 2 oracle-skips
pnpm --filter @opensesame/pages typecheck
```

Pinned oracle: sops 3.13.3, Linux arm64, sha256 `53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77` (amd64 `e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b`), upstream source commit `26e2f4784ca61353082c32dbd987c25eda086dc9`. The oracle runs only inside the verify gates — never shipped, never in the app path.

## Engine

TypeScript orchestration in `apps/pages/src/lib/sops/`: `age-encryption` 0.4.1 wrap/unwrap, `@noble/ciphers` 2.0.1 AES-256-GCM (32-byte nonce) + the sops AES-MAC OCB2 (MAC init = SHA-256("sops"), offset 11, little-endian lengths — asserted in `metadata.test`), `yaml` 2.8.1 comment-preserving parse/emit. Shamir split/combine is a line-faithful port of the pinned `shamir.go` (MPL-2.0), unit-tested at 33-byte shares.

Wired and verified: YAML + JSON, multi-document streams (`---`-joined YAML, ndjson JSON), comments preserved through a round-trip, single and Shamir key groups (two-of-three verified), suffix/regex/comment selectors and `mac_only_encrypted`, `OpenSesame` origin metadata, whole-vault export (`vault-secrets.sops.json`, every leaf ENC[...]) and consent-gated import. The Settings › Formats sheet is the UI.

## What changed here

- **Comment emit fixed** (`yaml-codec.ts`): map keys are now real `Scalar` nodes inside explicit `Pair`s; `YAMLMap.set()` kept a plain string key and silently dropped `commentBefore`. Round-trip test is permanent (`engine.test.ts` "preserves comments through a round-trip").
- **README claims refreshed**: multi-group encryption *is* wired (the earlier "not wired yet" note was stale); the "not claimed" list below is the corrected one.

## Not claimed

- Cloud KMS live calls (`verify:sops-cloud-live` records `blocked-external` without disposable credentials; the browser engine does not call cloud KMS today).
- KMS/azkv/PGP recipients in documents (age only; such documents refuse rather than pretend).
- YAML aliases/anchors/explicit tags/merge keys — fail closed by design (lossless claim); upstream sops accepts them.
- Byte-identical metadata layout (structurally complete, upstream-accepted; `shamir_threshold` only when >1, plus the `opensesame` origin field).
- Byte-identical JSON key order vs an upstream emit (structural equality is what the gates assert).

## Artifacts

`results.json` (case ledger) · `traceability.md` (requirement→file→gate ledger) · `compatibility-profile.md` (profiles + divergences + vectors) · `sources.lock.json` (dep + oracle lock) · `runtime-boundary.md` (browser runtime contract) · `security-review.md` (F1–F5 findings) · `engine-measurements.md` (round-trip latencies) · `cloud-live.json` (the blocked-external record). Raw gate output is not committed (repo ignores `*.log`); every claim above names its re-runnable gate command.

Wire-compat source of truth: `docs/security/sops-wire-compatibility.md`. ADR 0129 Decision §7 amended in place (2026-09-21).

