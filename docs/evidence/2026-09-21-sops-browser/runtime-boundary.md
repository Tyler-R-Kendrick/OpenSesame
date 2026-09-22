# Runtime boundary — browser-local SOPS engine

**Recorded**: 2026-09-21 · The `apps/pages` runtime contract that makes the sops-interop claim safe.

---

## 1. The boundary

The engine runs entirely in the browser tab: YAML/JSON parse/emit (`yaml`), AES-GCM and the sops MAC (`@noble/ciphers`), age wrap/unwrap (`age-encryption` over WebCrypto), and Shamir (line-faithful port of upstream `shamir.go`).

- **No Host, no daemon, no network service** participates in encrypt or decrypt.
- **The pinned sops binary** runs only inside `pnpm verify:sops-conformance` as an oracle. It is never shipped, never bundled, never invoked from app code.
- **`OPENSESAME_SOPS_BIN`** would only ever be a *test-environment* variable for the oracle path; the app must never consult it at runtime — a UI instruction to install a native binary is a capability claim we refuse (verified by the `pnpm verify:sops-browser` UI scan and the honest-capability test).

## 2. Asset pipeline implications

- **Bundle**: engine modules are lazily imported by the Settings sheet; tree-shaken when the section is not visited. Bundle budgets gate in CI cover this.
- **CSP**: the engine requires `wasm-unsafe-eval`-free operation (noble ciphers is pure-JS; age-encryption uses WebCrypto). No eval, no remote code, no remote fonts.
- **Storage**: ciphertext documents enter and leave as files through the download/file-picker paths; nothing is auto-uploaded. Vault freight import lands as a local tomb copy only after explicit consent (threshold documents ask first).

## 3. Trust reasoning

The data key exists in memory only between unwrap and per-leaf encryption; it is zeroed in `finally` blocks (`engine.ts`). Session material never enters the engine — vault export reads the sealed tomb's items through the vault store's unlock path and wraps them with a fresh data key.
