# SOPS wire compatibility

**Status**: Completed 2026-09-21 · Source of truth for what the OpenSesame browser SOPS engine is, and is not, wire-compatible with.

---

The OpenSesame browser SOPS engine (`apps/pages/src/lib/sops/`) re-implements the sops v3 data plane for the browser. It is the formats-interoperability core for C13 in the vault-key-protection program (ADR 0129), where a sealed vault is exported as `vault-secrets.sops.json`, edited by an external sops binary in its native UI, and re-imported.

**Verdict**: the browser engine and pinned upstream `sops` v3.13.3 read each other's YAML and JSON age ciphertexts with no shared code — only the wire format and the crypto primitives are shared. That verdict is machine-checked by `pnpm verify:sops-conformance` in both directions (browser→sops and sops→browser, YAML and JSON); the suite skips visibly when the oracle is absent, and every claim in this doc names its re-runnable gate.

## 1. What the engine offers

1. **File encryption** (`encryptSopsDocument`/`decryptSopsDocument`) — the sops-compatible plane. A plaintext file (YAML, JSON, or multi-document streams: `---`-joined for YAML, newline-delimited for JSON) is encrypted leaf-wise; `sops` metadata is attached; the age recipient public key wraps the data key (single recipient or Shamir key groups with threshold).
2. **Vault-secrets export** (`exportVaultSecrets`/`importVaultSecrets`) — the vault-freight plane. A flat or hierarchical projection of the vault is encrypted **wholesale**: every leaf is ENC[...] at export so the only plaintext in the file is structure (key names, types, the `OpenSesame` origin field). An external editor works on the SOPS UI and its per-field policy decides what stays plaintext on their copy; the round-trip back into OpenSesame only needs the values to decrypt.

## 2. Wire compatibility profile

Profile: `sops-browser/v3.13.3-age` — the intersection of the engine's feature set with the pinned upstream binary.

| wire element | upstream sops v3.13.3 | OpenSesame browser engine | verdict |
|---|---|---|---|
| AES-256-GCM per-leaf value encryption | yes | yes | identical |
| sops MAC (SHA-256("sops") init, AES-MAC OCB2 offset 11, LE lengths) | yes | yes | identical |
| `sops` metadata key with `version: 3` | yes | yes | identical |
| age recipients, single and Shamir key groups | yes | yes | identical |
| `encrypted_suffix`, `unencrypted_suffix`, `encrypted_regex`, `unencrypted_regex`, `mac_only_encrypted` | yes | yes (RE2 subset; lookaround/backreferences fail closed) | identical with a narrower regex dialect |
| YAML multi-document streams, one `sops` block on the first document | yes | yes | identical |
| YAML comments | preserved | preserved (round-trip verified after the `Pair` emit fix) | identical |
| YAML aliases, anchors, explicit tags, merge keys | supported upstream | **fail closed** with a refusal, never data loss | divergent (deliberate) |
| ndjson multi-document JSON | yes | yes | identical |
| metadata completeness | full (`mac`, `lastmodified`, `unencrypted_suffix`, `sha256` sum…) | structurally complete; not byte-identical (`shamir_threshold` emitted only when >1) | divergent (documented) |
| KMS/azkv/PGP recipients | yes | age only | divergent |
| `OpenSesame` metadata field | — | yes (origin marker) | OpenSesame extension |
| vault export all-fields (every leaf ENC[...] at export) | no (upstream honors per-field policy) | yes, by design | OpenSesame extension |

## 3. Divergences

- **Fail-closed YAML features.** Anchors, aliases, explicit tags and merge keys are refused at parse (`fromNode` throws). Upstream sops handles them; the browser engine refuses because a C13 export must be lossless, and silently flattening an alias or rewriting a tag is not.
- **Metadata byte layout.** The engine emits a valid v3 metadata object that upstream accepts, but the key order and a few presence rules differ (`shamir_threshold` only when >1, an extra `opensesame` field). Upstream does not require byte-identical metadata.
- **Recipient coverage.** Only age. KMS, GCP KMS, Azure KV and PGP recipients from upstream documents decrypt nothing here; the engine refuses a document it cannot recover a key for rather than pretending.
- **Vault freight is not a sops feature.** The `OpenSesame` metadata field and the all-fields export policy are OpenSesame conventions. Upstream sops edits the file as a normal encrypted document (its own policy applies to its copy).

## 4. Verified claims

- `pnpm verify:sops-conformance` (12 assertions): browser→sops and sops→browser for YAML and JSON; nested maps/seqs, multi-doc YAML, multi-line strings, unicode, `mac_only_encrypted`, empty values, deep nesting.
- `pnpm verify:sops-browser` (12 tests): round-trips, two-of-three key groups, shamir shares, selectors, comment/alias boundary, vault export/import, honest capability report.
- Cloud-KMS live check (`pnpm verify:sops-cloud-live`) is a separate, credentialed gate — not exercised here (no disposable cloud credentials); the browser engine does not call cloud KMS today.

## 5. Out of scope

- Editing the `sops` metadata block by hand outside the engine.
- `sops exec`, `sops exec-env`, and other upstream CLI subcommands — the engine is a library surface behind the Pages UI.
- Cloud KMS providers.
