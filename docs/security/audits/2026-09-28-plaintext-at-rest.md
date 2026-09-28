# Audit 2026-09-28 — Client data at rest in the clear

Scope: everything the client plane writes to a device. That covers the Pages
app's Web Storage, origin-private files and IndexedDB; MSAL's cache; the
browser extension's `chrome.storage`; `client-core`'s sync store; and the
CLI core's `local-storage.json`. Decision: [ADR 0149](../../adr/0149-nothing-stored-in-the-clear.md).

## Method

A production build of `main` at `de8bf529` was served under the real origin
in headless Chromium: first the guest road, then Google sign-in through a
mocked shoo.dev. The origin's storage was then read raw, and each value
checked for the `osr1.` seal prefix.

## Findings

1. **High — the federation session in `localStorage`.** It held the upstream
   ID token, the pairwise subject, and the person's name and email. Any
   reader of the profile's `Local Storage/leveldb` files had a bearer
   assertion and an identity.

2. **High — a credential handle in IndexedDB.** Provisional history accounts
   (`opensesame-history-backups/accounts`) stored `anonToken`, which is
   "the anon/agent credential handle", as a plain field.

3. **High — Entra tokens in `sessionStorage`.** MSAL was configured with
   `cacheLocation: "sessionStorage"`, so ID tokens and account records were
   written to the store in the clear, past every app wrapper.

4. **Medium — ceremony bearers between steps.** These were the claim bearer
   (`opensesame.claim`), the join invite and pending records, and the PKCE
   verifier in flight, all in the clear in Web Storage.

5. **Medium — the vault's plaintext boundary.** The header's KDF parameters
   and wrap metadata, lockout counters, the tomb registry, and capability
   receipts were plaintext OPFS files, as ADR 0063 documented. None is a
   secret on its own. Together they profile the device and its unlock
   methods for an offline attack on the vault key.

6. **Low — everything else.** Settings, wallet leases and spent assertions,
   the guest principal, ambient-auth state, the extension's `hostApiBase`,
   and the sync store's device id and epoch.

After a Google sign-in, 17 of 17 app-owned values were in the clear.

## Fix

- Every value is sealed under a device key held by the host (ADR 0149 §1–3).
  The seal is XChaCha20-Poly1305, bound to its store and name. In a browser
  the key is wrapped by a non-extractable IndexedDB key.
- Legacy plaintext is sealed in place at the next boot or read (§5).
- MSAL keeps its cache in memory.
- Where no key can be kept, nothing is written to disk at all (§4).

## Verification

- Unit tests: `packages/app-core/src/lib/at-rest/*.test.ts` and
  `packages/client-core/src/sealed-store-io.test.ts`, which read every store
  raw. The extension's `tests/pact.test.mjs` refuses any
  `chrome.storage.local.set` of `hostApiBase` that is not a sealed value.
- `pnpm --filter @opensesame/pages verify:static` reads the origin raw after
  the guest road (16 values) and after Google sign-in (17 values). Every one
  is sealed. No guest name, pairwise subject or personal name appears
  anywhere. The key reports `extractable: false`.
- Upgrade: a profile signed in on the base build (17 of 17 in the clear)
  was reloaded on the fixed build. All 17 values were sealed and it landed on
  the same screen.
- `verify:auth`, `verify:keyboard`, `verify:local-iam`, `verify:ambient-sso`
  and `verify:duress:browser` pass against the fixed build.

## Residual risk

- Script running in the origin can use the key: XSS, an extension content
  script, or another project site on the shared `github.io` origin. The
  vault key remains the protection for vault contents.
- Someone holding the whole browser profile can, with effort, recover the
  wrapping key from the browser's own IndexedDB serialization.
- Key names, file names (random tomb ids), sizes and timestamps remain
  visible.
- MSAL's in-flight redirect record, and the relying-party SDKs' storage on
  their own origins, are outside this change (ADR 0149, "What this
  protects, and what it does not").
