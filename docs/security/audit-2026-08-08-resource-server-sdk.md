# Audit tick 66 — the resource-server SDK verified less than it looked like it did

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny,
osv-scanner). Read `packages/sdk-server` — the verifier and Hono middleware a third
party drops in front of its own API to trust OpenSesame tokens. Whatever this package
fails to check, every integrator fails to check.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | A token with no `exp` verified forever. `jwtVerify` only checks the claims a token happens to carry, and none were required. | `requiredClaims: ["iss","sub","aud","exp"]`. |
| High | No algorithm pin. The verifier accepted whatever algorithm the key it found could carry, leaving the choice to the token rather than the resource server. | `algorithms` pinned to an asymmetric default set, overridable per deployment. |
| High | Issuer and JWKS URI were taken at any scheme. A JWKS fetched over cleartext is one an attacker on the path chooses, and every signature check after that is theatre. | `assertSecureUrl` on both: https, or http on loopback for local development. |
| Medium | The middleware ran `await next()` inside its own `try`. A downstream handler's failure came back as `401 invalid_token` with the handler's error message in `error_description` — an internal error echoed to whoever asked. | `next()` moved outside the catch. |
| Medium | `error_description` returned the verifier's own error text (JWKS fetch failures, claim details) to the caller. | Fixed description; the real error still reaches `onError` and the integrator's logs. |
| Low | 401s carried no `WWW-Authenticate` challenge, which RFC 6750 requires of a bearer-protected resource. | Challenge added to both 401 paths. |

Also added opt-in `requireAccessTokenTypeHeader` for issuers that stamp the RFC 9068
`at+jwt` header, so an integrator can refuse anything that is not an access token
outright rather than relying on the `token_use` claim being present.

## Tests

`packages/sdk-server/src/verifier.test.ts`: a token with no `exp` is refused, an
algorithm outside the accepted set is refused, cleartext issuer and JWKS URIs are
refused while loopback stays usable, the RFC 9068 header is enforced when asked for,
a 401 carries a challenge and no verifier internals, and a handler's own failure is
not reported as an invalid token.

## Not fixed

- The JWKS URI still defaults to `{issuer}/jwks` rather than being read from the
  issuer's discovery document. Correct for this deployment, wrong in general.
