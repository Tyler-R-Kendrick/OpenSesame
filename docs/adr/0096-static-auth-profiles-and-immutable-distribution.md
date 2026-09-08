# ADR 0096: Verified static-auth profiles and immutable distribution

## Status

Accepted. Supersedes the production admission, browser verification and fragment
fallback portions of ADR 0034; its historical rationale remains intact.

## Context

Static Pages has no private issuer signing key. Passing through an upstream
token does not change its audience, and consent does not verify its authenticity.
Executing a broker-hosted script also gives that script the relying party's
origin privileges. These are distinct trust decisions and require explicit
profiles rather than an unverified default sign-in callback.

Shoo's browser contract provides CORS on `/token` and `/session/check`, not its
discovery/JWKS endpoints. A browser integration cannot assume a JWKS fetch is a
working verification path for that provider. This does not change the compiled
Google-via-Shoo and guest roads on the offline Pages front door.

## Decision

1. `packages/static-auth` is the canonical static integration. Its named
   `hosted_identity` profile is the recommended remote-RP path: authorization
   code with PKCE S256, exact configured issuer/client/redirect/endpoints,
   transaction-specific state and nonce, a bounded single-use transaction,
   authorization-response issuer identification, and verified ID-token claims
   and signature against the configured issuer's bounded JWKS. The audience
   is the configured RP client, not the Pages broker. No client secret is
   shipped to a browser. Callback code/state/issuer parameters are removed.
2. `pages_passthrough_loopback` is an explicit local-development compatibility
   profile. It refuses non-loopback relying-party origins, binds state/TTL to
   the exact popup object and broker origin, and has no fragment fallback.
   The upstream token is still audienced to the broker. It is not represented
   as an RP-specific production credential and is not returned in the validated
   public session/event object.
3. The Shoo compatibility validator pins issuer, broker audience and the
   `/session/check` endpoint. It validates the bounded JWT envelope and local
   claims, then requires an active response from that pinned HTTPS endpoint
   with cookies omitted and no redirects, unbounded body or unbounded wait. It never
   fetches message-supplied JWKS or attempts Shoo's non-CORS JWKS path. This is
   online verification delegated to the trusted provider, not a claim that the
   browser independently verified Shoo's signature. Unsupported generic
   passthrough profiles are refused.
4. `opensesame:signed_in` is dispatched only after the selected profile has
   validated. Public results contain the validated subject and expiry, not
   redundant upstream bearer fields. Errors use stable codes, never token or
   provider-response bodies. No generated snippet logs event details.
5. Publish exact versioned browser artifacts, SHA-384 SRI and a manifest
   recording version, package version and source commit. Existing versioned
   bytes cannot change: the canonical build rejects a mismatch. New hosted
   snippets use the exact version, SRI, anonymous cross-origin fetch and
   no-referrer policy. Package imports and self-hosted copies are supported.
   The deprecated root `auth.js` remains a frozen, hash-ratcheted loopback-only
   compatibility artifact; new snippets do not load it.

## Evidence and limits

The source-visible build script and checked-in regression tests connect the
package source, emitted artifact, manifest and hash. Review the actual source
commit and reproduce the build when selecting an artifact. A source-commit
string in a manifest is not independent proof of provenance. SRI pins bytes;
it neither approves the initially selected bytes nor attests that their
publisher, source or signing authority is trustworthy. Repository governance
and source review remain necessary.

Hosted signature/claim verification and loopback online-session validation are
different contracts. Neither prevents malicious code already executing in the
RP origin from acting with that origin's authority. A shared-origin demo is not
an isolated production vault deployment, and an approved loopback recipient
still participates in the compatibility profile's bearer-token trust decision.

The separate browser SDK also verifies its explicit-client and origin-profile
OIDC callbacks before reporting sign-in; the old explicit-client parsing-only
success path is removed. Static-auth tests, SDK signature tests, immutable hash
ratchets and browser journeys are complementary evidence, not a substitute for
the final integrated security gates or a claim that an external AI scanner ran.

## References

- ADR 0034 — original static broker rationale and bearer-audience limitation.
- ADR 0090 — offline Pages, compiled Shoo sign-in and guest access.
- `docs/architecture/federated-signin.md` — current wire contract.
- `packages/static-auth/src/` — canonical profiles and validators.
- `apps/pages/scripts/build-static-auth.mjs` — immutable distribution build.
- `docs/security/audit-2026-09-08-browser-sdk-verification.md` — SDK evidence.
