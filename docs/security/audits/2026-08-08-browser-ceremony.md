# Audit tick 67 — the browser client trusted whatever answered discovery

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny). Read
`packages/sdk-browser` — PKCE, the redirect callback, and session storage.

The discovery document decides where this client sends the authorization code and the
PKCE verifier. It was fetched and used as given.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The discovery document was never checked against the configured issuer, and its `authorization_endpoint` / `token_endpoint` / `end_session_endpoint` were used at any scheme. Whatever answered `/.well-known/openid-configuration` chose where the code and verifier went. | `meta.issuer` must equal the configured issuer; every endpoint used must be https (http on loopback only). |
| High | The `nonce` was minted, sent, and then never checked. The `sub` cached from the returned `id_token` was read straight out of an unverified payload, so an injected id_token decided the identity the application saw. | `assertIdTokenAddressedToUs` checks `iss`, `aud`, and `nonce` before anything is cached, and refuses the exchange otherwise. |
| Medium | `issuer` and `apiBase` were accepted at any scheme, so access tokens and claim approvals could be sent over cleartext. | Both validated at construction. |
| Medium | The stored PKCE verifier was removed only on the success path. A callback that failed on `error=`, on a state mismatch, or on unreadable storage left the verifier behind for a second attempt to spend. | Verifier is removed before the state is compared, and on every failure path. |

## Tests

`packages/sdk-browser/src/client.test.ts`: an id_token with a foreign nonce, audience,
or issuer is refused and leaves no session; a discovery document naming a different
issuer is refused; cleartext issuer, `apiBase`, and `token_endpoint` are refused while
loopback stays usable; and the stored verifier is gone after both a forged state and a
refused authorization.

## Notes

The browser cannot verify an id_token signature, so the access token remains the
authority and the id_token is only a hint — but a hint failing these three checks is
somebody else's token, and caching a `sub` from it hands the application the wrong
identity. Consumers (`apps/pages`, `apps/console`, the example RPs) default to loopback
and wrap construction in `try`/`catch`, so a cleartext issuer now surfaces as an error
rather than a silent downgrade.
