# Browser SDK explicit-client verification — 2026-09-08

The browser SDK previously verified JWT signatures only for origin-profile
clients. Explicit `clientId` flows could persist undecodable or unsigned tokens
and derive a subject without mandatory issuer/audience/nonce evidence. That
branch is removed: both profiles require a signed ID token and access token.

JOSE verifies RS256/ES256 signatures against the configured issuer's discovered
public JWKS. Issuer, audience, subject, nonce, issued-at and expiration are
mandatory; future issuance, not-before, expired tokens, unapproved token types,
and ambiguous audience/authorized-party combinations are refused. Issuers are
compared exactly, not by stripping a trailing slash from an assertion. No
message-supplied key URL is used.

Discovery, JWKS and token responses have a 256 KiB streamed byte ceiling and a
10-second deadline covering body reads. Redirects and ambient cookies are
disabled. JWKS is capped at 32 public keys and ID tokens at 16 KiB. Existing
discovered-endpoint private-network policy remains enforced; credential-bearing
URLs and fragments are rejected.

New PKCE transactions bind the exact issuer and redirect URI and expire after
five minutes. Callback state is spent once before exchange, and issuer-response
mix-up, different redirect paths/origins and duplicate response parameters are
refused. Old in-flight transactions lacking these fields must restart sign-in;
there is no permissive migration branch. Anonymous access is unchanged.

Regression fixtures now generate signing keys and signed tokens instead of
pretending `alg:none` is authenticated. Historical insecure-acceptance tests
are now explicit refusal oracles. Additional tests cover forged tokens with an
attacker key URL, mandatory claims, future times, audience confusion, oversized
responses, redirects, key floods, stalled-body cancellation and callback binding.

The SDK suite passes 101 tests across 10 files; its TypeScript check passes.
This evidence does not claim a model scan or a live provider/browser journey.
The issuer must expose CORS-capable discovery/JWKS/token endpoints. Shoo's
separate active-session browser compatibility profile is not implemented by
this generic OIDC client. Same-origin script compromise remains outside the
protection offered by JWT verification and tab-scoped storage.
