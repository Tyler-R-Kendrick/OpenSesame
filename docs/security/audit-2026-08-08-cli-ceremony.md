# Audit tick 68 — the CLI took the issuer's word for where to send the code

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, osv-scanner, cargo-deny). Read
`packages/sdk-cli` — loopback login, device flow, control-plane client — and the
`packages/cli` dispatch that drives them. Same class of gap as ticks 66 and 67, on the
third surface: a discovery document used as returned.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Neither `loopbackLogin` nor `DeviceFlowClient` compared the discovery document's `issuer` to the configured one, or required any endpoint to be reachable over a channel nobody can rewrite. Whatever answered chose where the authorization code, the PKCE verifier, and the device code went. | `assertDiscoveryBelongsToIssuer` plus `assertSecureUrl` on the issuer and every endpoint used (https, or http on loopback). |
| High | The device flow printed `verification_uri` and `verification_uri_complete` straight from the response for a person to open and type a code into. A tampered issuer got a phishing page delivered in the CLI's own voice. | Both URIs held to the same bar as the endpoints. |
| Medium | `pollClaim` interpolated the claim id into the request path unencoded, so an id carrying `../` aimed the request — and the `x-claim-token` header with it — at another endpoint. | `encodeURIComponent`. |
| Medium | `createControlPlaneClient` accepted any `baseUrl` scheme while attaching a bearer token. | Validated at construction. |
| Medium | The loopback server had no deadline. An abandoned login left a port listening for the rest of the session. | Default 5-minute timeout, configurable, with the handle unref'd. |
| Medium | Any local request to the loopback port ended the login: a callback with a wrong state rejected the promise and closed the server, so any process on the box could cancel a sign-in. | A callback without the minted state gets a 400 and the login keeps waiting. |
| Low | `server.close()` waits on the keep-alive socket a browser leaves open, so the CLI could sit there after a successful login. | `closeAllConnections()` on every exit path. |
| Low | `pollUntilComplete` ignored `expires_in` and polled forever against a server that only ever says `authorization_pending`; `slow_down` raised the interval without bound. | Deadline from `expires_in`; interval capped at 60s. |
| Low | `redactSecrets` missed `code_verifier`, `client_assertion`, `operator_token`, `authorization`, `password`, and api keys. | Pattern extended, with `token_type` and `user_code` deliberately left readable. |
| Low | A thrown endpoint refusal reached the top-level `await` in `bin.ts` as an unhandled rejection. | `runCli` dispatch wrapped: the message is printed and exit code is 1. |

## Tests

New `loopback.test.ts` runs the real server: a redirect carrying the minted state
completes, a stray local callback gets 400 without ending the login, an absent redirect
times out, and a mis-attributed or cleartext discovery document is refused. New
`control-plane.test.ts` pins the path encoding and the cleartext refusal.
`device-flow.test.ts` gains refusals for a foreign issuer, a phishing verification URI,
a cleartext issuer, an expired device code, and an unbounded poll interval.
