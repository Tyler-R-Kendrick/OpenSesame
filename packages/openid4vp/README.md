# @opensesame/openid4vp

The verifier half of OpenID4VP 1.0 for the Identity plane. It builds an
authorization request that asks a wallet to prove something (DCQL query,
signed request object, transaction data), then verifies the SD-JWT VC
presentation that comes back and binds it to an authorization decision. It is
server-side, has no database dependency, and returns evidence rather than
tokens.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane) (a durable
  request-session store in `src/repos/durable-openid4vp-session-store.ts`) and,
  in tests, [`packages/openid4vci`](../openid4vci).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) and `jose`.
- A presentation is digest-bound: `assertApprovalBinding` checks that the
  holder signed a transaction-data entry naming this request's protocol digest
  and its approval digest, which is the value ADR 0086 compares against the
  interaction's own `requestDigest`.
- `SUPPORT_MATRIX` in `src/index.ts` is the conformance statement: DCQL only,
  `direct_post` and `dc_api` response modes, `dc+sd-jwt` / `vc+sd-jwt`, ES256,
  ES384 and EdDSA, and a `notSupported` list with reasons. Quote it rather than
  paraphrase it.

## Surface

| Area | Exports |
|---|---|
| Request (`request.ts`) | `buildAuthorizationRequest`, `authorizationRequestParameters`, `signRequestObject`, `buildTransactionData`, `transactionDataHash`, `digitalCredentialsRequest` |
| Query (`dcql.ts`) | `DcqlQuery` types, `assertDcqlProfile`, `dcqlQueryToJson` |
| Digests (`digests.ts`) | `deriveRequestDigests`, `operationDigest`, `protocolDigest` |
| Flow (`routes.ts`, `session.ts`) | `beginPresentation`, `finishPresentation`, `InMemoryRequestSessionStore` |
| Verify (`verify.ts`, `transaction-binding.ts`) | `verifyPresentation`, `assertApprovalBinding` |
| SD-JWT (`sd-jwt.ts`) | `parseSdJwt`, `readDisclosures`, `resolveDisclosures` |
| Response (`courier.ts`) | `readCourierResponse`, `isCompactJwe`, `isEncryptedResponseMode` |
| JOSE and errors | `readSignedCompactJws`, `SUPPORTED_SIGNATURE_ALGORITHMS`, `Openid4vpError`, `isOpenid4vpError` |
| `SUPPORT_MATRIX` | What is implemented and what is refused |

## Develop

```bash
pnpm --filter @opensesame/openid4vp test
pnpm --filter @opensesame/openid4vp typecheck
```

`src/__fixtures__/holder.ts` is a test holder that mints presentations.

## Related

- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — the
  wallet-native interaction layer
- [ADR 0058](../../docs/adr/0058-native-authenticator-and-openid4vc-wallet.md)
  — the native authenticator as holder
- [ADR 0125](../../docs/adr/0125-wallet-native-proof-admission.md) — proof
  admission
- Issuer side: [`@opensesame/openid4vci`](../openid4vci)
