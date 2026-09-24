# @opensesame/identity-atproto

An experimental AT Protocol identity adapter seam for the Identity plane,
disabled by default. It defines the adapter interface that would verify an AT
Protocol session and return the DID as an `ExternalIdentity` subject (never a
`Principal.id`), and validates DID syntax. It is fail-closed: disabled, it
throws `atproto_adapter_disabled`; enabled, it still throws
`atproto_adapter_unimplemented`, because the package has no PDS verifier.

## Where it fits

- **Used by:** nothing in the workspace yet; no app or package depends on it.
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (`ExternalIdentity`,
  `AssuranceLevel`).
- Enabled only when `OPENSESAME_ATPROTO_ENABLED=true` (read from the
  environment passed to `createAtprotoAdapter`, `process.env` by default).

## Surface

| Export | What it does |
|---|---|
| `AtprotoIdentityAdapter` | `{ id: "atproto", enabled, verifySession({ did, pds?, accessJwt? }) }` |
| `createAtprotoAdapter(env?)` | Returns the disabled adapter unless the flag is `true` |
| `createDisabledAtprotoAdapter()` | The always-disabled adapter |
| `assertAtprotoDid(did)` | Throws `atproto_did_invalid` on a malformed `did:` |
| `ATPROTO_ASSURANCE` | `"verified"` |

## Develop

```bash
pnpm --filter @opensesame/identity-atproto test
pnpm --filter @opensesame/identity-atproto typecheck
```

## Related

- Sibling seam: [`@opensesame/identity-nostr`](../identity-nostr)
- [ADR 0054](../../docs/adr/0054-file-attachment-storage.md) — notes the
  adapter is a fail-closed stub with no XRPC client
