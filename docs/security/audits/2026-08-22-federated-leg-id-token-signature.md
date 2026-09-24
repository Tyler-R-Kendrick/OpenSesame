# Audit: the federated relying-party leg accepted an unverified id_token

Date: 2026-08-22

## Finding

The server-side federated sign-in leg added in ADR 0052
(`apps/control-plane/src/interactions/federated.ts`) admitted principals on an
`id_token` whose **signature was never checked**.

`completeFederatedAuth` called `openid-client`'s `authorizationCodeGrant` and
read the claims straight off the result. `openid-client` does not verify the
`id_token` signature for the authorization-code grant, and it is correct not to
have to: OIDC Core §3.1.3.7 permits a client to rely on TLS to the token
endpoint instead of checking the signature, because the token arrives over a
direct, authenticated channel.

Two things made that reliance wrong here:

1. `docs/architecture/federated-signin.md` §7.5 states that the `id_token`
   signature "verifies against the issuer's published JWKS, discovered from
   `/.well-known/openid-configuration` — never from a hardcoded key." That
   document is the contract; the code did not honor it.
2. Trusted upstreams are HTTPS in production, but a dev or self-hosted stack
   points at an `http://` broker (the mock IdP at `:9090`). There is no TLS
   there to lean on, so the assertion had **no** integrity protection at all.

A chaos test that signed the `id_token` with a key the issuer never published
was accepted: the interaction completed with a 303 into `/auth/…` and a
provisional session cookie was issued. A token with `alg: none` was likewise
accepted.

Not reachable by an unprivileged remote attacker against a correctly configured
production deployment, because TLS to an HTTPS broker still protects the
channel. The exposure is a broker reached over plaintext, a compromised or
misconfigured TLS path, or any proxy terminating TLS in front of the token
endpoint.

## Resolution

- `completeFederatedAuth` now verifies the raw `id_token` with
  `verifyOrgIdToken` — the same verifier the agent-facing
  `POST /v1/principals/link-identities` path already used. It pins RS256/ES256,
  discovers the JWKS from the issuer, checks `iss`, and applies the
  pairwise-over-global subject precedence.
- An exchange that returns no `id_token` is refused rather than treated as an
  anonymous success.
- `openid-client` continues to check `aud`, `nonce` and `exp`, which
  `verifyOrgIdToken` does not; together they cover the whole claim set.
- Both surfaces now share one definition of "verified upstream identity".

The reuse is the point: the browser leg (`apps/pages/src/lib/federation.ts`)
and the link-identities route already verified signatures. Only the new
server-side leg did not, because it inherited a library default that assumes a
property this deployment does not always have.

## Verification

A chaos suite injects one fault per case into an otherwise-working broker and
asserts the interaction does not complete and no session cookie is issued:

```bash
pnpm --filter @opensesame/control-plane exec vitest run \
  src/__tests__/federated-leg.chaos.test.ts
```

Cases: discovery 500 / non-JSON, token endpoint 500 / non-JSON, wrong issuer,
wrong audience, wrong nonce, expired, **signed by an unpublished key**,
**`alg: none`**, no subject, and a replayed callback. The unpublished-key and
`alg: none` cases fail against the pre-fix code and pass after it.

A structural PACT test pins the ordering so the verify cannot be dropped or
reordered by a later refactor:

```bash
pnpm --filter @opensesame/control-plane exec vitest run \
  src/__tests__/federated-leg.pact.test.ts
```
