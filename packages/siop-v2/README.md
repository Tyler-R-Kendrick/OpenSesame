# @opensesame/siop-v2

Self-Issued OpenID Provider v2 utilities, pinned to Implementer's Draft 1
(`openid-connect-self-issued-v2-1_0-07`): authentication-request parsing,
Self-Issued ID Token building and verification, JWK-thumbprint subjects on
EC P-256, and fragment response helpers. It covers both the Self-Issued OP
side (the Pages PWA answering a request) and the RP verifier side. Read
`SUPPORT_MATRIX` in [`src/index.ts`](src/index.ts) before citing this package:
it lists what is implemented and, with a reason each, what is not.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (`screens/SiopAuthorize.tsx`, the `identity.siop` capability module), [`apps/control-plane`](../../apps/control-plane) (`services/siop-verify.ts`, the hosted bridge), [`examples/siop-rp`](../../examples/siop-rp); [`packages/app-core`](../app-core) declares it for its tests.
- **Builds on:** [`@opensesame/os-domain`](../os-domain), `jose`.
- ES256 on P-256 only, `response_type=id_token`, `scope=openid`, `response_mode=fragment`, subject syntax `urn:ietf:params:oauth:jwk-thumbprint`. The JOSE header fence refuses `alg: none` and every other algorithm before a signature is checked.
- A token is verified with the bare key in `sub_jwk` only, never a `jwks_uri`; a `sub_jwk` carrying a private `d` is refused.
- Not supported: `did:` subjects, `response_mode=post`, signed request objects and `request_uri`, dynamic RP registration, VP tokens (those belong to [`openid4vp`](../openid4vp)), and a discovery HTTP client.
- Every input has a documented size and time limit (`limits.ts`); a breach is a typed `SiopV2Error`, never a partial result.

## Surface

| Area | Exports |
|---|---|
| Requests | `parseAuthorizationRequest`, `serializeAuthorizationRequest`, `SCOPE_OPENID`, `RESPONSE_TYPE_ID_TOKEN`, `RESPONSE_MODE_FRAGMENT` |
| ID tokens | `buildSelfIssuedIdToken`, `verifySelfIssuedIdToken`, `exportPublicEcP256Jwk`, `STATIC_SELF_ISSUED_ISSUER` |
| Keys | `parsePublicEcP256Jwk`, `ecP256JwkThumbprint` (RFC 7638), `readSignedCompactJws`, `SUPPORTED_SIGNATURE_ALGORITHMS` |
| Issuers | `resolveIssuer`, `assertAllowedIssuer`, `STATIC_SIOP_METADATA` — static `https://self-issued.me/v2`, or a dynamic HTTPS issuer with `i_am_siop: true` (loopback HTTP for local dogfood) |
| Validity | `assertTokenFreshness`, `assertIAmSiopClaim`, `readEpoch`, `readAudience` |
| Linking | `resolveSiopLinkProfile`, `challengeIssuerFromProfile`, `bodyOffersEmailJoin` |
| Responses | `serializeFragmentSuccess`, `serializeFragmentError`, `parseFragmentResponse`, `attachFragment` |
| Limits and errors | `MAX_ID_TOKEN_CHARS`, `MAX_AUTH_REQUEST_CHARS`, `DEFAULT_ID_TOKEN_TTL_SECONDS`, …; `SiopV2Error`, `isSiopV2Error` |

## Develop

```bash
pnpm --filter @opensesame/siop-v2 test
pnpm --filter @opensesame/siop-v2 typecheck
```

`src/matrix.test.ts` pins the support matrix; the `*.adversarial.test.ts` and
`request.property.test.ts` (fast-check) suites cover refusals. The browser
journey is `pnpm --filter @opensesame/pages verify:siop`.

## Related

- [ADR 0116](../../docs/adr/0116-browser-native-siop-v2.md) — browser-native SIOPv2
- [ADR 0117](../../docs/adr/0117-hosted-siop-oidc-bridge.md) — the hosted SIOP-to-OIDC bridge
