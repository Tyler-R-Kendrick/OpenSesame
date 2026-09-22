# Security review — SOPS browser engine

**Scope**: `apps/pages/src/lib/sops/` (engine, codecs, metadata, shamir, selectors, vault-secrets, cloud-endpoint) and the vault-protection capability surface (`apps/pages/src/lib/vault/protection/sops-browser.ts`, `session-guard.ts`).

**Conclusion**: no blocking finding. One implementation bug was found and fixed (comment preservation at emit — a lossless-claim defect, not a security break); the crypto cores and the trust boundary hold.

## Findings

### F1 — Comment loss at emit (fixed this commit)

`yaml-codec.ts#toYaml` built map entries with `YAMLMap.set()`, which stores a plain string as the key; `commentBefore` attached to a plain string never renders. Comments survived parse but were dropped on every re-emit, silently breaking the C13 lossless claim. Fixed by constructing explicit `Pair(new Scalar(key), value)` nodes; round-trip test added.

**Severity**: data-fidelity defect on the lossless claim; not a confidentiality or integrity break — encrypted leaves and the MAC were unaffected.

### F2 — Ephemeral key hygiene (verified, no action)

Data keys are `Uint8Array(32)` from `crypto.getRandomValues`, wrapped per recipient, and zeroed in `finally` (`engine.ts`). Recovered keys zero on every exit path. No key material is logged, stored, or sent anywhere.

### F3 — Fail-closed parse (verified, no action)

Aliases, anchors, explicit tags and merge keys are refused at parse; unknown metadata fields do not switch behavior; a MAC mismatch, an unknown `version`, or an unopenable key group aborts decrypt before any plaintext leaf is produced. Plaintext leaves are only emitted after the full-tree decrypt and the MAC sentence check.

### F4 — Vault-freight import is consent-gated (verified, no action)

Importing a threshold-protected vault export requires the explicit consent flow (`importVaultSecrets` + the UI sheet's confirm); a non-threshold import still refuses fields outside the vault item schema. The imported copy never replaces the existing tomb in place.

### F5 — Cloud endpoints (no live provider calls)

`cloud-endpoint.ts` enforces HTTPS-only, no userinfo, no loopback/link-local/private/metadata endpoints, and full-key match for AWS (prefix/suffix similarity never matches). The browser engine does not call cloud KMS today; the live gate is credentialed and out of scope here.

## Residual risks

- The engine trusts `yaml` 2.8.1's comment/emit fidelity; a regression upstream would surface as the round-trip test failing (kept permanent).
- An external editor of vault freight sees field names and types in plaintext (structural leak, by design — document it in the UI copy when the export sheet mentions it).
- No fuzzing of the YAML boundary beyond the alias/tag probes; a later pass could add Jazzer.js cases over `parseYamlDocuments`.
