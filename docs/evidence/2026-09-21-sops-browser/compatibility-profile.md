# SOPS compatibility profile

**Recorded**: 2026-09-21 · Profiles, divergences, and test vectors that define the interop claim.

---

## 1. Upstream oracle

- **binary**: `sops` v3.13.3, linux/arm64, `sha256 53b0abac…` — the interop claim is bound to this pinned binary; a different upstream release re-runs `pnpm verify:sops-conformance` before the claim extends.
- **Direction**: both. Browser→sops (`encryptSopsDocument` output fed to the binary) and sops→browser (binary output fed to `decryptSopsDocument`), for YAML and JSON.

## 2. Profiles

| profile id | status | engine surface | upstream feature set |
|---|---|---|---|
| `sops-browser/v3.13.3-age` | **verified** | `encryptSopsDocument`/`decryptSopsDocument` with age recipients (single or Shamir key groups) | YAML/JSON leaf encryption, sops v3 metadata, age single + key groups, selectors, comments, multi-doc streams, ndjson |
| `sops-browser/v3.13.3-cloud` | not claimed | — (cloud-endpoint.ts exists; no browser engine path calls cloud KMS today) | KMS/azkv recipients |
| `sops-browser/v3.13.3-pgp` | not claimed | — | PGP recipients |
| `sops-browser/v3.13.3-vault-freight` | verified-within-OpenSesame | `exportVaultSecrets`/`importVaultSecrets` — OpenSesame-origin files, every leaf ENC[...] at export; a browser↔browser round-trip is verified; sops-binary editing of vault freight is expected to work but is not asserted by a gate | — |

## 3. Divergences (browser engine vs upstream)

1. **Fail-closed YAML features.** Anchors, aliases, explicit tags and merge keys are refused at parse; upstream supports them. C13 demands a lossless export — silently flattening an alias is not lossless, so the engine refuses.
2. **Metadata byte layout.** The engine's metadata is structurally complete and upstream-accepted, but not byte-identical: `shamir_threshold` is emitted only when >1, and an `opensesame` origin field is added.
3. **Recipient coverage.** age only. A document whose data key is wrapped only for KMS/azkv/PGP recipients cannot be opened; the engine refuses rather than pretending.
4. **Regex dialect.** Selectors accept a RE2 subset; lookaround and backreferences are refused (parse-time), matching the Go-side RE2 limits without the regex engine.

## 4. Test vectors

The vectors are the conformance suite itself: `apps/pages/src/lib/sops/engine.conformance.test.ts` runs both directions, both formats, with the pinned binary — nested maps/seqs, multi-doc YAML, multi-line strings, unicode, `mac_only_encrypted`, empty values, deep nesting. The suite skips (visibly) when the oracle is unavailable; `results.json` records the run where it executed.
