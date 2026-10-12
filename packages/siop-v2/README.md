# @opensesame/siop-v2

Self-Issued OpenID Provider v2 utilities, pinned to Implementer's Draft 1
(`openid-connect-self-issued-v2-1_0-07`): authentication-request parsing,
Self-Issued ID Token building and verification, JWK-thumbprint subjects on
EC P-256, and fragment response helpers. It covers both the Self-Issued OP
side (the Pages PWA answering a request) and the RP verifier side. Read
`SUPPORT_MATRIX` in [`src/index.ts`](src/index.ts) before citing this package:
it lists what is implemented and, with a reason each, what is not.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (`screens/SiopAuthorize.tsx`, the `identity.siop` capability module), [`packages/control-plane`](../../packages/control-plane) (`services/siop-verify.ts`, the hosted bridge), [`examples/siop-rp`](../../examples/siop-rp); [`packages/app-core`](../app-core) (`lib/siop-authority.ts`, `lib/siop-keys.ts`).
- **Builds on:** [`@opensesame/os-domain`](../os-domain), `jose`.
- ES256 on P-256 only, `response_type=id_token`, `scope=openid`, `response_mode=fragment`, subject syntax `urn:ietf:params:oauth:jwk-thumbprint`. The JOSE header fence refuses `alg: none` and every other algorithm before a signature is checked.
- A token is verified with the bare key in `sub_jwk` only, never a `jwks_uri`; a `sub_jwk` carrying a private `d` is refused.
- Not supported: `did:` subjects, `response_mode=post`, signed request objects and `request_uri`, dynamic RP registration, VP tokens (those belong to [`openid4vp`](../openid4vp)), and OpenID Connect Discovery (`.well-known/openid-configuration`, `token_endpoint`, `jwks_uri`): a static origin has no back channel and no per-person key set ([ADR 0161](../../docs/adr/0161-what-a-static-origin-can-be-as-an-openid-provider.md)). This is SIOPv2 (Implementer's Draft), **not a conventional OIDC provider**.
- Every input has a documented size and time limit (`limits.ts`); a breach is a typed `SiopV2Error`, never a partial result.

## Surface

| Area | Exports |
|---|---|
| Requests | `parseAuthorizationRequest`, `serializeAuthorizationRequest`, `SCOPE_OPENID`, `RESPONSE_TYPE_ID_TOKEN`, `RESPONSE_MODE_FRAGMENT` |
| ID tokens | `buildSelfIssuedIdToken`, `verifySelfIssuedIdToken`, `exportPublicEcP256Jwk`, `STATIC_SELF_ISSUED_ISSUER` |
| Keys | `parsePublicEcP256Jwk`, `ecP256JwkThumbprint` (RFC 7638), `readSignedCompactJws`, `SUPPORTED_SIGNATURE_ALGORITHMS` |
| Issuers | `resolveIssuer`, `assertAllowedIssuer`, `STATIC_SIOP_METADATA` — static `https://self-issued.me/v2`, or a dynamic HTTPS issuer with `i_am_siop: true` (loopback HTTP for local dogfood) |
| Pages metadata | `pagesSiopIssuer`, `pagesOriginOf`, `siopMetadataUrl`, `buildPagesSiopMetadata`, `serializePagesSiopMetadata` (what a build publishes as `siop-metadata.json`, derived from `STATIC_SIOP_METADATA`); `parseSiopMetadata`, `fetchSiopMetadata` (the consumer: injected `fetch`, no redirects, byte-capped, issuer pinned by the RP, an explicit `metadataUrl` at the issuer's origin unless `allowMirror`, loopback `http` only with `allowLoopbackHttp`) |
| Relying-party kit | `createSiopRelyingParty` / `SiopRelyingParty` (`startLogin` returns a `binding` the caller keeps in the starting browser; `completeLogin` requires it with `receivedRedirectUri`: state, binding, nonce, audience, redirect_uri, replay), `SiopRpError`, `generateLocalClientId`; stores `MemoryLoginStore`, `MemoryReplayLedger`, `StorageLoginStore` (bounded: they prune what expired, then refuse when full) and the `SiopLoginStore` / `SiopReplayLedger` interfaces |
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
`request.property.test.ts` (fast-check) suites cover refusals; `discovery*.test.ts`,
`rp*.test.ts` (`rp.binding.test.ts` holds the binding and the every-check-fails-alone
table) and `rp-store.test.ts` cover the metadata and the relying-party kit.
The browser journey, including the example relying parties on other origins, is
`pnpm --filter @opensesame/pages verify:siop`. The copy-ready examples are
[`examples/siop-rp`](../../examples/siop-rp) and the guide is
[Use OpenSesame Pages as your login](../../docs/operators/use-pages-as-your-login.md).

## Related

- [ADR 0116](../../docs/adr/0116-browser-native-siop-v2.md) — browser-native SIOPv2
- [ADR 0117](../../docs/adr/0117-hosted-siop-oidc-bridge.md) — the hosted SIOP-to-OIDC bridge
- [ADR 0161](../../docs/adr/0161-what-a-static-origin-can-be-as-an-openid-provider.md) — what a static origin can be as an OpenID Provider
