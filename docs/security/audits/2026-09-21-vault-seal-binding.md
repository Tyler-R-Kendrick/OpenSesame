# Audit 2026-09-21 — Vault seal binding and session boundary

## Findings reproduced in this change

1. **Sealed files were not bound to their path.** AES-GCM seals for the
   vault body, the tomb index, and sealed files carried no associated data.
   Two paths that shared a vault key could exchange ciphertext and still
   open. **Fix:** seals take additional data `vault-seal`, the tomb, and
   the path. Unlock rewrites every unbound seal under the tomb and writes
   `seal-bound.v1`. After that marker, only path-bound seals open — there
   is no permanent unbound fallback. A moved seal fails the authentication
   tag. Portable export records the source tomb; import may still open an
   older unbound export once while merging into the bound vault.
   **Test:** `crypto-binding.test.ts`, `vfs.test.ts`.

2. **Item types were installed before the second step succeeded.** Loading
   the body to read the vault's own authenticator also registered that
   body's item-type definitions. A wrong code left them in the process
   registry, and lock did not clear them, so the next session could see
   another vault's definitions. **Fix:** definitions are registered only
   after the session is activated, and lock restores the built-in registry.
   **Test:** `session-boundary.test.ts`.

3. **A SOPS vault import accepted any JSON object with an id and a kind.**
   An imported document could add fields the item model does not have and
   still be saved. **Fix:** import checks the item against the field list
   for its kind and rejects anything else, including a custom field with an
   unknown property. **Test:** `engine.test.ts`.

4. **Drop-claim digests and the device pepper were in localStorage.** The
   vault kv transport forbids that store. **Fix:** the claim plane reads
   and writes the OPFS kv. A value still sitting in localStorage is copied
   once and then removed.
