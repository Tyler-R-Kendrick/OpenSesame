# @opensesame/identity-nostr

An experimental Nostr identity adapter seam for the Identity plane, disabled
by default. It defines a challenge-and-signature adapter that would bind a
Nostr public key as an `ExternalIdentity` subject (never a `Principal.id`), and
validates the key format. It is fail-closed: disabled, it throws
`nostr_adapter_disabled`; enabled, it still throws
`nostr_adapter_unimplemented`, because the package has no signature verifier.

## Where it fits

- **Used by:** nothing in the workspace yet; no app or package depends on it.
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (`ExternalIdentity`,
  `AssuranceLevel`).
- Enabled only when `OPENSESAME_NOSTR_ENABLED=true` (read from the environment
  passed to `createNostrAdapter`, `process.env` by default).

## Surface

| Export | What it does |
|---|---|
| `NostrIdentityAdapter` | `{ id: "nostr", enabled, createChallenge(), verifySignedChallenge({ challengeId, pubkey, signature }) }` |
| `createNostrAdapter(env?)` | Returns the disabled adapter unless the flag is `true` |
| `createDisabledNostrAdapter()` | The always-disabled adapter |
| `assertNostrPubkey(pubkey)` | Throws `nostr_pubkey_invalid` unless the key is 64 lowercase hex characters (x-only secp256k1) |
| `NOSTR_ASSURANCE` | `"self_asserted"` |

## Develop

```bash
pnpm --filter @opensesame/identity-nostr test
pnpm --filter @opensesame/identity-nostr typecheck
```

## Related

- Sibling seam: [`@opensesame/identity-atproto`](../identity-atproto)
