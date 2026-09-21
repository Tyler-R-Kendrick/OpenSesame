# Browser-local SOPS — 2026-09-21

Supersedes the SOPS row in `docs/evidence/2026-09-20-vault-key-protection/`. That earlier row stays a historical native-client result. This note records what this checkout actually ran.

## What ran

Pinned oracle: sops 3.13.3, Linux arm64, sha256 `53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77`. amd64 checksum `e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b` is recorded for the other architecture. Source commit `26e2f4784ca61353082c32dbd987c25eda086dc9`.

```sh
SOPS_BIN=/tmp/opensesame-sops-oracle/sops-v3.13.3.linux.arm64 \
  pnpm --filter @opensesame/pages exec vitest run \
  src/lib/sops src/lib/vault/protection/sops-browser.test.ts
```

The Formats sheet encrypts every item in the unlocked vault into `vault-secrets.sops.json` and can import that file back. A threshold document asks before it becomes a vault copy. Local age round-trips, including two-of-three groups, passed against the pinned oracle and the in-browser engine. Cloud live calls remain blocked without disposable credentials. Regex selectors accept the RE2 subset and reject lookaround.

Engine: TypeScript orchestration, `age-encryption` 0.3.1, `@noble/ciphers` 1.3.0 AES-GCM (32-byte nonce). Shamir split/combine is a line-faithful port of the pinned `shamir.go` (MPL-2.0) and is unit-tested at 33-byte shares. Multi-group document encryption is not wired yet.

## Not claimed

Regex and comment selectors, multi-document YAML, encrypted comments, key-group creation, cloud KMS envelopes, offline precache, and sealed vault import/export are not evidenced here. `pnpm verify:sops-cloud-live` records `blocked-external` when no disposable cloud credentials are set. That does not block local age.
