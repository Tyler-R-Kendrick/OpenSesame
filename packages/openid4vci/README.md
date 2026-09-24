# @opensesame/openid4vci

An OpenID4VCI 1.0 issuer for the minimal OpenSesame credential, on the
Identity plane. It publishes issuer metadata, mints a single-use
pre-authorized-code credential offer, issues nonces, verifies the wallet's
proof of possession, and signs an SD-JWT VC (`dc+sd-jwt`) bound to the
holder's key. The credential carries an opaque subject reference and no
authorization of any kind; runtime authority stays server-side.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane), which backs
  the code and nonce stores durably in `src/repos/openid4vci-stores.ts`.
- **Builds on:** [`@opensesame/os-domain`](../os-domain) and `jose`;
  [`@opensesame/openid4vp`](../openid4vp) is a dev dependency, so tests can
  verify what this package issues.
- `FORBIDDEN_CREDENTIAL_CLAIMS` (such as `scope`) is enforced against the
  assembled payload before signing, on the production path.
- An offer link carries only a reference to the code
  (`assertOfferLinkIsClean`).
- `SUPPORT_MATRIX` in `src/index.ts` is the conformance statement:
  pre-authorized-code grant only, offers by reference, `jwt` proofs with
  ES256 or EdDSA, and a `notSupported` list with reasons. SD-JWT VC is still an
  Internet-Draft (`-18`), pinned to the same revision as the verifier.

## Surface

The flow is five calls:

| Step | Exports |
|---|---|
| 1. Metadata (`metadata.ts`) | `buildIssuerMetadata`, `issuerMetadataUrl`, `CREDENTIAL_ISSUER_WELL_KNOWN` (`/.well-known/openid-credential-issuer`) |
| 2. Offer (`offer.ts`) | `createCredentialOffer`, `assertOfferLinkIsClean`, `CREDENTIAL_OFFER_SCHEME` |
| 3. Redeem (`offer.ts`) | `MemoryPreAuthorizedCodeStore`, `redeemGrant` |
| 4. Proof (`nonce.ts`, `proof.ts`) | `MemoryNonceStore`, `verifyProofOfPossession`, `PROOF_JWT_TYP` |
| 5. Issue (`issue.ts`) | `issueCredential`, `deriveSubjectRef`, `deriveDeviceRef`, `FORBIDDEN_CREDENTIAL_CLAIMS` |

Errors: `Openid4vciError`.

## Develop

```bash
pnpm --filter @opensesame/openid4vci test
pnpm --filter @opensesame/openid4vci typecheck
```

## Related

- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — the
  wallet-native interaction layer
- [ADR 0058](../../docs/adr/0058-native-authenticator-and-openid4vc-wallet.md)
  — the native authenticator and OpenID4VC wallet
- Verifier side: [`@opensesame/openid4vp`](../openid4vp)
